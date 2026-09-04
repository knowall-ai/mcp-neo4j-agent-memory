import { EMBEDDING_FIELDS } from './embeddings.js';

/** Above this many real properties a node is "bloated": facts are being piled on instead of modelled. */
export const DEFAULT_MAX_PROPERTIES = 30;
export const MAX_PROPERTIES_CAP = 500;

const HOUSEKEEPING = new Set<string>([...EMBEDDING_FIELDS, 'created_at', 'updated_at', 'status', 'archived_at']);
const DATE_SUFFIX_RE = /(_|-)\d{4}(_|-)\d{2}(_|-)\d{2}$/;
const LONG_TEXT = 120;

/** REVERIE_MAX_PROPERTIES must be a whole number in 1..MAX_PROPERTIES_CAP; anything else falls back to the default. */
export function maxProperties(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.REVERIE_MAX_PROPERTIES ?? '').trim();
  if (!/^\d+$/.test(raw)) {
    return DEFAULT_MAX_PROPERTIES;
  }
  const value = Number(raw);
  return value >= 1 && value <= MAX_PROPERTIES_CAP ? value : DEFAULT_MAX_PROPERTIES;
}

/** User-visible properties only: no `_id`-style metadata, timestamps, status or embedding fields. */
export function contentKeys(props: Record<string, unknown>): string[] {
  return Object.keys(props).filter((key) => !key.startsWith('_') && !HOUSEKEEPING.has(key));
}

/** Keys that look like facts or episodes rather than attributes: dated names, or long prose values. */
export function factLikeKeys(props: Record<string, unknown>): string[] {
  return contentKeys(props).filter((key) => {
    const value = props[key];
    return DATE_SUFFIX_RE.test(key) || (typeof value === 'string' && value.length > LONG_TEXT);
  });
}

export function bloatHint(name: string, count: number, limit: number): string {
  return `"${name}" now has ${count} properties (limit ${limit}). The graph maps entities and relationships; ` +
    'keep only durable attributes here. Fold dated facts and episodes into a short attribute, a relationship, ' +
    'or your notes. See get_guidance("best-practices").';
}
