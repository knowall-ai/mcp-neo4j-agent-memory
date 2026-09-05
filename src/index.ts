#!/usr/bin/env node
import { neo4jConfigError, neo4jConfigFromEnv } from './config.js';
import { Neo4jServer } from './server.js';

// Debug environment for Smithery
if (process.env.DEBUG_SMITHERY) {
  console.error('Environment variables:', {
    NEO4J_URI: process.env.NEO4J_URI,
    NEO4J_USERNAME: process.env.NEO4J_USERNAME,
    NEO4J_PASSWORD: process.env.NEO4J_PASSWORD ? '(set)' : undefined,
    NEO4J_DATABASE: process.env.NEO4J_DATABASE
  });
}

const configError = neo4jConfigError();
if (configError) {
  console.error(configError);
  process.exit(1);
}
const config = neo4jConfigFromEnv();

if (process.argv[2] === 'serve') {
  const { ConfigError, installShutdown, startHttpServer } = await import('./http-server.js');
  try {
    installShutdown(await startHttpServer());
  } catch (error) {
    console.error(error instanceof ConfigError ? `Error: ${error.message}` : `Failed to start Reverie HTTP server: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
} else if (process.argv.length > 2) {
  console.error('Usage: reverie [serve]');
  process.exit(2);
} else {
  startStdio();
}

function startStdio(): void {
  const server = new Neo4jServer(config);

  server.run().catch((error) => {
    console.error('Failed to start Neo4j MCP server:', error);
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    try {
      await server.close();
      process.exit(0);
    } catch (error) {
      console.error('Error during shutdown:', error);
      process.exit(1);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
