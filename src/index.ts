#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Neo4jServer } from './server.js';

// Debug environment for Smithery
if (process.env.DEBUG_SMITHERY) {
  console.error('Environment variables:', {
    NEO4J_URI: process.env.NEO4J_URI,
    NEO4J_USERNAME: process.env.NEO4J_USERNAME,
    NEO4J_PASSWORD: process.env.NEO4J_PASSWORD,
    NEO4J_DATABASE: process.env.NEO4J_DATABASE
  });
}

// Check if we have database configuration (ignore empty strings)
const uri = process.env.NEO4J_URI?.trim();
const username = process.env.NEO4J_USERNAME?.trim();
const password = process.env.NEO4J_PASSWORD?.trim();
const hasDbConfig = uri && username && password;

// Only validate environment variables if at least one non-empty value is provided
if ((uri || username || password) && !hasDbConfig) {
  // If any Neo4j env var is set, all required ones must be set
  if (!password) {
    console.error('Error: NEO4J_PASSWORD environment variable is required');
    process.exit(1);
  }
  if (!uri) {
    console.error('Error: NEO4J_URI environment variable is required');
    process.exit(1);
  }
  if (!username) {
    console.error('Error: NEO4J_USERNAME environment variable is required');
    process.exit(1);
  }
}

const config = hasDbConfig ? {
  uri: uri!,
  username: username!,
  password: password!,
  database: process.env.NEO4J_DATABASE?.trim() || undefined, // Optional for Neo4j Community Edition
} : undefined;

// サーバーの起動 (STDIO transport)
const server = new Neo4jServer(config);
const transport = new StdioServerTransport();

server.connect(transport).then(() => {
  console.error('Neo4j MCP server running on stdio');
}).catch((error) => {
  console.error('Failed to start Neo4j MCP server:', error);
  process.exit(1);
});

// 終了時のクリーンアップ
process.on('SIGINT', async () => {
  try {
    await server.close();
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
});

process.on('SIGTERM', async () => {
  try {
    await server.close();
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
});
