/**
 * Brain view data for the Agents Portal: graph snapshots, snapshot diffs and the agent's
 * awake/dreaming state. No HTTP here; `http-server.ts` exposes it, which keeps this testable
 * without a server or a database. Field names are the portal's contract, so they stay camelCase.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import neo4j from 'neo4j-driver';
import { ActivationEvent, eventsPath, expandHome, tail } from './events.js';

export interface BrainNode {
  id: string;
  label: string;
  labels: string[];
  name: string;
  degree: number;
  /** epoch seconds */
  updatedAt: number;
  /** epoch seconds */
  createdAt: number;
  props: Record<string, string | number | boolean | null | (string | number)[]>;
}

export interface BrainRel {
  id: string;
  type: string;
  source: string;
  target: string;
  /** epoch seconds */
  updatedAt: number;
}

export interface BrainStats {
  nodeCount: number;
  relCount: number;
  labels: Record<string, number>;
  relTypes: Record<string, number>;
  shown: number;
}

export interface HostStats {
  cpuPercent: number | null;
  load1: number | null;
  memPercent: number | null;
  memUsedGb: number | null;
  memTotalGb: number | null;
}

export interface PresenceStats {
  /** usage-stats.json as defined by knowall-ai/agent-presence docs/HUD-CONTRACT.md, passed through untouched */
  usage: Record<string, unknown> | null;
  /** boost-state.json from the same contract */
  boost: Record<string, unknown> | null;
}

export interface BrainState extends HostStats, PresenceStats {
  dreaming: boolean;
  lastActivityAt: number | null;
  lastDreamAt: number | null;
  lastDreamName: string | null;
  recentReads: number;
  recentWrites: number;
  eventsAvailable: boolean;
}

export interface BrainSnapshot {
  nodes: BrainNode[];
  rels: BrainRel[];
  stats: BrainStats;
  /** epoch seconds */
  generatedAt: number;
}

export interface BrainDiff {
  nodesAdded: BrainNode[];
  nodesUpdated: BrainNode[];
  nodesRemoved: string[];
  relsAdded: BrainRel[];
  relsRemoved: string[];
  stats?: BrainStats;
}

export type Run = (cypher: string, params?: Record<string, unknown>) => Promise<Record<string, any>[]>;

export const MAX_LIMIT = 1500;
export const DEFAULT_LIMIT = 400;
const DREAM_WINDOW_SECONDS = 30 * 60;
const RECENT_WINDOW_SECONDS = 15 * 60;
const USAGE_MAX_AGE_SECONDS = 900;
const PROP_MAX_CHARS = 300;
const PROP_MAX_KEYS = 24;
const PROP_MAX_ITEMS = 12;
const HIDDEN_PROPS = new Set(['embedding', 'name_embedding', 'vector', 'embedding_model', 'embedded_at']);

// Ids are the same numeric ids the MCP tools expose (as strings), so activation events and
// snapshot nodes line up in the portal.
const NODE_QUERY = `
MATCH (n)
WHERE n.status IS NULL OR n.status <> 'archived'
OPTIONAL MATCH (n)-[r]-()
WITH n, count(r) AS degree
ORDER BY degree DESC, coalesce(n.updated_at, n.created_at) DESC
LIMIT $limit
RETURN toString(id(n)) AS id, labels(n) AS labels, n.name AS name, degree,
       n.updated_at AS updated_at, n.created_at AS created_at, properties(n) AS props`;

const REL_QUERY = `
MATCH (a)-[r]->(b)
WHERE toString(id(a)) IN $ids AND toString(id(b)) IN $ids
RETURN toString(id(r)) AS id, type(r) AS type, toString(id(a)) AS source, toString(id(b)) AS target,
       r.updated_at AS updated_at, r.created_at AS created_at`;

const LABEL_STATS_QUERY = `
MATCH (n) WHERE n.status IS NULL OR n.status <> 'archived'
RETURN head(labels(n)) AS label, count(*) AS n`;

const REL_STATS_QUERY = 'MATCH ()-[r]->() RETURN type(r) AS type, count(*) AS n';

export function clampLimit(value: unknown, fallback = DEFAULT_LIMIT): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.trunc(parsed), MAX_LIMIT));
}

/** Epoch seconds from whatever a graph stores: epoch seconds or milliseconds, ISO strings, Neo4j temporals (already strings). */
export function toEpochSeconds(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value >= 1e12 ? value / 1000 : value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      return toEpochSeconds(Number(trimmed));
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? Math.round(parsed / 1000) : 0;
  }
  if (value && typeof value === 'object' && typeof (value as { toString?: unknown }).toString === 'function') {
    const text = String(value);
    return text && text !== '[object Object]' ? toEpochSeconds(text) : 0;
  }
  return 0;
}

