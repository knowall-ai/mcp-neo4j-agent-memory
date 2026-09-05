#!/usr/bin/env node

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TEST_TIMEOUT_MS = 180000;

const tests = [
  'test-embeddings-unit.js',
  'test-server-startup.js',
  'test-create-memory.js',
  'test-search-memories.js',
  'test-search-semantic.js',
  'test-search-arrays.js',
  'test-create-connection.js',
  'test-update-memory.js',
  'test-update-connection.js',
  'test-delete-connection.js',
  'test-delete-memory.js',
  'test-list-memory-labels.js',
  'test-get-guidance.js'
];

let currentTest = 0;

const runNextTest = () => {
  if (currentTest >= tests.length) {
    console.log('\n🎉 All tests completed!');
    return;
  }

  const testFile = tests[currentTest];
  console.log(`\n🚀 Running ${testFile}...`);

  const testProcess = spawn('node', [join(__dirname, testFile)], {
    stdio: 'inherit',
    cwd: __dirname
  });

  // A hung child (e.g. waiting on Neo4j) must not hang the suite.
  const deadline = setTimeout(() => {
    console.log(`⏰ ${testFile} exceeded ${TEST_TIMEOUT_MS / 1000}s; killing it`);
    process.exitCode = 1;
    testProcess.kill('SIGKILL');
  }, TEST_TIMEOUT_MS);

  testProcess.on('close', (code) => {
    clearTimeout(deadline);
    if (code === 0) {
      console.log(`✅ ${testFile} completed successfully`);
    } else {
      console.log(`❌ ${testFile} failed with code ${code}`);
      process.exitCode = 1;
    }

    currentTest += 1;
    setTimeout(runNextTest, 1000);
  });
};

console.log('🧪 Starting Neo4j MCP Server Test Suite');
console.log('Database: test');
console.log('Tests to run:', tests.length);

runNextTest();
