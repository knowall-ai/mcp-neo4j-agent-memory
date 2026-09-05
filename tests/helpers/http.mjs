// Helpers for driving `reverie serve` in tests: spawn it on an ephemeral port, speak MCP over
// Streamable HTTP (JSON mode), and read Server-Sent Events until a condition holds.
import { spawn } from 'node:child_process';
import { SERVER_ENTRY } from './mcp-client.mjs';

/** Start `reverie serve` on port 0 and resolve with { child, port, url, stderr(), close() }. */
export function startServe(env = {}, { timeoutMs = 15000 } = {}) {
  const child = spawn('node', [SERVER_ENTRY, 'serve'], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, REVERIE_HTTP_PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  const exited = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`serve did not start within ${timeoutMs}ms\n${stderr}`)); }, timeoutMs);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      const match = /listening on http:\/\/[^:]+:(\d+)/.exec(stderr);
      if (match) {
        clearTimeout(timer);
        const port = Number(match[1]);
        resolve({
          child,
          port,
          url: `http://127.0.0.1:${port}`,
          stderr: () => stderr,
          exited,
          async close() { child.kill('SIGTERM'); return exited; }
        });
      }
    });
    child.once('close', (code) => { clearTimeout(timer); reject(new Error(`serve exited early (code ${code})\n${stderr}`)); });
  });
}

/** Run a command that should exit on its own (e.g. a misconfiguration) and capture the result. */
export function runServe(env = {}, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('node', [SERVER_ENTRY, 'serve'], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill(); }, timeoutMs);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, killed, stderr }); });
  });
}

let nextId = 1;

/** One JSON-RPC request over Streamable HTTP in JSON-response mode; returns the parsed response. */
export async function mcpRequest(url, token, method, params = {}) {
  const response = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params })
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

/** Call a tool over HTTP. Same shape as McpClient.call: { ok, data } or { ok: false, error }. */
export async function mcpCall(url, token, name, args = {}) {
  const { status, body } = await mcpRequest(url, token, 'tools/call', { name, arguments: args });
  if (status !== 200 || !body || typeof body !== 'object') return { ok: false, error: `HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}` };
  if (body.error) return { ok: false, error: body.error.message ?? JSON.stringify(body.error) };
  const text = body.result?.content?.[0]?.text ?? '';
  if (body.result?.isError) return { ok: false, error: text };
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { ok: true, data };
}

/**
 * Open /brain/events and collect events ({ event, data }) until `until(events)` is true or the
 * timeout passes. Always resolves with what was collected; the caller asserts.
 */
export async function readSse(url, token, { until, timeoutMs = 10000, limit = 400 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const events = [];
  try {
    const response = await fetch(`${url}/brain/events?limit=${limit}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
      signal: controller.signal
    });
    if (!response.ok || !response.body) return { status: response.status, events };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (event && data) {
          try { events.push({ event, data: JSON.parse(data) }); } catch { events.push({ event, data }); }
        }
      }
      if (until && until(events)) {
        controller.abort();
        break;
      }
    }
    return { status: response.status, events };
  } catch (error) {
    if (error.name !== 'AbortError') throw error;
    return { status: 200, events };
  } finally {
    clearTimeout(timer);
  }
}
