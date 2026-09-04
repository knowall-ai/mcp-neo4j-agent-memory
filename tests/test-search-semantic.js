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

  // Every exit path comes through here: delete the test node, confirm the deletion, then wait for the
  // child to close. A 3s backstop bounds each stage so a hung server cannot leave the test running.
  let deleteId = null;
  let exitCode = 0;
  const finish = (code) => {
    if (finishing) return;
    finishing = true;
    exitCode = code;
    clearTimeout(timeout);
    if (memoryId === null) {
      terminate();
      return;
    }
    deleteId = messageId;
    sendMessage('delete_memory', { nodeId: memoryId });
    setTimeout(() => {
      console.error('❌ Error: delete_memory did not respond; the test node may be left behind');
      exitCode = 1;
      terminate();
    }, 3000).unref();
  };

  const terminate = () => {
    const backstop = setTimeout(() => process.exit(exitCode || 1), 3000);
    mcp.once('close', () => {
      clearTimeout(backstop);
      process.exit(exitCode);
    });
    mcp.kill();
  };

  const timeout = setTimeout(() => {
    console.log('⏰ Test timeout');
    finish(1);
  }, 60000); // first run may download the local embedding model

  mcp.stdout.on('data', (data) => {
    outputBuffer += data.toString();
    const lines = outputBuffer.split('\n');
    outputBuffer = lines[lines.length - 1];

    for (let index = 0; index < lines.length - 1; index += 1) {
      const line = lines[index];
      if (!line.trim()) continue;

      try {
        const response = JSON.parse(line);

        if (finishing) {
          if (response.id === deleteId) {
            if (response.error || response.result?.isError) {
              console.error('❌ Error: delete_memory failed:', JSON.stringify(response.error ?? response.result));
              exitCode = 1;
            } else {
              console.log('🧹 Cleaned up semantic search test memory');
            }
            terminate();
          }
          continue;
        }

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
          // In semantic mode the keyword tier is not used, so _match proves the embedding path ran
          // rather than the keyword fallback that kicks in when embeddings are unavailable.
          if (hit.memory._match !== 'semantic') {
            throw new Error(`Expected a semantic match, got _match=${hit.memory._match}`);
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