/** Primitives only, short strings only, a bounded number of keys; vectors never leave the server. */
export function cleanProps(props: Record<string, unknown>): BrainNode['props'] {
  const out: BrainNode['props'] = {};
  for (const [key, value] of Object.entries(props ?? {})) {
    if (HIDDEN_PROPS.has(key) || Object.keys(out).length >= PROP_MAX_KEYS) {
      continue;
    }
    if (value === null || typeof value === 'boolean') {
      out[key] = value;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
    } else if (typeof value === 'string') {
      out[key] = value.length <= PROP_MAX_CHARS ? value : `${value.slice(0, PROP_MAX_CHARS)}…`;
    } else if (Array.isArray(value) && value.every((item) => typeof item === 'string' || typeof item === 'number')) {
      out[key] = (value as (string | number)[]).slice(0, PROP_MAX_ITEMS);
    }
  }
  return out;
}

/** Nodes (most connected / most recent first), the relationships among them, and totals. */
export async function snapshot(run: Run, limit = DEFAULT_LIMIT): Promise<BrainSnapshot> {
  const nodeRows = await run(NODE_QUERY, { limit: neo4j.int(clampLimit(limit)) });
  const nodes: BrainNode[] = nodeRows.map((row) => {
    const labels = Array.isArray(row.labels) ? row.labels.map(String) : [];
    const id = String(row.id);
    const createdAt = toEpochSeconds(row.created_at);
    return {
      id,
      labels,
      label: labels[0] ?? 'Unknown',
      name: row.name === null || row.name === undefined || row.name === '' ? id : String(row.name),
      degree: Number(row.degree ?? 0),
      updatedAt: row.updated_at === null || row.updated_at === undefined ? createdAt : toEpochSeconds(row.updated_at),
      createdAt,
      props: cleanProps(row.props ?? {})
    };
  });
  const ids = nodes.map((node) => node.id);
  const relRows = ids.length > 0 ? await run(REL_QUERY, { ids }) : [];
  const rels: BrainRel[] = relRows.map((row) => ({
    id: String(row.id),
    type: String(row.type),
    source: String(row.source),
    target: String(row.target),
    updatedAt: toEpochSeconds(row.updated_at ?? row.created_at)
  }));
  const labels: Record<string, number> = {};
  for (const row of await run(LABEL_STATS_QUERY)) {
    labels[row.label ? String(row.label) : 'Unknown'] = Number(row.n ?? 0);
  }
  const relTypes: Record<string, number> = {};
  for (const row of await run(REL_STATS_QUERY)) {
    relTypes[String(row.type)] = Number(row.n ?? 0);
  }
  return {
    nodes,
    rels,
    stats: {
      nodeCount: Object.values(labels).reduce((sum, n) => sum + n, 0),
      relCount: Object.values(relTypes).reduce((sum, n) => sum + n, 0),
      labels,
      relTypes,
      shown: nodes.length
    },
    generatedAt: Date.now() / 1000
  };
}

/** What changed between two snapshots: added/updated/removed nodes and added/removed relationships. */
export function diffSnapshot(prev: BrainSnapshot, curr: BrainSnapshot): BrainDiff {
  const prevNodes = new Map(prev.nodes.map((node) => [node.id, node]));
  const currNodes = new Map(curr.nodes.map((node) => [node.id, node]));
  const prevRels = new Map(prev.rels.map((rel) => [rel.id, rel]));
  const currRels = new Map(curr.rels.map((rel) => [rel.id, rel]));
  return {
    nodesAdded: curr.nodes.filter((node) => !prevNodes.has(node.id)),
    nodesUpdated: curr.nodes.filter((node) => {
      const before = prevNodes.get(node.id);
      return before !== undefined && (before.updatedAt !== node.updatedAt || before.degree !== node.degree);
    }),
    nodesRemoved: prev.nodes.filter((node) => !currNodes.has(node.id)).map((node) => node.id),
    relsAdded: curr.rels.filter((rel) => !prevRels.has(rel.id)),
    relsRemoved: prev.rels.filter((rel) => !currRels.has(rel.id)).map((rel) => rel.id)
  };
}

export function isEmptyDiff(diff: BrainDiff): boolean {
  return (
    diff.nodesAdded.length === 0 &&
    diff.nodesUpdated.length === 0 &&
    diff.nodesRemoved.length === 0 &&
    diff.relsAdded.length === 0 &&
    diff.relsRemoved.length === 0
  );
}

/** Newest dream diary entry (*.md in REVERIE_DREAMS_DIR) by modification time; null when the variable is unset. */
export function latestDream(env: NodeJS.ProcessEnv = process.env): { name: string; at: number } | null {
  const raw = env.REVERIE_DREAMS_DIR?.trim();
  if (!raw) {
    return null;
  }
  const dir = expandHome(raw);
  try {
    if (!fs.statSync(dir).isDirectory()) {
      return null;
    }
    let newest: { name: string; at: number } | null = null;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith('.md')) {
        continue;
      }
      const at = fs.statSync(path.join(dir, entry)).mtimeMs / 1000;
      if (!newest || at > newest.at) {
        newest = { name: entry.slice(0, -3), at };
      }
    }
    return newest;
  } catch {
    return null;
  }
}

