export interface Embedder {
  readonly id: string;
  readonly dims?: number;
  embed(texts: string[]): Promise<number[][]>;
}

export const EMBEDDING_FIELDS = ['embedding', 'name_embedding', 'embedding_model', 'embedded_at'] as const;

/** Vectors stored on a node: `embedding` covers the full text, `name_embedding` only label, name and aliases. */
export interface NodeEmbeddings {
  embedding: number[];
  name_embedding: number[];
}

const DEFAULT_MODELS = {
  local: 'Xenova/all-MiniLM-L6-v2',
  openai: 'text-embedding-3-small',
  azure: 'text-embedding-3-small',
  ollama: 'nomic-embed-text',
  voyage: 'voyage-3-lite'
} as const;

type Provider = keyof typeof DEFAULT_MODELS;

function getProvider(env: NodeJS.ProcessEnv): Provider | 'none' {
  const raw = env.REVERIE_EMBEDDINGS?.trim().toLowerCase() ?? 'local';
  if (raw === 'local' || raw === 'openai' || raw === 'azure' || raw === 'ollama' || raw === 'voyage') {
    return raw;
  }
  if (raw === 'none') {
    return 'none';
  }
  console.error(`Embeddings disabled: unknown provider "${env.REVERIE_EMBEDDINGS}"`);
  return 'none';
}

function getModel(env: NodeJS.ProcessEnv, provider: Provider): string {
  return env.REVERIE_EMBEDDING_MODEL?.trim() || DEFAULT_MODELS[provider];
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

/** REVERIE_EMBED_TIMEOUT_MS, whole milliseconds, clamped to 1s..120s. */
function configuredTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = (env.REVERIE_EMBED_TIMEOUT_MS ?? '').trim();
  const value = /^\d+$/.test(raw) ? Number(raw) : DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(value, 1_000), MAX_TIMEOUT_MS);
}

/** Credentials only travel over TLS; plain http is allowed for loopback hosts (local proxies). */
export function secureEndpoint(raw: string, name: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`${name} must use https (http is only accepted for localhost)`);
  }
  return url.toString().replace(/\/$/, '');
}

