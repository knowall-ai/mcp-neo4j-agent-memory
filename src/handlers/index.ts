import { CallToolResult, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import neo4j from 'neo4j-driver';
import { Embedder, embedNodes, scrub } from '../embeddings.js';
import { Neo4jClient } from '../neo4j-client.js';
import { Candidate, Ranked, SearchMode, rank } from '../search.js';
import {
  isCreateConnectionArgs,
  isCreateMemoryArgs,
  isDeleteConnectionArgs,
  isDeleteMemoryArgs,
  isDreamArgs,
  isListMemoryLabelsArgs,
  isMemoryStatsArgs,
  isQueryMemoriesArgs,
  isSearchMemoriesArgs,
  isUpdateConnectionArgs,
  isUpdateMemoryArgs
} from '../types.js';
import { getGuidanceContent, isGetGuidanceArgs } from '../tools/guidance-tool.js';

interface SearchCandidate extends Candidate {
  label: string;
}

interface DuplicateNodeRow {
  id: number;
  label: string;
  name: string;
  created_at?: string;
  rel_count: number;
}

interface GroupedDuplicateNode extends DuplicateNodeRow {
  effectiveLabel: string;
}

// Blocks write clauses, subqueries and every procedure except the read-only db.* / dbms.* ones (APOC can write).
const EMBED_NODE_CYPHER = `
  MATCH (n)
  WHERE id(n) = $id
  SET n.embedding = $embedding,
      n.name_embedding = $nameEmbedding,
      n.embedding_model = $model,
      n.embedded_at = $embeddedAt`;

const READ_ONLY_CYPHER_RE = /\b(CREATE|MERGE|SET|DELETE|REMOVE|DROP|DETACH|LOAD\s+CSV)\b|\bCALL\b(?!\s+(db|dbms)\.)/i;

export async function handleToolCall(
  name: string,
  args: unknown,
  neo4jClient: Neo4jClient,
  embedder: Embedder | null
): Promise<CallToolResult> {
  try {
    switch (name) {
      case 'search_memories': {
        if (!isSearchMemoriesArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, 'Invalid search_memories arguments');
        }

        const depth = args.depth ?? 1;
        const limit = Math.min(args.limit ?? 10, 200);
        const query = args.query ?? '';
        const requestedMode = args.search_mode ?? 'hybrid';
        const similarityThreshold = clamp(args.similarity_threshold ?? 0.4, 0, 1);
        let orderBy = 'memory.created_at DESC';
        let hasCustomOrder = false;
        if (args.order_by) {
          const orderMatch = args.order_by.match(/^(memory\.|n\.)?([a-zA-Z_]+)\s+(ASC|DESC)$/i);
          if (orderMatch) {
            orderBy = `memory.${orderMatch[2]} ${orderMatch[3].toUpperCase()}`;
            hasCustomOrder = true;
          }
        }

        let baseQuery = 'MATCH (memory)';
        const conditions: string[] = [];
        const queryParams: Record<string, any> = {};

        if (args.label) {
          conditions.push('toLower(labels(memory)[0]) = toLower($label)');
          queryParams.label = args.label;
        }

        if (args.since_date) {
          conditions.push('memory.created_at >= $since_date');
          queryParams.since_date = args.since_date;
        }

        if (conditions.length > 0) {
          baseQuery += ` WHERE ${conditions.join(' AND ')}`;
        }

        baseQuery += ' RETURN id(memory) AS id, labels(memory)[0] AS label, properties(memory) AS props';
        const rawCandidates = await neo4jClient.executeQuery<SearchCandidate>(baseQuery, queryParams);
        const candidates = rawCandidates.map((candidate) => ({
          id: candidate.id,
          label: candidate.label || 'Memory',
          props: candidate.props || {}
        }));

        const ranking = await rankCandidates(neo4jClient, candidates, query, requestedMode, similarityThreshold, embedder);
        const topRanked = ranking.slice(0, limit);
        const rankedIds = topRanked.map((item) => item.id);

        if (rankedIds.length === 0) {
          return jsonResult([]);
        }

        const result = await fetchMemories(neo4jClient, rankedIds, depth, orderBy, limit);
        const scoring = new Map<number, { score: number; match: Ranked['match'] }>(
          topRanked.map((item) => [item.id, { score: Number(item.score.toFixed(2)), match: item.match }])
        );

        for (const row of result) {
          const memoryId = row?.memory?._id;
          if (typeof memoryId !== 'number') {
            continue;
          }

          const meta = scoring.get(memoryId);
          if (meta) {
            row.memory._score = meta.score;
            row.memory._match = meta.match;
          }
        }

        const orderedResult = hasCustomOrder
          ? result
          : rankedIds
              .map((id) => result.find((row) => row?.memory?._id === id))
              .filter((row): row is Record<string, any> => Boolean(row));

        return jsonResult(orderedResult);
      }

      case 'create_memory': {
        if (!isCreateMemoryArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, 'Invalid create_memory arguments');
        }

        const properties = {
          ...args.properties,
          created_at: args.properties.created_at || new Date().toISOString()
        };

        const result = await neo4jClient.createNode(args.label, properties);
        await embedNodeIfPossible(neo4jClient, embedder, result?.memory, args.label, 'create_memory');
        return jsonResult(result);
      }

      case 'create_connection': {
        if (!isCreateConnectionArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, 'Invalid create_connection arguments');
        }

        const result = await neo4jClient.createRelationship(
          args.fromMemoryId,
          args.toMemoryId,
          args.type,
          args.properties || { created_at: new Date().toISOString() }
        );

        return jsonResult(result);
      }

      case 'update_memory': {
        if (!isUpdateMemoryArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, 'Invalid update_memory arguments');
        }

        const result = await neo4jClient.updateNode(args.nodeId, args.properties);
        const label = Array.isArray(result?.memory?._labels) && typeof result.memory._labels[0] === 'string'
          ? result.memory._labels[0]
          : 'Memory';
        await embedNodeIfPossible(neo4jClient, embedder, result?.memory, label, 'update_memory');
        return jsonResult(result);
      }

      case 'update_connection': {
        if (!isUpdateConnectionArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, 'Invalid update_connection arguments');
        }

        const result = await neo4jClient.updateRelationship(args.fromMemoryId, args.toMemoryId, args.type, args.properties);
        return jsonResult(result);
      }

      case 'delete_memory': {
        if (!isDeleteMemoryArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, 'Invalid delete_memory arguments');
        }

        const result = await neo4jClient.deleteNode(args.nodeId);
        return jsonResult(result);
      }

      case 'delete_connection': {
        if (!isDeleteConnectionArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, 'Invalid delete_connection arguments');
        }

        const result = await neo4jClient.deleteRelationship(args.fromMemoryId, args.toMemoryId, args.type);
        return jsonResult(result);
      }

      case 'list_memory_labels': {
        if (!isListMemoryLabelsArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, 'Invalid list_memory_labels arguments');
        }

        const query = `
          MATCH (memory)
          WITH labels(memory) AS nodeLabels
          UNWIND nodeLabels AS label
          WITH label, count(*) AS count
          ORDER BY count DESC, label
          RETURN collect({label: label, count: count}) AS labels, sum(count) AS totalMemories
        `;

        const result = await neo4jClient.executeQuery(query, {});
        return jsonResult(result);
      }

      case 'query_memories': {
        if (!isQueryMemoriesArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, 'Invalid query_memories arguments');
        }

        if (READ_ONLY_CYPHER_RE.test(args.cypher)) {
          throw new McpError(ErrorCode.InvalidParams, 'query_memories only supports read-only Cypher');
        }

        const result = await neo4jClient.executeQuery(args.cypher, args.params ?? {});
        return jsonResult(result.slice(0, 200));
      }

      case 'memory_stats': {
        if (!isMemoryStatsArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, 'Invalid memory_stats arguments');
        }

        const [nodeRow] = await neo4jClient.executeQuery<{ count: number }>(
          `MATCH (n)
           WHERE coalesce(n.status, '') <> 'archived'
           RETURN count(n) AS count`
        );
        const [relationshipRow] = await neo4jClient.executeQuery<{ count: number }>(
          'MATCH ()-[r]->() RETURN count(r) AS count'
        );
        const labelRows = await neo4jClient.executeQuery<{ label: string; count: number }>(
          `MATCH (n)
           WHERE coalesce(n.status, '') <> 'archived'
           UNWIND labels(n) AS label
           RETURN label, count(*) AS count
           ORDER BY label`
        );
        const relationshipTypeRows = await neo4jClient.executeQuery<{ type: string; count: number }>(
          'MATCH ()-[r]->() RETURN type(r) AS type, count(r) AS count ORDER BY type'
        );
        const [orphanRow] = await neo4jClient.executeQuery<{ count: number }>(
          `MATCH (n)
           WHERE coalesce(n.status, '') <> 'archived'
             AND NOT (n)--()
           RETURN count(n) AS count`
        );

        let embedded = 0;
        let embedderId: string | null = null;
        if (embedder) {
          embedderId = embedder.id;
          const [embeddedRow] = await neo4jClient.executeQuery<{ count: number }>(
            `MATCH (n)
             WHERE coalesce(n.status, '') <> 'archived'
               AND n.embedding_model = $model
             RETURN count(n) AS count`,
            { model: embedder.id }
          );
          embedded = embeddedRow?.count ?? 0;
        }

        return jsonResult({
          nodes: nodeRow?.count ?? 0,
          relationships: relationshipRow?.count ?? 0,
          labels: Object.fromEntries(labelRows.map((row) => [row.label, row.count])),
          relationship_types: Object.fromEntries(relationshipTypeRows.map((row) => [row.type, row.count])),
          embedded,
          embedder: embedderId,
          orphans: orphanRow?.count ?? 0
        });
      }

      case 'dream': {
        if (!isDreamArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, 'Invalid dream arguments');
        }

        const dryRun = args.dry_run ?? false;
        const notes: string[] = [];

        const labelRows = await neo4jClient.executeQuery<{ label: string }>('CALL db.labels() YIELD label RETURN label ORDER BY label');
        let relabelled = 0;

        for (const row of labelRows) {
          const sourceLabel = row.label;
          if (!isAllLowercase(sourceLabel)) {
            continue;
          }

          const targetLabel = capitalizeLabel(sourceLabel);
          if (targetLabel === sourceLabel) {
            continue;
          }

          const escapedSource = escapeIdentifier(sourceLabel);
          const escapedTarget = escapeIdentifier(targetLabel);

          if (dryRun) {
            const [countRow] = await neo4jClient.executeQuery<{ count: number }>(
              `MATCH (n:\`${escapedSource}\`) RETURN count(n) AS count`
            );
            relabelled += countRow?.count ?? 0;
          } else {
            const [countRow] = await neo4jClient.executeQuery<{ count: number }>(
              `MATCH (n:\`${escapedSource}\`)
               REMOVE n:\`${escapedSource}\`
               SET n:\`${escapedTarget}\`
               RETURN count(n) AS count`
            );
            relabelled += countRow?.count ?? 0;
          }
        }

        const duplicateRows = await neo4jClient.executeQuery<DuplicateNodeRow>(
          `MATCH (n)
           WHERE coalesce(n.status, '') <> 'archived' AND n.name IS NOT NULL
           RETURN id(n) AS id,
                  labels(n)[0] AS label,
                  n.name AS name,
                  n.created_at AS created_at,
                  COUNT { (n)--() } AS rel_count
           ORDER BY labels(n)[0], toLower(n.name), n.created_at, id(n)`
        );
        const duplicates = groupDuplicates(duplicateRows);

        let apocAvailable = true;
        try {
          await neo4jClient.executeQuery('RETURN apoc.version() AS v');
        } catch (error) {
          apocAvailable = false;
        }

        let merged = 0;
        if (!apocAvailable) {
          if (duplicates.length > 0) {
            notes.push(`APOC unavailable; duplicate names found: ${duplicates.map((group) => `${group[0].effectiveLabel}/${group[0].name}`).join(', ')}`);
          }
        } else {
          for (const group of duplicates) {
            const [keep, ...rest] = group;
            merged += rest.length;

            if (dryRun) {
              continue;
            }

            for (const duplicate of rest) {
              await neo4jClient.executeQuery(
                `MATCH (keep) WHERE id(keep) = $keepId
                 MATCH (dup) WHERE id(dup) = $dupId
                 CALL apoc.refactor.mergeNodes([keep, dup], {properties: 'discard', mergeRels: true})
                 YIELD node
                 RETURN count(node) AS count`,
                {
                  keepId: neo4j.int(keep.id),
                  dupId: neo4j.int(duplicate.id)
                }
              );
            }
          }
        }

        let reembedded = 0;
        if (embedder) {
          const nodesToEmbed = await neo4jClient.executeQuery<SearchCandidate>(
            `MATCH (n)
             WHERE n.embedding_model IS NULL OR n.embedding_model <> $model OR n.name_embedding IS NULL
             RETURN id(n) AS id, labels(n)[0] AS label, properties(n) AS props
             ORDER BY id(n)`,
            { model: embedder.id }
          );

          if (dryRun) {
            reembedded = nodesToEmbed.length;
          } else if (nodesToEmbed.length > 0) {
            try {
              for (let index = 0; index < nodesToEmbed.length; index += 50) {
                const batch = nodesToEmbed.slice(index, index + 50).map((candidate) => ({
                  id: candidate.id,
                  label: candidate.label || 'Memory',
                  props: candidate.props || {}
                }));
                reembedded += await persistCandidateEmbeddings(neo4jClient, embedder, batch);
              }
            } catch (error) {
              console.error('Embedding unavailable for dream:', error);
            }
          }
        }

        const [currentOrphanRow] = await neo4jClient.executeQuery<{ count: number }>(
          `MATCH (n)
           WHERE coalesce(n.status, '') <> 'archived'
             AND NOT (n)--()
           RETURN count(n) AS count`
        );
        const orphans = dryRun
          ? simulateOrphansAfterMerge(currentOrphanRow?.count ?? 0, duplicates)
          : currentOrphanRow?.count ?? 0;

        return jsonResult({
          dry_run: dryRun,
          relabelled,
          merged,
          reembedded,
          orphans,
          apoc_available: apocAvailable,
          notes
        });
      }

      case 'get_guidance': {
        if (!isGetGuidanceArgs(args)) {
          throw new McpError(ErrorCode.InvalidParams, 'Invalid get_guidance arguments');
        }

        const topic = typeof args === 'object' && args !== null ? (args as { topic?: string }).topic : undefined;
        return {
          content: [
            {
              type: 'text',
              text: getGuidanceContent(topic),
            },
          ],
        };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    console.error('Error executing tool:', error);
    return {
      content: [
        {
          type: 'text',
          text: error instanceof Error ? error.message : 'Unknown error occurred',
        },
      ],
      isError: true,
    };
  }
}

