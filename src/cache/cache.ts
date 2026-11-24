import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import type { RequirementResult } from '../types.js';

/** Entries unused for this many days are dropped on save. */
const TTL_DAYS = 30;

interface Entry<T> {
  v: T;
  /** Day number (days since epoch) the entry was last used. */
  d: number;
}

interface CacheFile<T> {
  version: 1;
  entries: Record<string, Entry<T>>;
}

const today = () => Math.floor(Date.now() / 86_400_000);

function encodeVector(v: number[]): string {
  return Buffer.from(new Float32Array(v).buffer).toString('base64');
}

function decodeVector(s: string): number[] {
  const buf = Buffer.from(s, 'base64');
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}

export type CachedVerdict = Omit<RequirementResult, 'cached'>;

/**
 * Content-addressed cache for embeddings and verdicts, stored as JSON under `dir`.
 * Keys hash everything that affects the value (model, prompt version, inputs),
 * so a stale entry can never be returned for changed inputs.
 */
export class Cache {
  private embeddings: Record<string, Entry<string>> = {};
  private verdicts: Record<string, Entry<CachedVerdict>> = {};
  private dirty = false;

  constructor(readonly dir: string | null) {}

  /** A cache that stores nothing (for --no-cache). */
  static disabled(): Cache {
    return new Cache(null);
  }

  key(...parts: string[]): string {
    const h = createHash('sha256');
    for (const p of parts) h.update(p).update('\u0000');
    return h.digest('hex').slice(0, 40);
  }

  async load(): Promise<void> {
    if (!this.dir) return;
    this.embeddings = await readJson<string>(join(this.dir, 'embeddings.json'));
    this.verdicts = await readJson<CachedVerdict>(join(this.dir, 'verdicts.json'));
  }

  getEmbedding(key: string): number[] | undefined {
    const e = this.embeddings[key];
    if (!e) return undefined;
    e.d = today();
    return decodeVector(e.v);
  }

  setEmbedding(key: string, vector: number[]): void {
    if (!this.dir) return;
    this.embeddings[key] = { v: encodeVector(vector), d: today() };
    this.dirty = true;
  }

  getVerdict(key: string): CachedVerdict | undefined {
    const e = this.verdicts[key];
    if (!e) return undefined;
    e.d = today();
    this.dirty = true;
    return e.v;
  }

  setVerdict(key: string, value: CachedVerdict): void {
    if (!this.dir) return;
    this.verdicts[key] = { v: value, d: today() };
    this.dirty = true;
  }

  async save(): Promise<void> {
    if (!this.dir || !this.dirty) return;
    await mkdir(this.dir, { recursive: true });
    const cutoff = today() - TTL_DAYS;
    await writeJson(join(this.dir, 'embeddings.json'), prune(this.embeddings, cutoff));
    await writeJson(join(this.dir, 'verdicts.json'), prune(this.verdicts, cutoff));
    this.dirty = false;
  }
}

function prune<T>(entries: Record<string, Entry<T>>, cutoff: number): Record<string, Entry<T>> {
  const out: Record<string, Entry<T>> = {};
  for (const [k, e] of Object.entries(entries)) if (e.d >= cutoff) out[k] = e;
  return out;
}

async function readJson<T>(path: string): Promise<Record<string, Entry<T>>> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as CacheFile<T>;
    return parsed.version === 1 && parsed.entries ? parsed.entries : {};
  } catch {
    // A corrupt cache is just a cold cache.
    return {};
  }
}

async function writeJson<T>(path: string, entries: Record<string, Entry<T>>): Promise<void> {
  const file: CacheFile<T> = { version: 1, entries };
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(file), 'utf-8');
  await rename(tmp, path);
}
