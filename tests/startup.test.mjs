// Server startup without a database: it must refuse to start with a clear message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { SERVER_ENTRY } from './helpers/mcp-client.mjs';
import { mcpRequest, runServe, startServe } from './helpers/http.mjs';

function run(env) {
  return new Promise((resolve) => {
    const child = spawn('node', [SERVER_ENTRY], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill(); }, 5000);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, killed, stderr }); });
  });
}

test('refuses to start when NEO4J_PASSWORD is missing', async () => {
  const { code, killed, stderr } = await run({ NEO4J_URI: 'bolt://localhost:7687', NEO4J_USERNAME: 'neo4j' });
  assert.equal(killed, false, 'server kept running instead of refusing to start');
  assert.ok(Number.isInteger(code) && code !== 0, `expected a non-zero exit, got ${code}`);
  assert.match(stderr, /NEO4J_PASSWORD/);
});

test('refuses to start when NEO4J_URI is missing', async () => {
  const { code, killed, stderr } = await run({ NEO4J_USERNAME: 'neo4j', NEO4J_PASSWORD: 'x' });
  assert.equal(killed, false, 'server kept running instead of refusing to start');
  assert.ok(Number.isInteger(code) && code !== 0, `expected a non-zero exit, got ${code}`);
  assert.match(stderr, /NEO4J_URI/);
});

test('unknown arguments print usage and exit 2', async () => {
  const { code, stderr } = await new Promise((resolve) => {
    const child = spawn('node', [SERVER_ENTRY, 'bogus'], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (c) => resolve({ code: c, stderr: err }));
  });
  assert.equal(code, 2);
  assert.match(stderr, /Usage: reverie \[serve\]/);
});

test('serve refuses to start without REVERIE_SERVE_TOKEN', async () => {
  const { code, killed, stderr } = await runServe({});
  assert.equal(killed, false);
  assert.equal(code, 1);
  assert.match(stderr, /REVERIE_SERVE_TOKEN is required/);
});

test('serve refuses a partial Neo4j configuration', async () => {
  const { code, stderr } = await runServe({ REVERIE_SERVE_TOKEN: 't', NEO4J_URI: 'bolt://localhost:7687' });
  assert.equal(code, 1);
  assert.match(stderr, /NEO4J_PASSWORD/);
});

test('serve without Neo4j: health, auth, 404, 503 and MCP over HTTP', async () => {
  const token = 'test-token-123';
  const serve = await startServe({ REVERIE_SERVE_TOKEN: token, REVERIE_EVENTS_PATH: '' });
  try {
    const health = await fetch(`${serve.url}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json().then((b) => [b.ok, b.neo4j]), [true, false]);
    assert.equal((await fetch(`${serve.url}/brain/health`)).status, 200, 'brain health alias');

    assert.equal((await fetch(`${serve.url}/brain/graph`)).status, 401, 'no bearer');
    assert.equal((await fetch(`${serve.url}/brain/graph`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    const graph = await fetch(`${serve.url}/brain/graph`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(graph.status, 503, 'Neo4j not configured');
    assert.equal((await fetch(`${serve.url}/brain/events`, { headers: { Authorization: `Bearer ${token}` } })).status, 503);
    assert.equal((await fetch(`${serve.url}/brain/state`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status, 405);
    assert.equal((await fetch(`${serve.url}/nope`, { headers: { Authorization: `Bearer ${token}` } })).status, 404);

    assert.equal((await mcpRequest(serve.url, undefined, 'tools/list')).status, 401, 'mcp needs the bearer too');
    const listed = await mcpRequest(serve.url, token, 'tools/list');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.result.tools.length, 12);
    const called = await mcpRequest(serve.url, token, 'tools/call', { name: 'memory_stats', arguments: {} });
    assert.equal(called.body.result.isError, true, 'tools answer with the not-configured error, not a crash');
    const bad = await fetch(`${serve.url}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{nope' });
    assert.equal(bad.status, 400);
    const huge = await fetch(`${serve.url}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: `{"pad":"${'x'.repeat(1024 * 1024 + 10)}"}` });
    assert.equal(huge.status, 413);
    assert.equal((await fetch(`${serve.url}/mcp`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` } })).status, 405);
  } finally {
    const { signal, code } = await serve.close();
    assert.ok(signal === 'SIGTERM' || code === 0, 'shuts down on SIGTERM');
  }
});
