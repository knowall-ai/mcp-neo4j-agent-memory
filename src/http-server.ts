/**
 * `reverie serve`: the same MCP server over Streamable HTTP at /mcp, plus the read-only Brain API
 * (/brain/graph, /brain/state, /brain/events as Server-Sent Events) the Agents Portal's Brain tab
 * uses. One bearer token (REVERIE_SERVE_TOKEN) protects everything except the health check.
 * Plain node:http: nothing here needs a framework.
 */
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { BrainSnapshot, clampLimit, diffSnapshot, isEmptyDiff, snapshot, state } from './brain.js';
import { neo4jConfigError, neo4jConfigFromEnv } from './config.js';
import { Embedder } from './embeddings.js';
import { eventsPath, readSince, tail } from './events.js';
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

interface Settings {
  token: string;
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
  const port = Number.parseInt(env.REVERIE_HTTP_PORT?.trim() || '8643', 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`REVERIE_HTTP_PORT must be a port number, got ${env.REVERIE_HTTP_PORT}`);
  }
  const seconds = (variable: string, fallback: number) => {
    const parsed = Number.parseFloat(env[variable]?.trim() || '');
    return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : fallback * 1000;
  };
  return {
    token,
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

  async function neo4jHealthy(): Promise<boolean> {
    if (!neo4j) {
      return false;
    }
    try {
      await neo4j.executeQuery('RETURN 1 AS ok');
      return true;
    } catch {
      return false;
    }
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
    const send = (event: string, data: unknown) => {
      if (!res.writableEnded) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };
    const file = eventsPath(env);
    let offset = 0;
    if (file) {
      // Recent history first so the view can light up what just happened
      for (const event of tail(file, 30)) {
        send('activation', event);
      }
      offset = readSince(file, 0).offset;
    }
    let prev: BrainSnapshot | null = null;
    let polling = false;
    const pollGraph = async () => {
      if (polling || !run) {
        return;
      }
      polling = true;
      try {
        const curr = await snapshot(run, limit);
        if (prev) {
          const diff = diffSnapshot(prev, curr);
          if (!isEmptyDiff(diff)) {
            send('graph', { ...diff, stats: curr.stats });
          }
        }
        prev = curr;
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
        const next = readSince(file, offset);
        offset = next.offset;
        for (const event of next.events) {
          send('activation', event);
        }
      }, settings.eventPollMs),
      setInterval(() => void pollGraph(), settings.graphPollMs),
      setInterval(() => send('state', state(undefined, undefined, env)), settings.statePollMs),
      setInterval(() => {
        if (!res.writableEnded) {
          res.write(': ping\n\n');
        }
      }, PING_SECONDS * 1000)
    );
  }

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';

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
      if (!run) {
        sendJson(res, 503, { error: 'Neo4j not configured' });
        return;
      }
      const limit = clampLimit(url.searchParams.get('limit'));
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
