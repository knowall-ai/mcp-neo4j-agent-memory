// End-to-end tests against a live Neo4j (NEO4J_URI/USERNAME/PASSWORD). Each test file gets a
// wiped database. Runs the built server over stdio exactly as an MCP client would.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import neo4j from 'neo4j-driver';
import { McpClient } from './helpers/mcp-client.mjs';

const uri = process.env.NEO4J_URI ?? 'bolt://127.0.0.1:7687';
const user = process.env.NEO4J_USERNAME ?? 'neo4j';
const password = process.env.NEO4J_PASSWORD;
if (!password) {
  throw new Error('NEO4J_PASSWORD is required for the integration tests');
}
// This suite wipes the database it points at. It refuses to run without an explicit opt-in so a
// developer's real graph can never be erased by `npm test`.
if (process.env.REVERIE_TEST_DESTRUCTIVE !== '1') {
  throw new Error('Refusing to run: the integration tests wipe the target database. Point NEO4J_URI at a disposable Neo4j and set REVERIE_TEST_DESTRUCTIVE=1.');
}
// Credentials only travel in the clear to loopback; anything remote must use an encrypted scheme
// with certificate validation (`+ssc` trusts any certificate, so it is refused too).
{
  const parsed = new URL(uri);
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname);
  if (!loopback && !/^(bolt|neo4j)\+s:$/.test(parsed.protocol)) {
    throw new Error(`NEO4J_URI ${uri} is remote; use bolt+s:// or neo4j+s:// (validated certificates only)`);
  }
}

const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
async function cypher(query, params = {}) {
  const session = driver.session();
  try { return (await session.run(query, params)).records.map((r) => r.toObject()); }
  finally { await session.close(); }
}
async function wipe() { await cypher('MATCH (n) DETACH DELETE n'); }

