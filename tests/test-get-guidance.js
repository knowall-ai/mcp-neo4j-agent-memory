#!/usr/bin/env node

// Test script for get_guidance function
// This script tests the guidance system for memory tools

import { spawn } from 'child_process';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config({ path: '../.env' });

const testGetGuidance = () => {
  console.log('📚 Testing get_guidance function...');
  
  const mcp = spawn('node', ['../build/index.js'], {
    env: { 
      ...process.env,
      NEO4J_PASSWORD: process.env.NEO4J_PASSWORD,
      NEO4J_DATABASE: process.env.NEO4J_DATABASE,
      NEO4J_URI: process.env.NEO4J_URI,
      NEO4J_USERNAME: process.env.NEO4J_USERNAME
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let output = '';
  let testsPassed = 0;
  const totalTests = 5;

  mcp.stdout.on('data', (data) => {
    output += data.toString();
    const lines = output.split('\n');
    
    for (const line of lines) {
      if (line.trim()) {
        try {
          const response = JSON.parse(line);
          if (response.id && response.result) {
            const content = response.result?.content?.[0]?.text;
            
            switch(response.id) {
              case 1: // All guidance
                if (content && content.includes('Common Memory Labels') && 
                    content.includes('Common Relationship Types') && 
                    content.includes('Best Practices')) {
                  console.log('✅ All guidance test passed');
                  testsPassed++;
                } else {
                  console.error('❌ All guidance test failed');
                }
                break;
                
              case 2: // Labels only
                if (content && content.includes('People & Living Things')) {
                  console.log('✅ Labels guidance test passed');
                  testsPassed++;
                } else {
                  console.error('❌ Labels guidance test failed');
                }
                break;
                
              case 3: // Relationships only
                if (content && content.includes('Personal Relationships')) {
                  console.log('✅ Relationships guidance test passed');
                  testsPassed++;
                } else {
                  console.error('❌ Relationships guidance test failed');
                }
                break;
                
              case 4: // Best practices
                if (content && content.includes('ALWAYS SEARCH FIRST')) {
                  console.log('✅ Best practices guidance test passed');
                  testsPassed++;
                } else {
                  console.error('❌ Best practices guidance test failed');
                }
                break;
                
              case 5: // Invalid topic
                if (content && content.includes('Unknown topic')) {
                  console.log('✅ Invalid topic test passed');
                  testsPassed++;
                } else {
                  console.error('❌ Invalid topic test failed');
                }
                break;
            }
            
            if (testsPassed === totalTests) {
              console.log(`\n✨ All ${totalTests} tests completed successfully!`);
              mcp.kill();
              process.exit(0);
            }
          }
        } catch (e) {
          // Ignore non-JSON lines
        }
      }
    }
  });

  mcp.stderr.on('data', (data) => {
    console.error('❌ Error:', data.toString());
  });

  const sendMessage = (topic) => {
    const message = {
      jsonrpc: '2.0',
      id: testsPassed + 1,
      method: 'tools/call',
      params: {
        name: 'get_guidance',
        arguments: topic ? { topic } : {}
      }
    };
    mcp.stdin.write(JSON.stringify(message) + '\n');
  };

  // Test 1: Get all guidance (no topic)
  console.log('\nTest 1: Getting all guidance...');
  sendMessage();

  // Test 2: Get labels guidance
  setTimeout(() => {
    console.log('\nTest 2: Getting labels guidance...');
    sendMessage('labels');
  }, 500);

  // Test 3: Get relationships guidance
  setTimeout(() => {
    console.log('\nTest 3: Getting relationships guidance...');
    sendMessage('relationships');
  }, 1000);

  // Test 4: Get best practices
  setTimeout(() => {
    console.log('\nTest 4: Getting best practices...');
    sendMessage('best-practices');
  }, 1500);

  // Test 5: Invalid topic
  setTimeout(() => {
    console.log('\nTest 5: Testing invalid topic...');
    sendMessage('invalid-topic');
  }, 2000);

  // Set a timeout but mark test as failed if we reach it
  const timeout = setTimeout(() => {
    console.error(`\n❌ Test failed: Timeout reached. Passed ${testsPassed}/${totalTests} tests`);
    mcp.kill();
    process.exit(1);
  }, 10000);
};

testGetGuidance();