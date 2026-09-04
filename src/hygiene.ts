import { EMBEDDING_FIELDS } from './embeddings.js';

/** Above this many real properties a node is "bloated": facts are being piled on instead of modelled. */
export const DEFAULT_MAX_PROPERTIES = 30;

const HOUSEKEEPING = new Set<string>([...EMBEDDING_FIELDS, 'created_at', 'updated_at', 'status', 'archived_at']);
const DATE_SUFFIX_RE = /(_|-)\d{4}(_|-)\d{2}(_|-)\d{2}$/;
const LONG_TEXT = 120;

export function maxProperties(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.REVERIE_MAX_PROPERTIES ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_PROPERTIES;
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
