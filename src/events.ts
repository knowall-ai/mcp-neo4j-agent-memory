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
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 2_000;

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
      // Both caps are checked on every append (a newline count over a ≤5 MB file is ~1 ms), so
      // the log never holds more than MAX_LINES lines or MAX_BYTES bytes after a write returns.
      if (fs.statSync(file).size > MAX_BYTES || countLines(file) > MAX_LINES) {
        trim(file);
      }
    };
    // Several Reverie processes (stdio + serve) may share one log: append and trim run under a
    // lock so a trim never drops another process's append. Never append outside the lock; if it
    // cannot be taken within LOCK_WAIT_MS the event is dropped and reported once.
    if (!withLock(file, append)) {
      throw new Error('activation log lock not acquired');
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
  const buffer = fs.readFileSync(file);
  let count = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 10) {
      count += 1;
    }
  }
  return count;
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'; // exists, not ours
  }
}

/**
 * Cross-process lock via an exclusive lock file holding the owner's pid. A lock is only broken
 * when its owner is gone, or when it is older than LOCK_STALE_MS (a hung holder); an unlink is
 * done only by the owner or by the breaker of a dead lock, never by a waiter.
 */
function withLock(file: string, fn: () => void): boolean {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    let fd: number;
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        return false;
      }
      try {
        const owner = Number.parseInt(fs.readFileSync(lock, 'utf8').trim(), 10);
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if ((Number.isInteger(owner) && !processAlive(owner)) || age > LOCK_STALE_MS) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch {
        continue; // released between our checks
      }
      sleepMs(5);
      continue;
    }
    try {
      fs.writeSync(fd, String(process.pid));
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
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).slice(-MAX_LINES);
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

/** Where a reader is in the log: byte offset within a specific file identity, and the newest event time already seen. */
export interface LogCursor {
  offset: number;
  /** inode of the file the offset refers to; a trim renames a new file into place, changing it */
  ino: number | null;
  /** ts of the newest event delivered, so a re-read of a rewritten file skips what was already sent */
  lastTs: number;
}

export const START_CURSOR: LogCursor = { offset: 0, ino: null, lastTs: 0 };

/**
 * Events appended since `cursor`, and the advanced cursor. Survives trims (the file is replaced,
 * so its inode changes): the rewritten file is re-read from the start and events not newer than
 * the last delivered one are skipped rather than replayed or lost.
 */
export function readSince(file: string, cursor: LogCursor): { events: ActivationEvent[]; cursor: LogCursor } {
  try {
    return readSinceUnsafe(file, cursor);
  } catch {
    return { events: [], cursor: { ...cursor, offset: 0, ino: null } }; // removed or rotated mid-read: start again next time
  }
}

function readSinceUnsafe(file: string, cursor: LogCursor): { events: ActivationEvent[]; cursor: LogCursor } {
  if (!fs.existsSync(file)) {
    return { events: [], cursor: { ...cursor, offset: 0, ino: null } };
  }
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const replaced = cursor.ino !== null && stat.ino !== cursor.ino;
    const start = replaced || stat.size < cursor.offset ? 0 : cursor.offset;
    if (stat.size === start) {
      return { events: [], cursor: { offset: start, ino: stat.ino, lastTs: cursor.lastTs } };
    }
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    // Only consume complete lines; a partial trailing line is picked up on the next read.
    const complete = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1);
    const all = complete.split('\n').map(parseLine).filter((event): event is ActivationEvent => event !== null);
    const events = start === 0 && cursor.lastTs > 0 ? all.filter((event) => event.ts > cursor.lastTs) : all;
    const lastTs = events.reduce((max, event) => (typeof event.ts === 'number' && event.ts > max ? event.ts : max), cursor.lastTs);
    return { events, cursor: { offset: start + Buffer.byteLength(complete, 'utf8'), ino: stat.ino, lastTs } };
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
