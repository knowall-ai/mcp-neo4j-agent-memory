#!/usr/bin/env node
import express, { Request, Response } from 'express';
import cors from 'cors';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Neo4jServer } from './server.js';
import { Neo4jServerConfig } from './types.js';

// Get or create Neo4j configuration
function getNeo4jConfig(): Neo4jServerConfig | undefined {
  const uri = process.env.NEO4J_URI?.trim();
  const username = process.env.NEO4J_USERNAME?.trim();
  const password = process.env.NEO4J_PASSWORD?.trim();
  const hasDbConfig = uri && username && password;

  if (!hasDbConfig) {
    return undefined;
  }

  return {
    uri: uri!,
    username: username!,
    password: password!,
    database: process.env.NEO4J_DATABASE?.trim() || undefined,
  };
}

// Create Express app
const app = express();
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'mcp-neo4j-agent-memory',
    timestamp: new Date().toISOString(),
  });
});

// MCP endpoint - POST for handling MCP requests
// Following SDK pattern: create new transport for each request to prevent request ID collisions
app.post('/mcp', async (req: Request, res: Response) => {
  let server: Neo4jServer | null = null;
  let transport: StreamableHTTPServerTransport | null = null;

  try {
    // Create new server and transport for this request
    const config = getNeo4jConfig();
    server = new Neo4jServer(config);
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Let SDK manage session IDs
      enableJsonResponse: true,
    });

    // Connect server to transport
    await server.connect(transport);

    // Clean up when response completes
    res.on('close', () => {
      if (transport) {
        transport.close();
      }
      if (server) {
        server.close().catch((error) => {
          console.error('Error closing server:', error);
        });
      }
    });

    // Handle the MCP request through the transport
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Error handling MCP request:', error);

    // Clean up on error
    if (transport) {
      transport.close();
    }
    if (server) {
      await server.close().catch((err) => {
        console.error('Error closing server:', err);
      });
    }

    // Only send error response if headers haven't been sent
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
});

// Start server
const PORT = parseInt(process.env.PORT || '3000', 10);
const httpServer = app.listen(PORT, '0.0.0.0', () => {
  console.error(`Neo4j MCP HTTP server running on http://0.0.0.0:${PORT}`);
  console.error(`Health check: http://0.0.0.0:${PORT}/health`);
  console.error(`MCP endpoint: http://0.0.0.0:${PORT}/mcp`);
});

// Graceful shutdown
async function shutdown() {
  console.error('Shutting down HTTP server...');

  // Close HTTP server
  httpServer.close(() => {
    console.error('HTTP server closed');
    process.exit(0);
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    console.error('Forced shutdown');
    process.exit(1);
  }, 10000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
