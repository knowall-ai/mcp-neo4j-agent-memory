// Minimal stdio JSON-RPC client for driving the built server in tests.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const SERVER_ENTRY = join(here, '..', '..', 'build', 'index.js');

export class McpClient {
  constructor(env = {}) {
    this.child = spawn('node', [SERVER_ENTRY], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.buffer = '';
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk.toString(); });
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.exited = new Promise((resolve) => this.child.once('close', resolve));
  }

  onData(chunk) {
    this.buffer += chunk.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const waiter = this.pending.get(message.id);
      if (waiter) {
        this.pending.delete(message.id);
        waiter.resolve(message);
      }
    }
  }

  request(method, params, timeoutMs = 60000) {
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method} (${id})`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); } });
      this.child.stdin.write(JSON.stringify(message) + '\n');
    });
  }

  /** Call a tool. Returns { ok: true, data } with the parsed JSON text, or { ok: false, error } with the message. */
  async call(name, args = {}, timeoutMs) {
    const response = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    if (response.error) {
      return { ok: false, error: response.error.message ?? JSON.stringify(response.error) };
    }
    const text = response.result?.content?.[0]?.text ?? '';
    if (response.result?.isError) {
      return { ok: false, error: text };
    }
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { ok: true, data };
  }

  async listTools() {
    const response = await this.request('tools/list', {});
    return response.result?.tools ?? [];
  }

  async close() {
    this.child.stdin.end();
    this.child.kill();
    await this.exited;
  }
}
