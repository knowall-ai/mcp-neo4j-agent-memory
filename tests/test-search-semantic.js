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

  const sendMessage = (name, args) => {
    const message = {
      jsonrpc: '2.0',
      id: messageId++,
      method: 'tools/call',
      params: { name, arguments: args }
    };
    mcp.stdin.write(JSON.stringify(message) + '\n');
  };

  mcp.stdout.on('data', (data) => {
    outputBuffer += data.toString();
    const lines = outputBuffer.split('\n');
    outputBuffer = lines[lines.length - 1];

    for (let index = 0; index < lines.length - 1; index += 1) {
      const line = lines[index];
      if (!line.trim()) {
        continue;
      }

      try {
        const response = JSON.parse(line);

        if (response.id === 1) {
          const content = response.result?.content?.[0]?.text;
          if (!content) {
            continue;
          }

          const result = JSON.parse(content);
          memoryId = result.memory?._id ?? result.n?._id ?? null;
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
            ? result.find((row) => row?.memory?.name === 'Benjamin Weeks')
            : null;

          if (!hit) {
            throw new Error('Expected semantic search to return Benjamin Weeks');
          }

          console.log('✅ semantic search_memories test passed');
          sendMessage('delete_memory', { nodeId: memoryId });
        } else if (response.id === 3) {
          console.log('🧹 Cleaned up semantic search test memory');
          clearTimeout(timeout);
          mcp.kill();
          process.exit(0);
        }
      } catch (error) {
        console.error('❌ Error:', error instanceof Error ? error.message : error);
        mcp.kill();
        process.exit(1);
      }
    }
  });

  mcp.stderr.on('data', (data) => {
    console.error('❌ Error:', data.toString());
  });

  sendMessage('create_memory', {
    label: 'person',
    properties: {
      name: 'Benjamin Weeks',
      context: 'Semantic search integration test',
      created_at: new Date().toISOString()
    }
  });

  const timeout = setTimeout(() => {
    console.log('⏰ Test timeout');
    mcp.kill();
    process.exit(1);
  }, 60000); // first run may download the local embedding model
};

testSearchSemantic();
