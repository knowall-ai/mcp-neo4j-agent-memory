# Azure Container Apps Deployment Guide

This guide covers deploying the MCP Neo4j Agent Memory server to Azure Container Apps with Streamable HTTP transport.

## Prerequisites

- Azure subscription
- Azure CLI installed and configured
- Docker CLI (optional, for local testing)
- Neo4j database (can be Azure-hosted or external)

## Deployment Options

### Option 1: Deploy from Docker Hub

If the image is published to a container registry:

```bash
# Set environment variables
RESOURCE_GROUP="mcp-neo4j-rg"
LOCATION="eastus"
CONTAINER_APP_NAME="mcp-neo4j-memory"
ENVIRONMENT_NAME="mcp-environment"

# Create resource group
az group create \
  --name $RESOURCE_GROUP \
  --location $LOCATION

# Create Container Apps environment
az containerapp env create \
  --name $ENVIRONMENT_NAME \
  --resource-group $RESOURCE_GROUP \
  --location $LOCATION

# Create Container App
az containerapp create \
  --name $CONTAINER_APP_NAME \
  --resource-group $RESOURCE_GROUP \
  --environment $ENVIRONMENT_NAME \
  --image knowallai/mcp-neo4j-agent-memory:latest \
  --target-port 3000 \
  --ingress external \
  --env-vars \
    NEO4J_URI="bolt://your-neo4j-host:7687" \
    NEO4J_USERNAME="neo4j" \
    NEO4J_PASSWORD="secretref:neo4j-password" \
    NEO4J_DATABASE="neo4j" \
  --secrets neo4j-password="YourSecurePassword" \
  --cpu 0.5 \
  --memory 1.0Gi \
  --min-replicas 1 \
  --max-replicas 3
```

### Option 2: Build and Deploy from GitHub

```bash
# Build from GitHub repository
az containerapp up \
  --name $CONTAINER_APP_NAME \
  --resource-group $RESOURCE_GROUP \
  --location $LOCATION \
  --environment $ENVIRONMENT_NAME \
  --source https://github.com/knowall-ai/mcp-neo4j-agent-memory \
  --target-port 3000 \
  --ingress external \
  --env-vars \
    NEO4J_URI="bolt://your-neo4j-host:7687" \
    NEO4J_USERNAME="neo4j" \
    NEO4J_PASSWORD="secretref:neo4j-password" \
    NEO4J_DATABASE="neo4j"
```

## Environment Variables

Configure these environment variables in your Container App:

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `NEO4J_URI` | Yes | Neo4j connection URI | `bolt://localhost:7687` |
| `NEO4J_USERNAME` | Yes | Neo4j username | `neo4j` |
| `NEO4J_PASSWORD` | Yes | Neo4j password | `your-password` |
| `NEO4J_DATABASE` | No | Database name (Enterprise only) | `neo4j` |
| `PORT` | No | HTTP server port | `3000` (default) |

## Using Azure Managed Identity (Recommended for Production)

For production deployments, use Azure Managed Identity to connect to Neo4j without storing passwords:

1. Enable Managed Identity on your Container App:

```bash
az containerapp identity assign \
  --name $CONTAINER_APP_NAME \
  --resource-group $RESOURCE_GROUP \
  --system-assigned
```

2. If using Azure Cosmos DB for Apache Gremlin (which supports Neo4j protocol):

```bash
# Get the managed identity principal ID
PRINCIPAL_ID=$(az containerapp identity show \
  --name $CONTAINER_APP_NAME \
  --resource-group $RESOURCE_GROUP \
  --query principalId -o tsv)

# Grant access to Cosmos DB
az cosmosdb sql role assignment create \
  --account-name $COSMOS_ACCOUNT_NAME \
  --resource-group $RESOURCE_GROUP \
  --scope "/" \
  --principal-id $PRINCIPAL_ID \
  --role-definition-id 00000000-0000-0000-0000-000000000002
```

## Health Checks

The HTTP server exposes a health check endpoint at `/health`:

```bash
curl https://your-app.azurecontainerapps.io/health
```

Response:
```json
{
  "status": "ok",
  "service": "mcp-neo4j-agent-memory",
  "activeSessions": 0,
  "timestamp": "2025-01-15T10:30:00.000Z"
}
```

