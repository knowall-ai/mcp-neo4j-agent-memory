/**
 * Activation log: an append-only JSONL trail of what the graph is doing (recall, remember,
 * connect, forget, dream.start/dream.end), so the Agents Portal Brain view can light up the
 * nodes an agent is "thinking about". Nothing here touches Neo4j: the graph only holds curated
 * entities, never a record of what was looked at.
 *
 * Path: $REVERIE_EVENTS_PATH (default ~/.reverie/events.jsonl); set it to an empty string to
 * disable. The file is trimmed to the newest MAX_LINES whenever it passes MAX_BYTES.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ActivationEvent {
  /** epoch seconds */
  ts: number;
  kind: string;
  [key: string]: unknown;
}

export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_LINES = 5000;

let warned = false;

export function eventsPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.REVERIE_EVENTS_PATH;
  if (raw === undefined) {
    return path.join(os.homedir(), '.reverie', 'events.jsonl');
  }
  const trimmed = raw.trim();
  return trimmed ? expandHome(trimmed) : null;
}

export function expandHome(value: string): string {
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

/** Append one event. Never throws: the graph must keep working when the log cannot be written. */
export function emit(kind: string, data: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = process.env): void {
  const file = eventsPath(env);
  if (!file) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const record: ActivationEvent = { ts: Date.now() / 1000, kind, ...data };
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
    if (fs.statSync(file).size > MAX_BYTES) {
      trim(file);
    }
  } catch (error) {
    if (!warned) {
      warned = true;
      console.error('Activation log not written:', error instanceof Error ? error.message : error);
    }
  }
}

function trim(file: string): void {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).slice(-MAX_LINES);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, lines.join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function parseLine(line: string): ActivationEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && typeof parsed.kind === 'string' ? (parsed as ActivationEvent) : null;
  } catch {
    return null;
  }
}

/** Events appended after byte `offset`, and the new offset. Tolerates a trimmed (shrunk) file. */
export function readSince(file: string, offset: number): { events: ActivationEvent[]; offset: number } {
  if (!fs.existsSync(file)) {
    return { events: [], offset: 0 };
  }
  const size = fs.statSync(file).size;
  const start = size < offset ? 0 : offset;
  if (size === start) {
    return { events: [], offset: start };
  }
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    // Only consume complete lines; a partial trailing line is picked up on the next read.
    const complete = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1);
    const events = complete.split('\n').map(parseLine).filter((event): event is ActivationEvent => event !== null);
    return { events, offset: start + Buffer.byteLength(complete, 'utf8') };
  } finally {
    fs.closeSync(fd);
  }
}

/** The newest `limit` events, oldest first. */
export function tail(file: string, limit = 50): ActivationEvent[] {
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .slice(-limit)
    .map(parseLine)
    .filter((event): event is ActivationEvent => event !== null);
}