async function rankCandidates(
  neo4jClient: Neo4jClient,
  candidates: SearchCandidate[],
  query: string,
  requestedMode: SearchMode,
  threshold: number,
  embedder: Embedder | null
): Promise<Ranked[]> {
  const trimmedQuery = query.trim();
  let effectiveMode = requestedMode;
  let queryEmbedding: number[] | undefined;

  if (trimmedQuery && requestedMode !== 'keyword') {
    if (!embedder) {
      effectiveMode = 'keyword';
    } else {
      try {
        const lazyBatch = getLazyEmbedBatchSize();
        const candidatesToEmbed = candidates.filter((candidate) => needsEmbedding(candidate.props, embedder.id)).slice(0, lazyBatch);

        if (candidatesToEmbed.length > 0) {
          await persistCandidateEmbeddings(neo4jClient, embedder, candidatesToEmbed);
        }

        [queryEmbedding] = await embedder.embed([trimmedQuery]);
      } catch (error) {
        console.error('Embedding unavailable for search_memories:', error);
        effectiveMode = 'keyword';
        queryEmbedding = undefined;
      }
    }
  }

  return rank(candidates, {
    query,
    mode: effectiveMode,
    queryEmbedding,
    threshold,
    modelId: embedder?.id
  });
}

async function persistCandidateEmbeddings(
  neo4jClient: Neo4jClient,
  embedder: Embedder,
  candidates: SearchCandidate[]
): Promise<number> {
  const vectors = await embedNodes(embedder, candidates);
  const embeddedAt = new Date().toISOString();
  let persisted = 0;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const { embedding, name_embedding } = vectors[index];
    if (embedding.length === 0) {
      continue;
    }

    await neo4jClient.executeQuery(EMBED_NODE_CYPHER, {
      id: neo4j.int(candidate.id),
      embedding,
      nameEmbedding: name_embedding,
      model: embedder.id,
      embeddedAt
    });

    Object.assign(candidate.props, { embedding, name_embedding, embedding_model: embedder.id, embedded_at: embeddedAt });
    persisted += 1;
  }

  return persisted;
}