/** Credentials never follow a redirect (a cross-origin or https→http hop would leak them); every request is bounded by timeoutMs. */
async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal, redirect: 'error' });

    if (!response.ok) {
      const body = (await response.text()).slice(0, 200);
      throw new Error(`Embedding request failed ${response.status}: ${body}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function embedRemote(
  texts: string[],
  doRequest: (batch: string[]) => Promise<number[][]>
): Promise<number[][]> {
  const vectors: number[][] = [];

  for (let index = 0; index < texts.length; index += 64) {
    const batch = texts.slice(index, index + 64);
    const batchVectors = await doRequest(batch);
    vectors.push(...batchVectors);
  }

  return vectors;
}

function normalizeVector(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => Number(item));
}

export function createEmbedder(env: NodeJS.ProcessEnv = process.env): Embedder | null {
  const provider = getProvider(env);

  if (provider === 'none') {
    if ((env.REVERIE_EMBEDDINGS?.trim().toLowerCase() ?? '') === 'none') {
      console.error('Embeddings disabled: provider set to none');
    }
    return null;
  }

  const model = getModel(env, provider);
  const timeoutMs = configuredTimeoutMs(env);

  if (provider === 'local') {
    let extractorPromise: Promise<any> | null = null;

    return {
      id: `${provider}/${model}`,
      async embed(texts: string[]): Promise<number[][]> {
        if (texts.length === 0) {
          return [];
        }

        if (!extractorPromise) {
          extractorPromise = (async () => {
            const transformers: any = await import('@huggingface/transformers');
            if (env.REVERIE_MODEL_CACHE?.trim()) {
              transformers.env.cacheDir = env.REVERIE_MODEL_CACHE.trim();
            }
            return transformers.pipeline('feature-extraction', model, { dtype: 'q8' });
          })();
        }

        const extractor = await extractorPromise;
        const output = await extractor(texts, { pooling: 'mean', normalize: true });
        const vectors = Array.isArray(output) ? output : (output as { tolist?: () => unknown }).tolist?.();

        if (!Array.isArray(vectors)) {
          throw new Error('Local embedding pipeline returned an unexpected result');
        }

        return vectors.map((vector) => normalizeVector(vector));
      }
    };
  }

  if (provider === 'openai') {
    const apiKey = env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is required for OpenAI embeddings');
    }

    const baseUrl = secureEndpoint(env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1', 'OPENAI_BASE_URL');
    return {
      id: `${provider}/${model}`,
      async embed(texts: string[]): Promise<number[][]> {
        return embedRemote(texts, async (batch) => {
          const data = await fetchJson(`${baseUrl}/embeddings`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ model, input: batch })
          }, timeoutMs);
          return Array.isArray(data.data)
            ? data.data.map((item: { embedding: unknown }) => normalizeVector(item.embedding))
            : [];
        });
      }
    };
  }

  if (provider === 'azure') {
    const rawEndpoint = env.AZURE_OPENAI_ENDPOINT?.trim();
    const apiKey = env.AZURE_OPENAI_API_KEY?.trim();
    const deployment = env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT?.trim();
    const apiVersion = env.AZURE_OPENAI_API_VERSION?.trim() || '2024-10-21';

    if (!rawEndpoint) {
      throw new Error('AZURE_OPENAI_ENDPOINT is required for Azure embeddings');
    }
    const endpoint = secureEndpoint(rawEndpoint, 'AZURE_OPENAI_ENDPOINT');
    if (!apiKey) {
      throw new Error('AZURE_OPENAI_API_KEY is required for Azure embeddings');
    }
    if (!deployment) {
      throw new Error('AZURE_OPENAI_EMBEDDING_DEPLOYMENT is required for Azure embeddings');
    }

    return {
      id: `${provider}/${deployment}`,
      async embed(texts: string[]): Promise<number[][]> {
        return embedRemote(texts, async (batch) => {
          const data = await fetchJson(
            `${endpoint}/openai/deployments/${deployment}/embeddings?api-version=${apiVersion}`,
            {
              method: 'POST',
              headers: {
                'api-key': apiKey,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ model, input: batch })
            },
            timeoutMs
          );

          return Array.isArray(data.data)
            ? data.data.map((item: { embedding: unknown }) => normalizeVector(item.embedding))
            : [];
        });
      }
    };
  }

  if (provider === 'ollama') {
    const host = secureEndpoint(env.OLLAMA_HOST?.trim() || 'http://127.0.0.1:11434', 'OLLAMA_HOST');
    return {
      id: `${provider}/${model}`,
      async embed(texts: string[]): Promise<number[][]> {
        return embedRemote(texts, async (batch) => {
          const data = await fetchJson(`${host}/api/embed`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ model, input: batch })
          }, timeoutMs);

          return Array.isArray(data.embeddings)
            ? data.embeddings.map((item: unknown) => normalizeVector(item))
            : [];
        });
      }
    };
  }

  const apiKey = env.VOYAGE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('VOYAGE_API_KEY is required for Voyage embeddings');
  }

  return {
    id: `${provider}/${model}`,
    async embed(texts: string[]): Promise<number[][]> {
      return embedRemote(texts, async (batch) => {
        const data = await fetchJson('https://api.voyageai.com/v1/embeddings', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ model, input: batch })
        }, timeoutMs);

        return Array.isArray(data.data)
          ? data.data.map((item: { embedding: unknown }) => normalizeVector(item.embedding))
          : [];
      });
    }
  };
}

export function embeddingText(label: string, props: Record<string, unknown>): string {
  const skipKeys = new Set<string>([...EMBEDDING_FIELDS, 'created_at', 'updated_at']);
  const lines: string[] = [`${label}: ${String(props.name ?? '')}`.trim()];

  for (const [key, value] of Object.entries(props)) {
    if (key === 'name' || skipKeys.has(key) || key.endsWith('_id') || key.endsWith('Id')) {
      continue;
    }

    if (typeof value === 'string') {
      lines.push(`${key}: ${value}`);
      continue;
    }

    if (Array.isArray(value) && value.every((item) => typeof item === 'string' || typeof item === 'number')) {
      lines.push(`${key}: ${value.join(', ')}`);
    }
  }

  return lines.join('\n').slice(0, 1000);
}

/** Label, name and aliases only. Kept separate because descriptive text dilutes name similarity badly. */
export function nameText(label: string, props: Record<string, unknown>): string {
  const lines = [`${label}: ${String(props.name ?? '')}`.trim()];
  const aliases = props.aliases;
  if (Array.isArray(aliases) && aliases.length > 0) {
    lines.push(`aliases: ${aliases.map((alias) => String(alias)).join(', ')}`);
  }
  return lines.join('\n');
}

/** Embed a batch of nodes, two texts each, and pair the vectors back up per node. */
export async function embedNodes(
  embedder: Embedder,
  nodes: Array<{ label: string; props: Record<string, unknown> }>
): Promise<NodeEmbeddings[]> {
  const texts = nodes.flatMap((node) => [embeddingText(node.label, node.props), nameText(node.label, node.props)]);
  const vectors = await embedder.embed(texts);
  return nodes.map((_, index) => ({
    embedding: vectors[index * 2] ?? [],
    name_embedding: vectors[index * 2 + 1] ?? []
  }));
}

export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;

  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    aNorm += a[index] * a[index];
    bNorm += b[index] * b[index];
  }

  if (aNorm === 0 || bNorm === 0) {
    return 0;
  }

  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

export function scrub<T>(value: T): T {
  const blocked = new Set<string>(EMBEDDING_FIELDS);

  if (Array.isArray(value)) {
    return value.map((item) => scrub(item)) as T;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !blocked.has(key))
      .map(([key, item]) => [key, scrub(item)]);
    return Object.fromEntries(entries) as T;
  }

  return value;
}