/** Bounded readiness: authenticated Bolt must answer within ~60s or the suite fails fast. */
async function waitForBolt(deadlineMs = 60000) {
  const started = Date.now();
  for (;;) {
    try { await driver.verifyConnectivity(); return; }
    catch (error) {
      if (Date.now() - started > deadlineMs) throw new Error(`Neo4j at ${uri} not ready after ${deadlineMs / 1000}s: ${error.message}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

let mcp;
before(async () => {
  await waitForBolt();
  await wipe();
  mcp = new McpClient({
    NEO4J_URI: uri, NEO4J_USERNAME: user, NEO4J_PASSWORD: password,
    REVERIE_EMBEDDINGS: process.env.REVERIE_EMBEDDINGS ?? 'local',
    REVERIE_MAX_PROPERTIES: '6'
  });
});
after(async () => {
  await mcp.close();
  await wipe();
  await driver.close();
});

const ok = async (name, args) => {
  const r = await mcp.call(name, args);
  assert.ok(r.ok, `${name} failed: ${r.error}`);
  return r.data;
};
const fails = async (name, args, pattern) => {
  const r = await mcp.call(name, args);
  assert.equal(r.ok, false, `${name} unexpectedly succeeded`);
  if (pattern) assert.match(r.error, pattern);
  return r.error;
};

test('lists the twelve tools', async () => {
  const names = (await mcp.listTools()).map((t) => t.name).sort();
  assert.deepEqual(names, [
    'create_connection', 'create_memory', 'delete_connection', 'delete_memory', 'dream', 'get_guidance',
    'list_memory_labels', 'memory_stats', 'query_memories', 'search_memories', 'update_connection', 'update_memory'
  ]);
});

const ids = {};

test('create_memory stamps created_at and returns the node', async () => {
  const r = await ok('create_memory', { label: 'person', properties: { name: 'Benjamin Weeks', email: 'ben@example.com', role: 'Founder' } });
  assert.equal(r.memory.name, 'Benjamin Weeks');
  assert.match(r.memory.created_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof r.memory._id, 'number');
  assert.equal(r.memory.embedding, undefined, 'embedding fields are never returned');
  ids.ben = r.memory._id;
  ids.org = (await ok('create_memory', { label: 'organization', properties: { name: 'KnowAll AI' } })).memory._id;
  ids.place = (await ok('create_memory', { label: 'place', properties: { name: 'Belfast' } })).memory._id;
});

test('create_memory rejects injection in the label and malformed arguments', async () => {
  await fails('create_memory', { label: 'person) DETACH DELETE n //', properties: { name: 'x' } }, /Invalid create_memory/);
  await fails('create_memory', { label: 'person', properties: [] }, /Invalid create_memory/);
  await fails('create_memory', { label: 'person', properties: {}, extra: 1 }, /Invalid create_memory/);
  assert.equal((await cypher('MATCH (n) RETURN count(n) AS c'))[0].c.toNumber(), 3, 'nothing was deleted');
});

test('create_connection links nodes and rejects a bad relationship type', async () => {
  const r = await ok('create_connection', { fromMemoryId: ids.ben, toMemoryId: ids.org, type: 'WORKS_AT', properties: { role: 'Founder' } });
  assert.equal(r.relationship._type, 'WORKS_AT');
  await ok('create_connection', { fromMemoryId: ids.ben, toMemoryId: ids.place, type: 'LIVES_IN' });
  await fails('create_connection', { fromMemoryId: ids.ben, toMemoryId: ids.org, type: 'X]->() DETACH DELETE' }, /Invalid create_connection/);
});

test('keyword search matches any word, ignores timestamps, and honours label case-insensitively', async () => {
  const hits = await ok('search_memories', { query: 'Weeks', search_mode: 'keyword', depth: 0 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].memory._match, 'keyword');
  assert.equal(hits[0].memory._score, 1);
  const byLabel = await ok('search_memories', { query: '', label: 'PERSON', depth: 0 });
  assert.equal(byLabel.length, 1);
  const year = new Date().getUTCFullYear().toString();
  const none = await ok('search_memories', { query: year, search_mode: 'keyword', depth: 0 });
  assert.equal(none.length, 0, 'created_at must not be searchable');
});

test('exact search matches only equality on name, alias or email, case-insensitively', async () => {
  const hits = await ok('search_memories', { query: 'benjamin weeks', search_mode: 'exact', depth: 0 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].memory._match, 'exact');
  const byEmail = await ok('search_memories', { query: 'BEN@example.com', search_mode: 'exact', depth: 0 });
  assert.equal(byEmail.length, 1);
  const partial = await ok('search_memories', { query: 'Benjamin', search_mode: 'exact', depth: 0 });
  assert.equal(partial.length, 0, 'a partial name is not an exact match');
});

test('archived memories are hidden from search and label listing unless asked for', async () => {
  const id = (await ok('create_memory', { label: 'person', properties: { name: 'Old Contact', status: 'archived' } })).memory._id;
  assert.equal((await ok('search_memories', { query: 'Old Contact', search_mode: 'keyword', depth: 0 })).length, 0);
  assert.equal((await ok('search_memories', { query: 'Old Contact', search_mode: 'keyword', depth: 0, include_archived: true })).length, 1);
  const labels = (await ok('list_memory_labels', {}))[0].labels.find((l) => l.label === 'person');
  assert.equal(labels.count, 1, 'archived node not counted');
  const all = (await ok('list_memory_labels', { include_archived: true }))[0].labels.find((l) => l.label === 'person');
  assert.equal(all.count, 2);
  await fails('list_memory_labels', { verbose: true }, /Invalid list_memory_labels/);
  await ok('delete_memory', { nodeId: id });
});

test('semantic search finds Benjamin from "Ben" and reports the semantic match', async () => {
  const hits = await ok('search_memories', { query: 'Ben Weeks', search_mode: 'semantic', depth: 0, similarity_threshold: 0.3 }, 120000);
  const hit = hits.find((h) => h.memory._id === ids.ben);
  assert.ok(hit, 'expected the Benjamin Weeks node');
  assert.equal(hit.memory._match, 'semantic');
  assert.ok(hit.memory._score > 0.3);
});

test('search returns connections at depth 1 and validates arguments', async () => {
  const hits = await ok('search_memories', { query: 'Benjamin', depth: 1 });
  const types = hits[0].connections.map((c) => c.relationship._type).sort();
  assert.deepEqual(types, ['LIVES_IN', 'WORKS_AT']);
  const worksAt = hits[0].connections.find((c) => c.relationship._type === 'WORKS_AT').relationship;
  assert.equal(worksAt._start, ids.ben, 'relationship direction is recoverable');
  assert.equal(worksAt._end, ids.org);
  await fails('search_memories', { query: 'x', limit: -1 }, /Invalid search_memories/);
  await fails('search_memories', { query: 'x', depth: 9 }, /Invalid search_memories/);
  await fails('search_memories', { query: 'x', search_mod: 'semantic' }, /Invalid search_memories/);
});

test('update_memory merges properties and warns once a node is bloated', async () => {
  const r = await ok('update_memory', { nodeId: ids.ben, properties: { phone: '123' } });
  assert.equal(r.memory.phone, '123');
  assert.equal(r.memory._hint, undefined);
  const bloated = await ok('update_memory', { nodeId: ids.ben, properties: { a_2026_01_01: 'x', b: 'y', c: 'z', d: 'w' } });
  assert.match(bloated.memory._hint, /properties \(limit 6\)/);
});

test('query_memories is read-only, bounded, and serialises temporal values', async () => {
  // labels are still lowercase here: dream (below) canonicalises them
  const rows = await ok('query_memories', { cypher: 'MATCH (n:person) RETURN n.name AS name' });
  assert.deepEqual(rows, [{ name: 'Benjamin Weeks' }]);
  await fails('query_memories', { cypher: 'MATCH (n) DETACH DELETE n' }, /read-only/);
  await fails('query_memories', { cypher: "CALL /* hidden */ apoc.create.node(['X'], {}) YIELD node RETURN node" }, /read-only/);
  await fails('query_memories', { cypher: 'CALL { MATCH (n) RETURN n } RETURN 1' }, /read-only/);
  const many = await ok('query_memories', { cypher: 'UNWIND range(1, 5000) AS i RETURN i' });
  assert.equal(many.length, 200);
  const temporal = await ok('query_memories', { cypher: 'RETURN datetime("2026-09-04T10:00:00Z") AS at' });
  assert.equal(temporal[0].at, '2026-09-04T10:00:00Z');
  assert.equal((await cypher('MATCH (n) RETURN count(n) AS c'))[0].c.toNumber(), 3, 'nothing was deleted');
});

test('memory_stats reports counts, embedder and orphans', async () => {
  const s = await ok('memory_stats', {});
  assert.equal(s.nodes, 3);
  assert.equal(s.relationships, 2);
  assert.equal(s.orphans, 0);
  assert.ok(s.embedder === null || typeof s.embedder === 'string');
});

test('dream relabels, merges true duplicates, skips identity conflicts, and flags bloat', async () => {
  const keep = (await ok('create_memory', { label: 'organization', properties: { name: 'Acme' } })).memory._id;
  await ok('create_memory', { label: 'organization', properties: { name: 'acme', email: 'a@x.com', website: 'acme.com' } });
  await ok('create_memory', { label: 'organization', properties: { name: 'ACME', email: 'b@y.com' } });

  const dry = await ok('dream', { dry_run: true }, 120000);
  assert.equal(dry.dry_run, true);
  assert.ok(dry.relabelled >= 3, 'lowercase labels are counted');
  const group = dry.duplicates.find((d) => d.name.toLowerCase() === 'acme');
  assert.ok(group);
  assert.equal(group.keep, keep);
  assert.equal(group.merged.length, 1);
  assert.deepEqual(group.skipped.map((s) => s.reason), ['different email']);
  assert.ok(dry.bloated.some((b) => b.name === 'Benjamin Weeks' && b.fact_like_keys.includes('a_2026_01_01')));
  assert.equal((await cypher('MATCH (n:organization) RETURN count(n) AS c'))[0].c.toNumber(), 4, 'dry run wrote nothing (KnowAll + three Acmes)');

  const real = await ok('dream', {}, 120000);
  assert.equal(real.merged, 1);
  assert.equal(real.apoc_available, true);
  const orgs = await cypher('MATCH (n:Organization) RETURN n.name AS name, n.email AS email ORDER BY name');
  assert.equal(orgs.length, 3, 'KnowAll, Acme survivor, and the conflicting ACME');
  const survivor = orgs.find((o) => o.name === 'Acme');
  assert.equal(survivor.email, 'a@x.com', 'survivor absorbed the merged email');
  assert.equal((await cypher('MATCH (n:organization) RETURN count(n) AS c'))[0].c.toNumber(), 0, 'lowercase label gone');
  const stale = (await cypher("MATCH (n) WHERE n.embedding_model IS NULL AND coalesce(n.status,'') <> 'archived' RETURN count(n) AS c"))[0].c.toNumber();
  assert.equal(stale, 0, 'relabelled nodes were re-embedded in the same dream');
  const s = await ok('memory_stats', {});
  if (s.embedder) assert.equal(s.embedded, s.nodes, 'dream re-embedded everything');
});

test('delete_connection and delete_memory clean up', async () => {
  await ok('delete_connection', { fromMemoryId: ids.ben, toMemoryId: ids.place, type: 'LIVES_IN' });
  await ok('delete_memory', { nodeId: ids.place });
  await fails('delete_memory', { nodeId: -1 }, /Invalid delete_memory/);
  assert.equal((await cypher('MATCH (n:Place) RETURN count(n) AS c'))[0].c.toNumber(), 0);
});

test('list_memory_labels and get_guidance', async () => {
  const labels = await ok('list_memory_labels', {});
  assert.ok(labels[0].labels.some((l) => l.label === 'Person'));
  const all = await ok('get_guidance', {});
  assert.match(all, /What belongs in the graph/);
  assert.match(await ok('get_guidance', { topic: 'best-practices' }), /ALWAYS SEARCH FIRST/);
  assert.match(await ok('get_guidance', { topic: 'nonsense' }), /Unknown topic/);
});
