# Troubleshooting Guide

## Common Issues and Solutions

| Problem | Solution |
|---------|----------|
| **Server fails to start with "NEO4J_PASSWORD environment variable is required"** | Ensure all required environment variables are set: `NEO4J_URI`, `NEO4J_USERNAME`, and `NEO4J_PASSWORD`. Check your `.env` file or Claude Desktop configuration. |
| **"Failed to connect to server" error** | 1. Verify Neo4j is running (`neo4j status`)<br>2. Check connection URI (default: `bolt://localhost:7687`)<br>3. Confirm credentials are correct<br>4. Test connection with Neo4j Browser |
| **Tools not appearing in Smithery** | 1. Ensure environment variables are properly configured in `smithery.yaml`<br>2. Check that the server starts without database config<br>3. Verify the Docker build completes successfully |
| **"McpError: MCP error -32001: Request timed out" on Smithery** | This typically occurs when the server expects database credentials but receives empty strings. The server now handles this gracefully. |
| **Integer conversion errors** | The server automatically converts Neo4j Integer types to JavaScript numbers. No action needed. |
| **"Cannot find memory" when updating/deleting** | 1. Use `search_memories` to find the correct node ID<br>2. Ensure you're using the numeric ID, not the content<br>3. Check if the memory still exists |
| **Relationships not showing in search results** | Increase the `depth` parameter in `search_memories` (default is 1, try 2 or 3) |
| **Duplicate memories being created** | Always search before creating: `search_memories({"query": "entity name"})` to check if it already exists |
| **"Invalid label" errors** | 1. Labels must be lowercase (use `person` not `Person`)<br>2. Use `list_memory_labels` to see existing labels<br>3. Consider using common labels for consistency |
| **Empty search results** | 1. Try broader search terms<br>2. Remove the `label` filter<br>3. Increase the `limit` parameter (default 10, max 200)<br>4. Check if database is populated |
| **Docker build fails with "Cannot find module"** | Ensure source files are copied before npm install in Dockerfile. This has been fixed in latest version. |
| **Long deployment times on Smithery** | Normal for initial deployments. Subsequent deployments use cached layers and are faster. |
| **Environment variables showing as empty strings** | The server now trims whitespace and ignores empty strings. Ensure your `.env` file doesn't have quotes around empty values. |
| **Test failures** | 1. Ensure Neo4j is running<br>2. Check test database exists (`mcp-test`)<br>3. Verify environment variables in `.env`<br>4. Run `npm run build` before tests |

## Debugging Tips

### Enable Debug Logging
```bash
# For Smithery debugging
export DEBUG_SMITHERY=true

# For general debugging
export DEBUG=mcp:*
```

### Test Database Connection
```javascript
// Quick test script
import neo4j from 'neo4j-driver';

const driver = neo4j.driver(
  process.env.NEO4J_URI,
  neo4j.auth.basic(process.env.NEO4J_USERNAME, process.env.NEO4J_PASSWORD)
);

try {
  await driver.verifyConnectivity();
  console.log('Connected successfully!');
} catch (error) {
  console.error('Connection failed:', error);
} finally {
  await driver.close();
}
```

### Check Server Startup
```bash
# Run directly to see all output
node build/index.js

# Use MCP inspector for interactive testing
npm run inspector
```

### Common Cypher Queries for Debugging
```cypher
// Count all memories
MATCH (n) RETURN count(n) as total;

// Show all labels
CALL db.labels() YIELD label RETURN label;

// Find recent memories
MATCH (n) 
WHERE n.created_at > datetime() - duration('P7D')
RETURN n ORDER BY n.created_at DESC;

// Show all relationships
MATCH ()-[r]->() RETURN type(r), count(r);
```

## Getting Help

If you encounter issues not covered here:

1. Check the [GitHub Issues](https://github.com/knowall-ai/mcp-reverie/issues)
2. Review the [Neo4j documentation](https://neo4j.com/docs/)
3. Ensure you're using compatible versions:
   - Neo4j: 4.4+ or 5.x
   - Node.js: 18+
   - MCP SDK: 0.6.0+

## Reporting Issues

When reporting issues, please include:
- Neo4j version (`neo4j version`)
- Node.js version (`node --version`)
- Error messages and stack traces
- Relevant environment configuration (sanitized)
- Steps to reproduce the issue