import OpenAI from 'openai';
import type { Config } from '../config.js';
import { GEMINI_OPENAI_BASE_URL } from '../llm/resolver.js';
import { ConfigurationError } from '../llm/provider.js';
import type { Cache } from '../cache/cache.js';

export interface Embedder {
  /** Identifies model + settings; part of the embedding cache key. */
  readonly id: string;
  embed(texts: string[]): Promise<number[][]>;
}

/** Truncate long inputs: small embedding models only read the first few hundred tokens anyway. */
const MAX_EMBED_CHARS = 2000;
const clip = (t: string) => (t.length > MAX_EMBED_CHARS ? t.slice(0, MAX_EMBED_CHARS) : t);

export const DEFAULT_LOCAL_MODEL = 'Xenova/all-MiniLM-L6-v2';

/** Runs a small sentence-transformer locally via transformers.js. No API key, works offline after first download. */
export class LocalEmbedder implements Embedder {
  readonly id: string;
  private pipe: Promise<(texts: string[], opts: object) => Promise<{ data: Float32Array }>> | null = null;

  constructor(
    private readonly model = DEFAULT_LOCAL_MODEL,
    private readonly log: (msg: string) => void = () => {},
  ) {
    this.id = `local:${model}`;
  }

  private load() {
    if (!this.pipe) {
      this.pipe = (async () => {
        const t = await import('@huggingface/transformers');
        const cacheDir = process.env['SPECSYNC_MODEL_CACHE'];
        if (cacheDir) t.env.cacheDir = cacheDir;
        this.log(`Loading embedding model ${this.model} (downloads ~25MB on first run)...`);
        const p = await t.pipeline('feature-extraction', this.model, { dtype: 'q8' });
        return p as unknown as (texts: string[], opts: object) => Promise<{ data: Float32Array }>;
      })();
    }
    return this.pipe;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.load();
    const out: number[][] = [];
    const batch = 32;
    for (let i = 0; i < texts.length; i += batch) {
      const slice = texts.slice(i, i + batch).map(clip);
      const res = await extractor(slice, { pooling: 'mean', normalize: true });
      const dim = res.data.length / slice.length;
      for (let b = 0; b < slice.length; b++) out.push(Array.from(res.data.subarray(b * dim, (b + 1) * dim)));
    }
    return out;
  }
}

/** Any OpenAI-compatible embeddings endpoint (OpenAI, Gemini, Ollama, ...). */
export class ApiEmbedder implements Embedder {
  readonly id: string;
  private readonly client: OpenAI;

  constructor(private readonly model: string, apiKey: string, baseURL?: string) {
    this.id = `api:${baseURL ?? 'openai'}:${model}`;
    this.client = new OpenAI({ apiKey, baseURL, timeout: 120_000, maxRetries: 4 });
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    const batch = 64;
    for (let i = 0; i < texts.length; i += batch) {
      const res = await this.client.embeddings.create({ model: this.model, input: texts.slice(i, i + batch).map(clip) });
      for (const d of [...res.data].sort((a, b) => a.index - b.index)) out.push(d.embedding);
    }
    return out;
  }
}

/** Wraps an embedder with the on-disk cache so unchanged code is never re-embedded. */
export class CachedEmbedder implements Embedder {
  readonly id: string;
  hits = 0;

  constructor(private readonly inner: Embedder, private readonly cache: Cache) {
    this.id = inner.id;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const keys = texts.map((t) => this.cache.key('emb', this.id, t));
    const result: (number[] | undefined)[] = keys.map((k) => this.cache.getEmbedding(k));
    const missing = result.flatMap((v, i) => (v ? [] : [i]));
    this.hits += texts.length - missing.length;
    if (missing.length) {
      const fresh = await this.inner.embed(missing.map((i) => texts[i]!));
      missing.forEach((idx, j) => {
        result[idx] = fresh[j]!;
        this.cache.setEmbedding(keys[idx]!, fresh[j]!);
      });
    }
    return result as number[][];
  }
}

export function createEmbedder(config: Config, log: (msg: string) => void, env = process.env): Embedder {
  const e = config.embeddings;
  switch (e.provider) {
    case 'local':
      return new LocalEmbedder(e.model ?? DEFAULT_LOCAL_MODEL, log);
    case 'openai': {
      const key = env[e.apiKeyEnv ?? 'OPENAI_API_KEY'];
      if (!key) throw new ConfigurationError('embeddings.provider "openai" needs OPENAI_API_KEY.');
      return new ApiEmbedder(e.model ?? 'text-embedding-3-small', key, e.baseUrl);
    }
    case 'gemini': {
      const key = env[e.apiKeyEnv ?? 'GEMINI_API_KEY'];
      if (!key) throw new ConfigurationError('embeddings.provider "gemini" needs GEMINI_API_KEY.');
      return new ApiEmbedder(e.model ?? 'gemini-embedding-001', key, e.baseUrl ?? GEMINI_OPENAI_BASE_URL);
    }
    case 'openai-compatible': {
      if (!e.baseUrl || !e.model) {
        throw new ConfigurationError('embeddings.provider "openai-compatible" needs embeddings.baseUrl and embeddings.model.');
      }
      return new ApiEmbedder(e.model, env[e.apiKeyEnv ?? 'SPECSYNC_API_KEY'] ?? 'none', e.baseUrl);
    }
  }
}
