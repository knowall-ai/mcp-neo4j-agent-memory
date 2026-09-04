import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Neo4jClient } from './neo4j-client.js';
import { Neo4jServerConfig } from './types.js';
import { tools } from './tools/definitions.js';
import { handleToolCall } from './handlers/index.js';

export class Neo4jServer {
  private server: Server;
  private neo4j: Neo4jClient | null;

  constructor(config?: Neo4jServerConfig) {
    this.server = new Server(
      {
        name: 'reverie',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.neo4j = config ? new Neo4jClient(config.uri, config.username, config.password, config.database) : null;
    this.setupToolHandlers();

    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.close();
      process.exit(0);
    });
  }

  private setupToolHandlers(): void {
    // Tool list handler
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools,
    }));

    // Tool execution handler
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (!this.neo4j) {
        return {
          content: [
            {
              type: 'text',
              text: 'Neo4j connection not configured. Please set NEO4J_URI, NEO4J_USERNAME, and NEO4J_PASSWORD environment variables.',
            },
          ],
          isError: true,
        };
      }
      const { name, arguments: args } = request.params;
      return handleToolCall(name, args, this.neo4j);
    });
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Neo4j MCP server running on stdio');
  }

  async close(): Promise<void> {
    if (this.neo4j) {
      await this.neo4j.close();
    }
    await this.server.close();
  }
}