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
export const MAX_RECORD_BYTES = 64 * 1024;
const LINE_CHECK_EVERY = 250;
const LOCK_STALE_MS = 5_000;
const LOCK_TRIES = 50;

let warned = false;
let appendsSinceLineCheck = 0;

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
    const record: ActivationEvent = { ts: Date.now() / 1000, kind, ...data };
    const line = JSON.stringify(record) + '\n';
    if (Buffer.byteLength(line, 'utf8') > MAX_RECORD_BYTES) {
      return; // one runaway record must not blow the log's budget
    }
    // The log names what the agent knows, so it is private to the user (0700 dir, 0600 file).
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const append = () => {
      fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
      ensurePrivate(file);
      appendsSinceLineCheck += 1;
      const overBytes = fs.statSync(file).size > MAX_BYTES;
      const checkLines = appendsSinceLineCheck >= LINE_CHECK_EVERY;
      if (checkLines) {
        appendsSinceLineCheck = 0;
      }
      if (overBytes || (checkLines && countLines(file) > MAX_LINES)) {
        trim(file);
      }
    };
    // Several Reverie processes (stdio + serve) may share one log: append and trim under a lock so
    // a trim never drops another process's append. If the lock cannot be taken, append anyway
    // (O_APPEND is atomic) and leave trimming to a later call.
    if (!withLock(file, append)) {
      fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
    }
  } catch (error) {
    if (!warned) {
      warned = true;
      console.error('Activation log not written:', error instanceof Error ? error.message : error);
    }
  }
}

function ensurePrivate(file: string): void {
  try {
    if ((fs.statSync(file).mode & 0o077) !== 0) {
      fs.chmodSync(file, 0o600);
    }
  } catch {
    // best effort (e.g. filesystems without POSIX modes)
  }
}

function countLines(file: string): number {
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).length;
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Cross-process lock via an exclusive lock file; stale locks (a crashed holder) are broken after LOCK_STALE_MS. */
function withLock(file: string, fn: () => void): boolean {
  const lock = `${file}.lock`;
  for (let attempt = 0; attempt < LOCK_TRIES; attempt += 1) {
    let fd: number;
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        return false;
      }
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch {
        continue; // the holder released it between our checks
      }
      sleepMs(10);
      continue;
    }
    try {
      fn();
      return true;
    } finally {
      fs.closeSync(fd);
      try {
        fs.unlinkSync(lock);
      } catch {
        // already gone
      }
    }
  }
  return false;
}

/** Keep the newest records that fit both caps: at most MAX_LINES lines and MAX_BYTES / 2 bytes (so trims stay rare). Call under the lock. */
function trim(file: string): void {
  // Keep a margin under MAX_LINES so the count never exceeds the cap between line checks.
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).slice(-(MAX_LINES - LINE_CHECK_EVERY));
  const budget = MAX_BYTES / 2;
  let bytes = lines.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8') + 1, 0);
  let start = 0;
  while (start < lines.length && bytes > budget) {
    bytes -= Buffer.byteLength(lines[start], 'utf8') + 1;
    start += 1;
  }
  const kept = lines.slice(start);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, kept.length ? kept.join('\n') + '\n' : '', { encoding: 'utf8', mode: 0o600 });
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
  try {
    return readSinceUnsafe(file, offset);
  } catch {
    return { events: [], offset: 0 }; // removed or rotated between calls: start again next time
  }
}

function readSinceUnsafe(file: string, offset: number): { events: ActivationEvent[]; offset: number } {
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
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return []; // missing, unreadable or rotated away
  }
  return text
    .split('\n')
    .filter((line) => line.trim())
    .slice(-limit)
    .map(parseLine)
    .filter((event): event is ActivationEvent => event !== null);
}
