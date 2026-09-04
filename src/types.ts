export interface Neo4jServerConfig {
  uri: string;
  username: string;
  password: string;
  database?: string;
}

export interface CreateMemoryArgs {
  label: string;
  properties: Record<string, any>;
}

export interface SearchMemoriesArgs {
  query?: string;
  label?: string;
  depth?: number;
  order_by?: string;
  limit?: number;
  since_date?: string;
  search_mode?: 'hybrid' | 'keyword' | 'semantic';
  similarity_threshold?: number;
}

export interface CreateConnectionArgs {
  fromMemoryId: number;
  toMemoryId: number;
  type: string;
  properties?: Record<string, any>;
}

export interface UpdateMemoryArgs {
  nodeId: number;
  properties: Record<string, any>;
}

export interface UpdateConnectionArgs {
  fromMemoryId: number;
  toMemoryId: number;
  type: string;
  properties: Record<string, any>;
}

export interface DeleteMemoryArgs {
  nodeId: number;
}

export interface DeleteConnectionArgs {
  fromMemoryId: number;
  toMemoryId: number;
  type: string;
}

export interface ListMemoryLabelsArgs {
  // No arguments needed for this tool
}

export interface QueryMemoriesArgs {
  cypher: string;
  params?: Record<string, any>;
}

export interface MemoryStatsArgs {
  // No arguments needed for this tool
}

export interface DreamArgs {
  dry_run?: boolean;
}

export const SEARCH_MAX_LIMIT = 200;
export const SEARCH_MAX_DEPTH = 5;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isIntegerInRange(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

export function isCreateMemoryArgs(args: unknown): args is CreateMemoryArgs {
  return typeof args === 'object' && args !== null && typeof (args as CreateMemoryArgs).label === 'string' && typeof (args as CreateMemoryArgs).properties === 'object';
}

const SEARCH_KEYS = ['query', 'label', 'depth', 'order_by', 'limit', 'since_date', 'search_mode', 'similarity_threshold'] as const;

export function isSearchMemoriesArgs(args: unknown): args is SearchMemoriesArgs {
  if (!isPlainObject(args) || !hasOnlyKeys(args, SEARCH_KEYS)) return false;
  const searchArgs = args as SearchMemoriesArgs;
  if (searchArgs.query !== undefined && typeof searchArgs.query !== 'string') return false;
  if (searchArgs.label !== undefined && typeof searchArgs.label !== 'string') return false;
  if (searchArgs.depth !== undefined && !isIntegerInRange(searchArgs.depth, 0, SEARCH_MAX_DEPTH)) return false;
  if (searchArgs.order_by !== undefined && typeof searchArgs.order_by !== 'string') return false;
  if (searchArgs.limit !== undefined && !isIntegerInRange(searchArgs.limit, 1, SEARCH_MAX_LIMIT)) return false;
  if (searchArgs.since_date !== undefined && typeof searchArgs.since_date !== 'string') return false;
  if (searchArgs.search_mode !== undefined && !['hybrid', 'keyword', 'semantic'].includes(searchArgs.search_mode)) return false;
  if (searchArgs.similarity_threshold !== undefined) {
    const threshold = searchArgs.similarity_threshold;
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) return false;
  }
  return true;
}

export function isCreateConnectionArgs(args: unknown): args is CreateConnectionArgs {
  return (
    typeof args === 'object' &&
    args !== null &&
    typeof (args as CreateConnectionArgs).fromMemoryId === 'number' &&
    typeof (args as CreateConnectionArgs).toMemoryId === 'number' &&
    typeof (args as CreateConnectionArgs).type === 'string'
  );
}

export function isUpdateMemoryArgs(args: unknown): args is UpdateMemoryArgs {
  return (
    typeof args === 'object' &&
    args !== null &&
    typeof (args as UpdateMemoryArgs).nodeId === 'number' &&
    typeof (args as UpdateMemoryArgs).properties === 'object'
  );
}

export function isUpdateConnectionArgs(args: unknown): args is UpdateConnectionArgs {
  return (
    typeof args === 'object' &&
    args !== null &&
    typeof (args as UpdateConnectionArgs).fromMemoryId === 'number' &&
    typeof (args as UpdateConnectionArgs).toMemoryId === 'number' &&
    typeof (args as UpdateConnectionArgs).type === 'string' &&
    typeof (args as UpdateConnectionArgs).properties === 'object'
  );
}

export function isDeleteMemoryArgs(args: unknown): args is DeleteMemoryArgs {
  return (
    typeof args === 'object' &&
    args !== null &&
    typeof (args as DeleteMemoryArgs).nodeId === 'number'
  );
}

export function isDeleteConnectionArgs(args: unknown): args is DeleteConnectionArgs {
  return (
    typeof args === 'object' &&
    args !== null &&
    typeof (args as DeleteConnectionArgs).fromMemoryId === 'number' &&
    typeof (args as DeleteConnectionArgs).toMemoryId === 'number' &&
    typeof (args as DeleteConnectionArgs).type === 'string'
  );
}

export function isListMemoryLabelsArgs(args: unknown): args is ListMemoryLabelsArgs {
  return typeof args === 'object' && args !== null;
}

export function isQueryMemoriesArgs(args: unknown): args is QueryMemoriesArgs {
  if (!isPlainObject(args) || !hasOnlyKeys(args, ['cypher', 'params'])) return false;
  const queryArgs = args as unknown as QueryMemoriesArgs;
  if (typeof queryArgs.cypher !== 'string' || queryArgs.cypher.trim() === '') return false;
  if (queryArgs.params !== undefined && !isPlainObject(queryArgs.params)) return false;
  return true;
}

export function isMemoryStatsArgs(args: unknown): args is MemoryStatsArgs {
  return isPlainObject(args) && hasOnlyKeys(args, []);
}

export function isDreamArgs(args: unknown): args is DreamArgs {
  if (!isPlainObject(args) || !hasOnlyKeys(args, ['dry_run'])) return false;
  const dreamArgs = args as DreamArgs;
  if (dreamArgs.dry_run !== undefined && typeof dreamArgs.dry_run !== 'boolean') return false;
  return true;
}