Configure health probes in your Container App:

```bash
az containerapp update \
  --name $CONTAINER_APP_NAME \
  --resource-group $RESOURCE_GROUP \
  --set-env-vars PORT=3000 \
  --health-probe-type liveness \
  --health-probe-http-get-path /health \
  --health-probe-interval 30 \
  --health-probe-timeout 5
```

## Connecting from Azure AI Foundry

Once deployed, configure your Azure AI Foundry agent to connect to the MCP server:

1. Get your Container App URL:

```bash
az containerapp show \
  --name $CONTAINER_APP_NAME \
  --resource-group $RESOURCE_GROUP \
  --query properties.configuration.ingress.fqdn -o tsv
```

2. In Azure AI Foundry, configure the MCP connection:

```json
{
  "mcpServers": {
    "neo4j-memory": {
      "type": "streamable-http",
      "url": "https://your-app.azurecontainerapps.io"
    }
  }
}
```

## Scaling Configuration

Configure autoscaling rules:

```bash
az containerapp update \
  --name $CONTAINER_APP_NAME \
  --resource-group $RESOURCE_GROUP \
  --min-replicas 1 \
  --max-replicas 5 \
  --scale-rule-name http-scaling \
  --scale-rule-type http \
  --scale-rule-http-concurrency 10
```

## Monitoring and Logs

### View Container Logs

```bash
az containerapp logs show \
  --name $CONTAINER_APP_NAME \
  --resource-group $RESOURCE_GROUP \
  --follow
```

### Enable Application Insights

```bash
# Create Application Insights
az monitor app-insights component create \
  --app mcp-neo4j-insights \
  --location $LOCATION \
  --resource-group $RESOURCE_GROUP

# Get instrumentation key
INSTRUMENTATION_KEY=$(az monitor app-insights component show \
  --app mcp-neo4j-insights \
  --resource-group $RESOURCE_GROUP \
  --query instrumentationKey -o tsv)

# Update Container App with Application Insights
az containerapp update \
  --name $CONTAINER_APP_NAME \
  --resource-group $RESOURCE_GROUP \
  --set-env-vars APPLICATIONINSIGHTS_CONNECTION_STRING="InstrumentationKey=$INSTRUMENTATION_KEY"
```

## Security Best Practices

1. **Use Secrets for Sensitive Data**: Store passwords in Azure Key Vault and reference them as secrets
2. **Enable HTTPS Only**: Container Apps ingress is HTTPS by default
3. **Restrict Ingress**: Use internal ingress if only needed within Azure
4. **Network Security**: Configure Virtual Network integration for private connectivity
5. **Managed Identity**: Use Azure Managed Identity instead of connection strings when possible

## Troubleshooting

### Container App Won't Start

1. Check logs:
```bash
az containerapp logs show --name $CONTAINER_APP_NAME --resource-group $RESOURCE_GROUP
```

2. Verify environment variables are set correctly:
```bash
az containerapp show --name $CONTAINER_APP_NAME --resource-group $RESOURCE_GROUP --query properties.template.containers[0].env
```

### Can't Connect to Neo4j

1. Verify Neo4j is accessible from Azure
2. Check firewall rules allow Container Apps IP ranges
3. Verify connection string format: `bolt://host:7687`
4. Test connection with Neo4j Cypher Shell

### Session Issues

The HTTP server maintains sessions with 30-minute timeout. Check:
- Active sessions via `/health` endpoint
- Session cleanup in logs
- Memory usage if sessions accumulate

## Cost Optimization

- **Minimum Replicas**: Set to 0 for dev/test environments
- **Auto-pause**: Enable consumption plan for pay-per-use
- **Resource Limits**: Adjust CPU/memory based on actual usage
- **Neo4j Connection Pooling**: Server maintains connection pool per session

## Additional Resources

- [Azure Container Apps Documentation](https://docs.microsoft.com/azure/container-apps/)
- [Neo4j on Azure](https://neo4j.com/cloud/azure/)
- [MCP Specification](https://modelcontextprotocol.io/)
- [Project Repository](https://github.com/knowall-ai/mcp-neo4j-agent-memory)
