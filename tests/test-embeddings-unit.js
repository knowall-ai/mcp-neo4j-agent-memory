#!/usr/bin/env node

import assert from 'assert';
import { cosine, createEmbedder, embeddingText, nameText, scrub } from '../build/embeddings.js';
import { keywordMatches, rank } from '../build/search.js';
import { contentKeys, factLikeKeys, maxProperties } from '../build/hygiene.js';
import { readOnlyViolation } from '../build/cypher-guard.js';
import { isDreamArgs, isMemoryStatsArgs, isQueryMemoriesArgs, isSearchMemoriesArgs } from '../build/types.js';
import { secureEndpoint } from '../build/embeddings.js';

function approxEqual(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} ≈ ${expected}`);
}

try {
  approxEqual(cosine([1, 0, 0], [1, 0, 0]), 1);
  approxEqual(cosine([1, 0], [0, 1]), 0);

  const text = embeddingText('Person', {
    name: 'Ben Weeks',
    aliases: ['Benjamin Weeks', 'B. Weeks'],
    email: 'ben@example.com',
    embedding: [1, 2, 3],
    name_embedding: [1, 2, 3],
    embedding_model: 'local/test',
    embedded_at: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z'
  });
  assert.ok(text.startsWith('Person: Ben Weeks'));
  assert.ok(text.includes('aliases: Benjamin Weeks, B. Weeks'));
  assert.ok(text.includes('email: ben@example.com'));
  assert.ok(!text.includes('embedding:'));
  assert.ok(!text.includes('created_at:'));

  const scrubbed = scrub({
    embedding: [1, 2, 3],
    nested: {
      embedding_model: 'local/test',
      embedded_at: '2026-01-01T00:00:00.000Z',
      keep: true
    },
    items: [
      { embedding: [9, 9, 9], value: 'a' },
      { value: 'b', child: { embedding_model: 'x', keep: 2 } }
    ]
  });
  assert.deepStrictEqual(scrubbed, {
    nested: { keep: true },
    items: [
      { value: 'a' },
      { value: 'b', child: { keep: 2 } }
    ]
  });

  assert.strictEqual(createEmbedder({ REVERIE_EMBEDDINGS: 'none' }), null);

  const ranked = rank(
    [
      {
        id: 1,
        props: {
          name: 'Benjamin Weeks',
          created_at: '2026-01-03T00:00:00.000Z'
        }
      },
      {
        id: 2,
        props: {
          name: 'Will Example',
          created_at: '2026-01-02T00:00:00.000Z',
          embedding: [0, 1, 0],
          name_embedding: [0.8, 0.6, 0],
          embedding_model: 'local/demo'
        }
      },
      {
        id: 3,
        props: {
          name: 'Far Match',
          created_at: '2026-01-01T00:00:00.000Z',
          embedding: [0, 1, 0],
          embedding_model: 'local/demo'
        }
      }
    ],
    {
      query: 'Ben Weeks',
      mode: 'hybrid',
      queryEmbedding: [1, 0, 0],
      threshold: 0.4,
      modelId: 'local/demo'
    }
  );
  assert.deepStrictEqual(ranked.map((item) => item.id), [1, 2]);
  assert.deepStrictEqual(ranked.map((item) => item.match), ['keyword', 'semantic']);
  approxEqual(ranked[1].score, 0.8); // best of embedding (0) and name_embedding (0.8)

  assert.strictEqual(nameText('Person', { name: 'Ben Weeks', aliases: ['Benjamin'], context: 'ignored' }), 'Person: Ben Weeks\naliases: Benjamin');

  assert.strictEqual(keywordMatches('Ben Weeks', { name: 'Benjamin' }), true);
  assert.strictEqual(keywordMatches('Benjamin', { name: 'Ben' }), false);

  const bloated = {
    name: 'Ben Weeks', email: 'ben@example.com', _id: 1, _labels: ['Person'], created_at: 'x', embedding: [1],
    live_call_camera_failure_2026_07_31: 'short', role: 'Founder',
    preference: 'A very long piece of prose that is clearly an episode rather than an attribute of the person, well over the limit for a plain attribute value.'
  };
  assert.deepStrictEqual(contentKeys(bloated), ['name', 'email', 'live_call_camera_failure_2026_07_31', 'role', 'preference']);
  assert.deepStrictEqual(factLikeKeys(bloated), ['live_call_camera_failure_2026_07_31', 'preference']);
  assert.strictEqual(maxProperties({}), 30);
  assert.strictEqual(maxProperties({ REVERIE_MAX_PROPERTIES: '12' }), 12);
  assert.strictEqual(maxProperties({ REVERIE_MAX_PROPERTIES: '12.5' }), 30);
  assert.strictEqual(maxProperties({ REVERIE_MAX_PROPERTIES: '12abc' }), 30);
  assert.strictEqual(maxProperties({ REVERIE_MAX_PROPERTIES: '9999' }), 30);

  // keyword matching ignores housekeeping fields such as created_at
  assert.strictEqual(keywordMatches('2026', { name: 'Ben', created_at: '2026-01-01T00:00:00Z' }), false);

  // read-only Cypher guard
  assert.strictEqual(readOnlyViolation('MATCH (n:Person) RETURN n.name'), null);
  assert.strictEqual(readOnlyViolation("MATCH (n) WHERE n.name = 'Sunset' RETURN n"), null);
  assert.strictEqual(readOnlyViolation('CALL db.labels() YIELD label RETURN label'), null);
  assert.ok(readOnlyViolation('MATCH (n) DETACH DELETE n'));
  assert.ok(readOnlyViolation("CALL db.create.setNodeVectorProperty(n, 'embedding', [1.0])"));
  assert.ok(readOnlyViolation("CALL apoc.create.node(['X'], {}) YIELD node RETURN node"));
  assert.ok(readOnlyViolation('CALL { MATCH (n) RETURN n } RETURN 1'));

  // argument validation rejects unknown keys and out-of-range numbers
  assert.strictEqual(isSearchMemoriesArgs({ query: 'x', limit: 5, depth: 2, similarity_threshold: 0.5 }), true);
  assert.strictEqual(isSearchMemoriesArgs({ query: 'x', search_mod: 'semantic' }), false);
  assert.strictEqual(isSearchMemoriesArgs({ limit: -1 }), false);
  assert.strictEqual(isSearchMemoriesArgs({ limit: 201 }), false);
  assert.strictEqual(isSearchMemoriesArgs({ depth: 1.5 }), false);
  assert.strictEqual(isSearchMemoriesArgs({ similarity_threshold: 1.2 }), false);
  assert.strictEqual(isMemoryStatsArgs({}), true);
  assert.strictEqual(isMemoryStatsArgs([]), false);
  assert.strictEqual(isMemoryStatsArgs({ verbose: true }), false);
  assert.strictEqual(isDreamArgs({ dry_run: true }), true);
  assert.strictEqual(isDreamArgs({ dryRun: true }), false);
  assert.strictEqual(isQueryMemoriesArgs({ cypher: 'RETURN 1', params: { a: 1 } }), true);
  assert.strictEqual(isQueryMemoriesArgs({ cypher: 'RETURN 1', params: [1] }), false);

  // provider endpoints must be https unless loopback
  assert.strictEqual(secureEndpoint('https://api.openai.com/v1/', 'X'), 'https://api.openai.com/v1');
  assert.strictEqual(secureEndpoint('http://localhost:8080/v1', 'X'), 'http://localhost:8080/v1');
  assert.throws(() => secureEndpoint('http://proxy.example.com/v1', 'X'));

  console.log('PASS test-embeddings-unit: embeddings helpers and hybrid ranking behave as expected');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
