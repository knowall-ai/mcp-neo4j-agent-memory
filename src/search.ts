import { cosine } from './embeddings.js';
import { contentKeys } from './hygiene.js';

export type SearchMode = 'hybrid' | 'keyword' | 'semantic';

export interface Candidate {
  id: number;
  props: Record<string, any>;
}

export interface Ranked {
  id: number;
  score: number;
  match: 'keyword' | 'semantic';
}

export function keywordMatches(query: string, props: Record<string, any>): boolean {
  const trimmedQuery = query.trim().toLowerCase();
  if (!trimmedQuery) {
    return true;
  }

  const words = trimmedQuery.split(/\s+/);

  // Only user content is searchable: timestamps, status and embedding fields never match.
  for (const key of contentKeys(props)) {
    const value = props[key];
    if (value === null || value === undefined) {
      continue;
    }

    const haystack = Array.isArray(value)
      ? value.map((item) => item?.toString() || '').join(' ').toLowerCase()
      : value.toString().toLowerCase();

    if (words.some((word) => haystack.includes(word))) {
      return true;
    }
  }

  return false;
}

export function rank(candidates: Candidate[], opts: {
  query: string;
  mode: SearchMode;
  queryEmbedding?: number[];
  threshold: number;
  modelId?: string;
}): Ranked[] {
  const trimmedQuery = opts.query.trim();

  if (!trimmedQuery) {
    return [...candidates]
      .map((candidate) => ({ id: candidate.id, score: 0, match: 'keyword' as const }))
      .sort(compareRankedBy(candidates));
  }

  const results: Ranked[] = [];
  const seen = new Set<number>();

  if (opts.mode === 'hybrid' || opts.mode === 'keyword') {
    for (const candidate of candidates) {
      if (keywordMatches(trimmedQuery, candidate.props)) {
        results.push({ id: candidate.id, score: 1, match: 'keyword' });
        seen.add(candidate.id);
      }
    }
  }

  if ((opts.mode === 'hybrid' || opts.mode === 'semantic') && opts.queryEmbedding && opts.modelId) {
    for (const candidate of candidates) {
      if (seen.has(candidate.id)) {
        continue;
      }

      if (candidate.props.embedding_model !== opts.modelId) {
        continue;
      }

      const score = Math.max(
        similarity(opts.queryEmbedding, candidate.props.embedding),
        similarity(opts.queryEmbedding, candidate.props.name_embedding)
      );
      if (score >= opts.threshold) {
        results.push({ id: candidate.id, score, match: 'semantic' });
      }
    }
  }

  return results.sort(compareRankedBy(candidates));
}

function similarity(query: number[], vector: unknown): number {
  return Array.isArray(vector) ? cosine(query, vector.map((item) => Number(item))) : 0;
}

function compareRankedBy(candidates: Candidate[]): (left: Ranked, right: Ranked) => number {
  const createdAt = new Map<number, string>(
    candidates.map((candidate) => [
      candidate.id,
      typeof candidate.props.created_at === 'string' ? candidate.props.created_at : ''
    ])
  );

  return (left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }

    const leftCreatedAt = createdAt.get(left.id) ?? '';
    const rightCreatedAt = createdAt.get(right.id) ?? '';
    if (rightCreatedAt !== leftCreatedAt) {
      return rightCreatedAt.localeCompare(leftCreatedAt);
    }

    return left.id - right.id;
  };
}
