#!/usr/bin/env node
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('🚀 Testing server startup with various environment configurations...');

const serverPath = path.join(__dirname, '..', 'build', 'index.js');

// Test configurations
const testConfigs = [
  {
    name: 'No environment variables',
    env: {},
    shouldStart: true,
    description: 'Server should start without DB config for tool discovery'
  },
  {
    name: 'Empty string environment variables',
    env: {
      NEO4J_URI: '',
      NEO4J_USERNAME: '',
      NEO4J_PASSWORD: '',
      NEO4J_DATABASE: ''
    },
    shouldStart: true,
    description: 'Server should treat empty strings as no config'
  },
  {
    name: 'Whitespace-only environment variables',
    env: {
      NEO4J_URI: '   ',
      NEO4J_USERNAME: '  ',
      NEO4J_PASSWORD: '    ',
      NEO4J_DATABASE: ''
    },
    shouldStart: true,
    description: 'Server should treat whitespace as no config'
  },
  {
    name: 'Partial configuration (missing password)',
    env: {
      NEO4J_URI: 'bolt://localhost:7687',
      NEO4J_USERNAME: 'neo4j'
    },
    shouldStart: false,
    expectedError: 'NEO4J_PASSWORD environment variable is required'
  },
  {
    name: 'Partial configuration (missing URI)',
    env: {
      NEO4J_USERNAME: 'neo4j',
      NEO4J_PASSWORD: 'password'
    },
    shouldStart: false,
    expectedError: 'NEO4J_URI environment variable is required'
  },
  {
    name: 'Full valid configuration',
    env: {
      NEO4J_URI: 'bolt://localhost:7687',
      NEO4J_USERNAME: 'neo4j',
      NEO4J_PASSWORD: 'testpassword',
      NEO4J_DATABASE: 'test'
    },
    shouldStart: true,
    description: 'Server should start with full config'
  }
];

// Test each configuration
async function runTest(config) {
  return new Promise((resolve) => {
    console.log(`\n📋 Test: ${config.name}`);
    if (config.description) {
      console.log(`   ${config.description}`);
    }
    
    const env = { ...process.env, ...config.env };
    const child = spawn('node', [serverPath], { 
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    let stdout = '';
    let stderr = '';
    let processExited = false;
    let expectedExit = false; // set just before we kill a server that started correctly
    
    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    child.on('exit', (code) => {
      processExited = true;
      
      if (config.shouldStart) {
        if (expectedExit) return; // our own kill after a successful start
        // A server that is expected to start must still be running when the startup interval
        // ends; any exit before then, even a clean one, is a failure.
        console.log('   ❌ Server exited before the startup interval ended');
        console.log('   Exit code:', code);
        console.log('   Stderr:', stderr);
        resolve(false);
      } else {
        if (code !== 0 && config.expectedError && stderr.includes(config.expectedError)) {
          console.log(`   ✅ Server correctly failed with expected error: "${config.expectedError}"`);
          resolve(true);
        } else {
          console.log('   ❌ Server did not fail as expected');
          console.log('   Exit code:', code);
          console.log('   Stderr:', stderr);
          resolve(false);
        }
      }
    });
    
    // For servers that should start, check after a delay
    if (config.shouldStart) {
      setTimeout(() => {
        if (!processExited) {
          // Server is still running, that's good. Stop it and wait for it to close (bounded) so the
          // next configuration never starts while this child is still alive.
          expectedExit = true;
          const killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
          child.once('close', () => {
            clearTimeout(killTimer);
            console.log('   ✅ Server started successfully');
            resolve(true);
          });
          child.kill();
        }
      }, 2000);
    }
  });
}

// Run all tests
async function runAllTests() {
  let passed = 0;
  let failed = 0;
  
  for (const config of testConfigs) {
    const result = await runTest(config);
    if (result) {
      passed++;
    } else {
      failed++;
    }
  }
  
  console.log('\n📊 Test Results:');
  console.log(`   ✅ Passed: ${passed}`);
  console.log(`   ❌ Failed: ${failed}`);
  console.log(`   📋 Total: ${testConfigs.length}`);
  
  if (failed === 0) {
    console.log('\n🎉 All server startup tests passed!');
    process.exit(0);
  } else {
    console.log('\n❌ Some tests failed');
    process.exit(1);
  }
}

runAllTests();