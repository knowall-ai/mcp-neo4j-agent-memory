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
    const timer = setTimeout(() => child.kill(), 5000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}

test('refuses to start when NEO4J_PASSWORD is missing', async () => {
  const { code, stderr } = await run({ NEO4J_URI: 'bolt://localhost:7687', NEO4J_USERNAME: 'neo4j' });
  assert.notEqual(code, 0);
  assert.match(stderr, /NEO4J_PASSWORD/);
});

test('refuses to start when NEO4J_URI is missing', async () => {
  const { code, stderr } = await run({ NEO4J_USERNAME: 'neo4j', NEO4J_PASSWORD: 'x' });
  assert.notEqual(code, 0);
  assert.match(stderr, /NEO4J_URI/);
});
