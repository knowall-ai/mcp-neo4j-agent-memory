#!/usr/bin/env node

import { spawn } from 'child_process';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env' });

const testSearchSemantic = () => {
  console.log('🧠🔍 Testing semantic search_memories mode...');

  const mcp = spawn('node', ['../build/index.js'], {
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let messageId = 1;
  let outputBuffer = '';
  let memoryId = null;
  let finishing = false;

  const sendMessage = (name, args) => {
    const message = {
      jsonrpc: '2.0',
      id: messageId++,
      method: 'tools/call',
      params: { name, arguments: args }
    };
    mcp.stdin.write(JSON.stringify(message) + '\n');
  };

  // Every exit path comes through here so the test node is always deleted (bounded by a 3s backstop).
  const finish = (code) => {
    if (finishing) return;
    finishing = true;
    clearTimeout(timeout);
    const exit = () => {
      mcp.kill();
      process.exit(code);
    };
    if (memoryId === null) {
      exit();
      return;
    }
    const backstop = setTimeout(exit, 3000);
    mcp.stdout.once('data', () => {
      clearTimeout(backstop);
      console.log('🧹 Cleaned up semantic search test memory');
      exit();
    });
    sendMessage('delete_memory', { nodeId: memoryId });
  };

  const timeout = setTimeout(() => {
    console.log('⏰ Test timeout');
    finish(1);
  }, 60000); // first run may download the local embedding model

  mcp.stdout.on('data', (data) => {
    if (finishing) return;
    outputBuffer += data.toString();
    const lines = outputBuffer.split('\n');
    outputBuffer = lines[lines.length - 1];

    for (let index = 0; index < lines.length - 1; index += 1) {
      const line = lines[index];
      if (!line.trim()) continue;

      try {
        const response = JSON.parse(line);

        if (response.id === 1) {
          const content = response.result?.content?.[0]?.text;
          if (!content) continue;

          const result = JSON.parse(content);
          memoryId = result.memory?._id ?? null;
          if (memoryId === null) {
            throw new Error('Failed to capture created memory ID');
          }

          console.log(`✅ Created test memory with ID: ${memoryId}`);
          sendMessage('search_memories', {
            query: 'Ben Weeks',
            label: 'person',
            search_mode: 'semantic',
            similarity_threshold: 0.3,
            depth: 0,
            limit: 5
          });
        } else if (response.id === 2) {
          const content = response.result?.content?.[0]?.text;
          const result = content ? JSON.parse(content) : [];
          const hit = Array.isArray(result)
            ? result.find((row) => row?.memory?._id === memoryId)
            : null;

          if (!hit) {
            throw new Error('Expected semantic search to return the Benjamin Weeks test node');
          }

          console.log('✅ semantic search_memories test passed');
          finish(0);
        }
      } catch (error) {
        console.error('❌ Error:', error instanceof Error ? error.message : error);
        finish(1);
      }
    }
  });

  mcp.stderr.on('data', (data) => {
    const text = data.toString();
    if (!text.includes('running on stdio')) console.error('❌ Error:', text);
  });

  sendMessage('create_memory', {
    label: 'person',
    properties: {
      name: 'Benjamin Weeks',
      context: 'Semantic search integration test',
      created_at: new Date().toISOString()
    }
  });
};

testSearchSemantic();
