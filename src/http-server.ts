/**
 * `reverie serve`: the same MCP server over Streamable HTTP at /mcp, plus the read-only Brain API
 * (/brain/graph, /brain/state, /brain/events as Server-Sent Events) the Agents Portal's Brain tab
 * uses. One bearer token (REVERIE_SERVE_TOKEN) protects everything except the health check.
 * Plain node:http: nothing here needs a framework.
 */
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { BrainSnapshot, diffSnapshot, isEmptyDiff, parseLimit, snapshot, snapshotAsDiff, state } from './brain.js';
import { neo4jConfigError, neo4jConfigFromEnv } from './config.js';
import { Embedder } from './embeddings.js';
import { ActivationEvent, LogCursor, START_CURSOR, eventsPath, readSince } from './events.js';
import { Neo4jClient } from './neo4j-client.js';
import { createMcpServer, safeCreateEmbedder } from './server.js';

export class ConfigError extends Error {}

export interface HttpServerHandle {
  server: http.Server;
  host: string;
  port: number;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 1024 * 1024;
const PING_SECONDS = 15;
const SHUTDOWN_GRACE_MS = 10_000;
const HEALTH_CACHE_MS = 5_000;
const HEALTH_TIMEOUT_MS = 5_000;
const BACKPRESSURE_GRACE_MS = 30_000;
const PENDING_ACTIVATIONS_MAX = 1000;

interface Settings {
  token: string;
  allowedOrigins: Set<string>;
  host: string;
  port: number;
  graphPollMs: number;
  statePollMs: number;
  eventPollMs: number;
}

function settingsFromEnv(env: NodeJS.ProcessEnv): Settings {
  const token = env.REVERIE_SERVE_TOKEN?.trim();
  if (!token) {
    throw new ConfigError('REVERIE_SERVE_TOKEN is required for reverie serve');
  }
  const rawPort = env.REVERIE_HTTP_PORT?.trim() || '8643';
  const port = /^\d{1,5}$/.test(rawPort) ? Number.parseInt(rawPort, 10) : Number.NaN;
  if (!Number.isInteger(port) || port > 65535) {
    throw new ConfigError(`REVERIE_HTTP_PORT must be a port number, got ${env.REVERIE_HTTP_PORT}`);
  }
  const seconds = (variable: string, fallback: number) => {
    const parsed = Number.parseFloat(env[variable]?.trim() || '');
    return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : fallback * 1000;
  };
  return {
    token,
    // Streamable HTTP requires Origin validation. Non-browser clients send no Origin; a browser
    // origin is accepted only when listed in REVERIE_ALLOWED_ORIGINS (comma-separated).
    allowedOrigins: new Set((env.REVERIE_ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim().toLowerCase()).filter(Boolean)),
    host: env.REVERIE_HTTP_HOST?.trim() || '127.0.0.1',
    port,
    graphPollMs: seconds('REVERIE_GRAPH_POLL_SECONDS', 5),
    statePollMs: seconds('REVERIE_STATE_SECONDS', 5),
    eventPollMs: seconds('REVERIE_EVENT_POLL_SECONDS', 1)
  };
}

/** Constant-time bearer check; a wrong length is a plain mismatch, never a timing tell. */
export function isAuthorized(header: string | undefined, token: string): boolean {
  if (!header || !token) {
    return false;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) {
    return false;
  }
  const given = Buffer.from(match[1], 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

class BodyTooLarge extends Error {}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (tooLarge) {
        return;
      }
      if (size > MAX_BODY_BYTES) {
        // Keep draining so the client receives the 413 instead of a connection reset.
        tooLarge = true;
        chunks = [];
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new BodyTooLarge('request body exceeds 1 MiB'));
        return;
      }
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(new SyntaxError(`invalid JSON body: ${error instanceof Error ? error.message : error}`));
      }
    });
    req.on('error', reject);
    // A client abort can close the request without 'end' or 'error'; do not leave the handler pending.
    req.on('close', () => {
      if (!req.readableEnded) {
        reject(new Error('request closed before the body was received'));
      }
    });
  });
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

