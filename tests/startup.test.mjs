// Server startup without a database: it must refuse to start with a clear message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { SERVER_ENTRY } from './helpers/mcp-client.mjs';

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