let cpuLast: { idle: number; total: number } | null = null;

/** Overall CPU busy percentage since the previous call (Linux /proc/stat); null on the first call or elsewhere. */
export function cpuPercent(): number | null {
  let fields: number[];
  try {
    fields = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1, 8).map(Number);
  } catch {
    return null;
  }
  if (fields.length < 5 || fields.some((n) => !Number.isFinite(n))) {
    return null;
  }
  const idle = fields[3] + fields[4];
  const total = fields.reduce((sum, n) => sum + n, 0);
  const prev = cpuLast;
  cpuLast = { idle, total };
  if (!prev || total === prev.total) {
    return null;
  }
  return round((100 * (1 - (idle - prev.idle) / (total - prev.total))), 1);
}

/** CPU %, 1-minute load and memory use of the agent's VM, for the telemetry panel. Nulls where unavailable. */
export function hostStats(): HostStats {
  const out: HostStats = { cpuPercent: cpuPercent(), load1: null, memPercent: null, memUsedGb: null, memTotalGb: null };
  try {
    out.load1 = round(os.loadavg()[0], 2);
  } catch {
    out.load1 = null;
  }
  try {
    const info: Record<string, number> = {};
    for (const line of fs.readFileSync('/proc/meminfo', 'utf8').split('\n')) {
      const [key, rest] = line.split(':');
      if (key && rest) {
        info[key.trim()] = Number(rest.trim().split(/\s+/)[0]);
      }
    }
    const total = info.MemTotal;
    const available = info.MemAvailable;
    if (total > 0 && Number.isFinite(available)) {
      out.memPercent = round(100 * (1 - available / total), 1);
      out.memTotalGb = round(total / 1048576, 1);
      out.memUsedGb = round((total - available) / 1048576, 1);
    }
  } catch {
    // not Linux, or /proc unreadable
  }
  return out;
}

function readJsonFile(env: NodeJS.ProcessEnv, variable: string, fallback: string, maxAgeSeconds?: number): Record<string, unknown> | null {
  const raw = env[variable] === undefined ? fallback : env[variable]!.trim();
  if (!raw) {
    return null;
  }
  const file = expandHome(raw);
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) {
      return null;
    }
    if (maxAgeSeconds !== undefined && Date.now() / 1000 - stat.mtimeMs / 1000 > maxAgeSeconds) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** usage-stats.json (fresh within 15 min) and boost-state.json written by the agent's Presence stack. */
export function presenceStats(env: NodeJS.ProcessEnv = process.env): PresenceStats {
  const home = os.homedir();
  return {
    usage: readJsonFile(env, 'REVERIE_USAGE_STATS_PATH', path.join(home, 'call-transcripts', 'usage-stats.json'), USAGE_MAX_AGE_SECONDS),
    boost: readJsonFile(env, 'REVERIE_BOOST_STATE_PATH', path.join(home, 'call-transcripts', 'boost-state.json'))
  };
}

/**
 * Awake/dreaming signals from the activation log (and the dream diary when one is configured):
 * dreaming = a dream.start newer than the last dream.end within the last 30 minutes;
 * lastActivityAt = the newest event of any kind; recent counts cover the last 15 minutes.
 */
export function state(events?: ActivationEvent[], now?: number, env: NodeJS.ProcessEnv = process.env): BrainState {
  const at = now ?? Date.now() / 1000;
  const file = eventsPath(env);
  const list = events ?? (file ? tail(file, 200) : []);
  const ts = (event: ActivationEvent) => (typeof event.ts === 'number' && Number.isFinite(event.ts) ? event.ts : 0);
  const newest = (kind?: string) =>
    list.filter((event) => kind === undefined || event.kind === kind).reduce<number | null>((max, event) => (max === null || ts(event) > max ? ts(event) : max), null);
  const lastActivity = newest();
  const dreamStart = newest('dream.start');
  const dreamEnd = newest('dream.end');
  const dreaming = dreamStart !== null && at - dreamStart < DREAM_WINDOW_SECONDS && (dreamEnd === null || dreamEnd < dreamStart);
  const diary = latestDream(env);
  const lastDreamEvent = [...list].reverse().find((event) => event.kind === 'dream.end') ?? [...list].reverse().find((event) => event.kind === 'dream.start');
  const recent = list.filter((event) => at - ts(event) < RECENT_WINDOW_SECONDS);
  return {
    dreaming,
    lastActivityAt: lastActivity,
    lastDreamAt: diary ? diary.at : dreamEnd ?? dreamStart,
    lastDreamName: diary ? diary.name : typeof lastDreamEvent?.name === 'string' ? lastDreamEvent.name : null,
    recentReads: recent.filter((event) => event.kind === 'recall').length,
    recentWrites: recent.filter((event) => event.kind === 'remember' || event.kind === 'connect' || event.kind === 'forget').length,
    eventsAvailable: file !== null,
    ...hostStats(),
    ...presenceStats(env)
  };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