export async function startHttpServer(env: NodeJS.ProcessEnv = process.env): Promise<HttpServerHandle> {
  const settings = settingsFromEnv(env);
  const configError = neo4jConfigError(env);
  if (configError) {
    throw new ConfigError(configError);
  }
  const config = neo4jConfigFromEnv(env);
  const neo4j = config ? new Neo4jClient(config.uri, config.username, config.password, config.database) : null;
  const embedder: Embedder | null = config ? safeCreateEmbedder() : null;
  const run = neo4j ? (cypher: string, params?: Record<string, unknown>) => neo4j.executeQuery(cypher, params ?? {}) : null;

  // The health probe is unauthenticated, so it is cached and coalesced: one Neo4j query in flight
  // at a time, tracked until it really settles (a timed-out answer does not release it), and its
  // result cached for HEALTH_CACHE_MS. Callers wait at most HEALTH_TIMEOUT_MS and get false meanwhile.
  let healthCache: { at: number; ok: boolean } | null = null;
  let healthQuery: Promise<boolean> | null = null;
  function neo4jHealthy(): Promise<boolean> {
    if (!neo4j) {
      return Promise.resolve(false);
    }
    if (healthCache && Date.now() - healthCache.at < HEALTH_CACHE_MS) {
      return Promise.resolve(healthCache.ok);
    }
    if (!healthQuery) {
      healthQuery = neo4j
        .executeQuery('RETURN 1 AS ok')
        .then(() => true, () => false)
        .then((ok) => {
          healthCache = { at: Date.now(), ok };
          healthQuery = null;
          return ok;
        });
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), HEALTH_TIMEOUT_MS);
      timer.unref();
    });
    return Promise.race([healthQuery, timeout]).finally(() => clearTimeout(timer));
  }

  async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: unknown;
    if (req.method === 'POST') {
      try {
        body = await readJsonBody(req);
      } catch (error) {
        if (error instanceof BodyTooLarge) {
          sendJson(res, 413, { error: error.message });
        } else {
          sendJson(res, 400, { error: errorMessage(error) });
        }
        return;
      }
    }
    // Stateless: a fresh protocol server and transport per request, sharing the Neo4j client and embedder.
    const server = createMcpServer(neo4j, embedder);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  function streamEvents(req: http.IncomingMessage, res: http.ServerResponse, limit: number): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    // Backpressure: when the client stops reading, stop producing. Activations wait in a bounded
    // queue and the graph baseline only advances once its frame was handed to the socket, so
    // nothing is silently lost; a connection that has not drained in BACKPRESSURE_GRACE_MS is dropped.
    let blocked = false;
    let blockedSince = 0;
    const pending: ActivationEvent[] = [];
    const write = (chunk: string): boolean => {
      if (blocked || res.writableEnded) {
        return false;
      }
      if (!res.write(chunk)) {
        blocked = true;
        blockedSince = Date.now();
        res.once('drain', () => {
          blocked = false;
          flushPending();
        });
      }
      return true;
    };
    const send = (event: string, data: unknown): boolean => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const flushPending = () => {
      while (pending.length > 0 && !blocked && !res.writableEnded) {
        send('activation', pending.shift());
      }
    };
    const queueActivations = (events: ActivationEvent[]) => {
      pending.push(...events);
      flushPending(); // deliver what the socket will take before any cap applies
      if (pending.length > PENDING_ACTIVATIONS_MAX) {
        // A client that has not read for this long loses the oldest queued activations; say so.
        const dropped = pending.splice(0, pending.length - PENDING_ACTIVATIONS_MAX).length;
        pending.unshift({ ts: Date.now() / 1000, kind: 'gap', dropped });
      }
    };
    const file = eventsPath(env);
    let cursor: LogCursor = START_CURSOR;
    if (file) {
      // One read gives both the recent history to replay and the cursor to continue from, so no
      // event can fall between the two.
      const initial = readSince(file, START_CURSOR);
      cursor = initial.cursor;
      queueActivations(initial.events.slice(-30));
    }
    let prev: BrainSnapshot | null = null;
    let polling = false;
    const pollGraph = async () => {
      if (polling || blocked || !run) {
        return;
      }
      polling = true;
      try {
        const curr = await snapshot(run, limit);
        // The first frame is the full snapshot, so the stream never depends on what the client
        // fetched from /brain/graph moments earlier.
        const diff = prev ? diffSnapshot(prev, curr) : snapshotAsDiff(curr);
        if (isEmptyDiff(diff) || send('graph', { ...diff, stats: curr.stats })) {
          prev = curr;
        }
      } catch (error) {
        send('error', { message: errorMessage(error) });
      } finally {
        polling = false;
      }
    };
    const timers: NodeJS.Timeout[] = [];
    const stop = () => {
      for (const timer of timers) {
        clearInterval(timer);
      }
      if (!res.writableEnded) {
        res.end();
      }
    };
    req.on('close', stop);
    res.on('error', stop);
    pollGraph().then(() => send('state', state(undefined, undefined, env)));
    timers.push(
      setInterval(() => {
        if (!file) {
          return;
        }
        const next = readSince(file, cursor);
        cursor = next.cursor;
        queueActivations(next.events);
      }, settings.eventPollMs),
      setInterval(() => void pollGraph(), settings.graphPollMs),
      setInterval(() => send('state', state(undefined, undefined, env)), settings.statePollMs),
      setInterval(() => {
        if (blocked && Date.now() - blockedSince > BACKPRESSURE_GRACE_MS) {
          stop();
          res.destroy();
          return;
        }
        write(': ping\n\n');
      }, PING_SECONDS * 1000)
    );
  }

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';

    // Browser callers: an Origin is accepted only when allowlisted, and then gets real CORS
    // answers (preflight before auth, since browsers send preflights without credentials).
    const origin = req.headers.origin?.trim();
    const originAllowed = origin !== undefined && settings.allowedOrigins.has(origin.toLowerCase());
    if (origin !== undefined && !originAllowed) {
      sendJson(res, 403, { error: 'Origin not allowed' });
      return;
    }
    if (originAllowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version',
          'Access-Control-Max-Age': '600'
        });
        res.end();
        return;
      }
    }
    if ((path === '/health' || path === '/brain/health') && method === 'GET') {
      sendJson(res, 200, { ok: true, neo4j: await neo4jHealthy(), ts: Date.now() / 1000 });
      return;
    }
    if (!isAuthorized(req.headers.authorization, settings.token)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }
    if (path === '/mcp') {
      if (method !== 'POST' && method !== 'GET' && method !== 'DELETE') {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }
      await handleMcp(req, res);
      return;
    }
    if (path.startsWith('/brain/')) {
      if (method !== 'GET') {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }
      const limit = parseLimit(url.searchParams.get('limit'));
      if (limit === null) {
        sendJson(res, 400, { error: 'limit must be an integer between 1 and 1500' });
        return;
      }
      if (!run) {
        sendJson(res, 503, { error: 'Neo4j not configured' });
        return;
      }
      if (path === '/brain/graph') {
        try {
          const snap = await snapshot(run, limit);
          sendJson(res, 200, { ...snap, state: state(undefined, undefined, env) });
        } catch (error) {
          sendJson(res, 502, { error: errorMessage(error) });
        }
        return;
      }
      if (path === '/brain/state') {
        sendJson(res, 200, state(undefined, undefined, env));
        return;
      }
      if (path === '/brain/events') {
        streamEvents(req, res, limit);
        return;
      }
    }
    sendJson(res, 404, { error: 'Not found' });
  }

  const server = http.createServer((req, res) => {
    const started = Date.now();
    res.on('finish', () => console.error(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`));
    route(req, res).catch((error) => {
      console.error('Request failed:', error);
      if (!res.headersSent) {
        sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: errorMessage(error) }, id: null });
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(settings.port, settings.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : settings.port;
  console.error(`Reverie HTTP server listening on http://${settings.host}:${port}`);

  let closing: Promise<void> | null = null;
  const close = () => {
    if (!closing) {
      closing = new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }).then(() => neo4j?.close());
    }
    return closing;
  };
  return { server, host: settings.host, port, close };
}

/** Wire SIGINT/SIGTERM to a bounded shutdown; used by the `reverie serve` entry point. */
export function installShutdown(handle: HttpServerHandle): void {
  const shutdown = () => {
    console.error('Shutting down Reverie HTTP server…');
    const force = setTimeout(() => {
      console.error('Forced shutdown');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    force.unref();
    handle
      .close()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error('Error during shutdown:', error);
        process.exit(1);
      });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