async function embedNodeIfPossible(
  neo4jClient: Neo4jClient,
  embedder: Embedder | null,
  memory: Record<string, any> | undefined,
  label: string,
  toolName: string
): Promise<void> {
  if (!embedder || !memory || typeof memory._id !== 'number') {
    return;
  }

  try {
    const [{ embedding, name_embedding }] = await embedNodes(embedder, [{ label, props: toNodeProperties(memory) }]);
    if (embedding.length === 0) {
      return;
    }

    const embeddedAt = new Date().toISOString();
    await neo4jClient.executeQuery(EMBED_NODE_CYPHER, {
      id: neo4j.int(memory._id),
      embedding,
      nameEmbedding: name_embedding,
      model: embedder.id,
      embeddedAt
    });

    Object.assign(memory, { embedding, name_embedding, embedding_model: embedder.id, embedded_at: embeddedAt });
  } catch (error) {
    console.error(`Embedding unavailable for ${toolName}:`, error);
  }
}

async function fetchMemories(
  neo4jClient: Neo4jClient,
  memoryIds: number[],
  depth: number,
  orderBy: string,
  limit: number
): Promise<Record<string, any>[]> {
  let finalQuery = `
    MATCH (memory)
    WHERE id(memory) IN $memoryIds
  `;

  if (depth > 0) {
    finalQuery += `
      OPTIONAL MATCH path = (memory)-[*1..${depth}]-(related)
      RETURN memory, collect(DISTINCT {
        memory: related,
        relationship: relationships(path)[0],
        distance: length(path)
      }) AS connections
      ORDER BY ${orderBy}
      LIMIT ${limit}
    `;
  } else {
    finalQuery += `
      RETURN memory, [] AS connections
      ORDER BY ${orderBy}
      LIMIT ${limit}
    `;
  }

  return neo4jClient.executeQuery(finalQuery, { memoryIds });
}

