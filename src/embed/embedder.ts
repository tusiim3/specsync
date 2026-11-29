import OpenAI from 'openai';
import type { Config } from '../config.js';
import { GEMINI_OPENAI_BASE_URL } from '../llm/resolver.js';
import { ConfigurationError } from '../llm/provider.js';
import { toProviderError } from '../llm/openai-compatible.js';
import { withRetry } from '../llm/retry.js';
import type { Cache } from '../cache/cache.js';

export interface Embedder {
  /** Identifies model + settings; part of the embedding cache key. */
  readonly id: string;
  embed(texts: string[]): Promise<number[][]>;
  /** Load or select the model before any vectors are made (optional). */
  prepare?(): Promise<void>;
}

/** Truncate long inputs: small embedding models only read the first few hundred tokens anyway. */
const MAX_EMBED_CHARS = 2000;
const clip = (t: string) => (t.length > MAX_EMBED_CHARS ? t.slice(0, MAX_EMBED_CHARS) : t);

/** Small (~35 MB quantized) and the best local model in our retrieval benchmark (eval/retrieval.ts). */
export const DEFAULT_LOCAL_MODEL = 'Xenova/bge-small-en-v1.5';

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
        this.log(`Loading embedding model ${this.model} (one-time download, ~35 MB)...`);
        const p = await t.pipeline('feature-extraction', this.model, { dtype: 'q8' });
        return p as unknown as (texts: string[], opts: object) => Promise<{ data: Float32Array }>;
      })();
    }
    return this.pipe;
  }

  async prepare(): Promise<void> {
    try {
      await this.load();
    } catch (err) {
      this.pipe = null; // allow a later retry
      throw err;
    }
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

  constructor(
    private readonly model: string,
    apiKey: string,
    baseURL?: string,
    private readonly log: (msg: string) => void = () => {},
    private readonly sleep?: (ms: number) => Promise<void>,
  ) {
    this.id = `api:${baseURL ?? 'openai'}:${model}`;
    this.client = new OpenAI({ apiKey, baseURL, timeout: 120_000, maxRetries: 0 });
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    const batch = 64;
    for (let i = 0; i < texts.length; i += batch) {
      const input = texts.slice(i, i + batch).map(clip);
      // Free tiers rate-limit embeddings per minute; waits can be long, so retry patiently.
      const res = await withRetry(
        () =>
          this.client.embeddings.create({ model: this.model, input }).catch((err: unknown) => {
            throw toProviderError('Embeddings', err);
          }),
        {
          maxRetries: 6,
          baseDelayMs: 2000,
          maxDelayMs: 65_000,
          sleep: this.sleep,
          onRetry: (n, delay, err) => this.log(`embedding retry ${n}/6 in ${Math.round(delay / 1000)}s: ${err.message.split('\n')[0]}`),
        },
      );
      for (const d of [...res.data].sort((a, b) => a.index - b.index)) out.push(d.embedding);
    }
    return out;
  }
}

/** Wraps an embedder with the on-disk cache so unchanged code is never re-embedded. */
export class CachedEmbedder implements Embedder {
  hits = 0;

  constructor(private readonly inner: Embedder, private readonly cache: Cache) {}

  get id(): string {
    return this.inner.id;
  }

  async prepare(): Promise<void> {
    await this.inner.prepare?.();
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

/**
 * Tries the primary embedder (the local model) and, if it cannot load,
 * switches to an API embedder before any vectors are produced, so one run
 * never mixes vectors from two models.
 */
export class FallbackEmbedder implements Embedder {
  private active: Embedder;
  private prepared = false;

  constructor(
    private readonly primary: Embedder,
    private readonly fallback: (() => Embedder) | undefined,
    private readonly log: (msg: string) => void,
  ) {
    this.active = primary;
  }

  get id(): string {
    return this.active.id;
  }

  async prepare(): Promise<void> {
    if (this.prepared) return;
    try {
      await this.primary.prepare?.();
    } catch (err) {
      const reason = (err as Error).message.split('\n')[0];
      if (!this.fallback) {
        throw new ConfigurationError(
          [
            `Could not load the local embedding model (${reason}).`,
            'It downloads once from huggingface.co. If that is blocked, use API embeddings instead:',
            '  --embeddings gemini   (needs GEMINI_API_KEY)',
            '  --embeddings openai   (needs OPENAI_API_KEY)',
          ].join('\n'),
        );
      }
      this.active = this.fallback();
      this.log(`Local embedding model unavailable (${reason}); using ${this.active.id} instead.`);
    }
    this.prepared = true;
  }

  async embed(texts: string[]): Promise<number[][]> {
    await this.prepare();
    return this.active.embed(texts);
  }
}

export const DEFAULT_EMBEDDING_MODELS = {
  local: DEFAULT_LOCAL_MODEL,
  openai: 'text-embedding-3-small',
  gemini: 'gemini-embedding-001',
} as const;

export function createEmbedder(config: Config, log: (msg: string) => void, env = process.env): Embedder {
  const e = config.embeddings;
  const gemini = (key: string, model?: string) =>
    new ApiEmbedder(model ?? DEFAULT_EMBEDDING_MODELS.gemini, key, e.baseUrl ?? GEMINI_OPENAI_BASE_URL, log);
  const openai = (key: string, model?: string) =>
    new ApiEmbedder(model ?? DEFAULT_EMBEDDING_MODELS.openai, key, e.baseUrl, log);

  switch (e.provider) {
    case 'auto': {
      const geminiKey = env['GEMINI_API_KEY'];
      const openaiKey = env['OPENAI_API_KEY'];
      const fallback = geminiKey ? () => gemini(geminiKey) : openaiKey ? () => openai(openaiKey) : undefined;
      return new FallbackEmbedder(new LocalEmbedder(e.model ?? DEFAULT_LOCAL_MODEL, log), fallback, log);
    }
    case 'local':
      return new LocalEmbedder(e.model ?? DEFAULT_LOCAL_MODEL, log);
    case 'openai': {
      const key = env[e.apiKeyEnv ?? 'OPENAI_API_KEY'];
      if (!key) throw new ConfigurationError('embeddings.provider "openai" needs OPENAI_API_KEY.');
      return openai(key, e.model);
    }
    case 'gemini': {
      const key = env[e.apiKeyEnv ?? 'GEMINI_API_KEY'];
      if (!key) throw new ConfigurationError('embeddings.provider "gemini" needs GEMINI_API_KEY.');
      return gemini(key, e.model);
    }
    case 'openai-compatible': {
      if (!e.baseUrl || !e.model) {
        throw new ConfigurationError('embeddings.provider "openai-compatible" needs embeddings.baseUrl and embeddings.model.');
      }
      return new ApiEmbedder(e.model, env[e.apiKeyEnv ?? 'SPECSYNC_API_KEY'] ?? 'none', e.baseUrl, log);
    }
  }
}