function jsonResult(value: unknown): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(scrub(value), null, 2),
      },
    ],
  };
}

/** Stale when embedded by another model/provider, or before the name vector was introduced. */
function needsEmbedding(props: Record<string, any>, modelId: string): boolean {
  return props.embedding_model !== modelId || !Array.isArray(props.name_embedding);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getLazyEmbedBatchSize(): number {
  const raw = Number.parseInt(process.env.REVERIE_LAZY_EMBED_BATCH ?? '100', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 100;
}

function toNodeProperties(memory: Record<string, any>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(memory).filter(([key]) => !key.startsWith('_')));
}

function isAllLowercase(value: string): boolean {
  return value.length > 0 && value === value.toLowerCase() && value !== value.toUpperCase();
}

function capitalizeLabel(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function escapeIdentifier(value: string): string {
  return value.replace(/`/g, '``');
}

function groupDuplicates(rows: DuplicateNodeRow[]): GroupedDuplicateNode[][] {
  const byGroup = new Map<string, GroupedDuplicateNode[]>();

  for (const row of rows) {
    const effectiveLabel = isAllLowercase(row.label) ? capitalizeLabel(row.label) : row.label;
    const node: GroupedDuplicateNode = {
      ...row,
      effectiveLabel
    };
    const key = `${effectiveLabel}\u0000${row.name.toLowerCase()}`;
    const group = byGroup.get(key) ?? [];
    group.push(node);
    byGroup.set(key, group);
  }

  return [...byGroup.values()]
    .filter((group) => group.length > 1)
    .map((group) => [...group].sort(compareDuplicateNodes))
    .sort((left, right) => {
      const leftKey = `${left[0].effectiveLabel}/${left[0].name.toLowerCase()}`;
      const rightKey = `${right[0].effectiveLabel}/${right[0].name.toLowerCase()}`;
      return leftKey.localeCompare(rightKey);
    });
}

function compareDuplicateNodes(left: GroupedDuplicateNode, right: GroupedDuplicateNode): number {
  const leftCreatedAt = left.created_at ?? '';
  const rightCreatedAt = right.created_at ?? '';
  if (leftCreatedAt !== rightCreatedAt) {
    return leftCreatedAt.localeCompare(rightCreatedAt);
  }
  return left.id - right.id;
}

function simulateOrphansAfterMerge(currentOrphans: number, duplicates: GroupedDuplicateNode[][]): number {
  let orphans = currentOrphans;

  for (const group of duplicates) {
    const orphanCount = group.filter((node) => node.rel_count === 0).length;
    if (orphanCount === 0) {
      continue;
    }

    const allOrphans = orphanCount === group.length;
    orphans -= allOrphans ? orphanCount - 1 : orphanCount;
  }

  return orphans;
}
