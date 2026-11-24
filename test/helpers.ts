import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import type { Embedder } from '../src/embed/embedder.js';
import type { CompletionRequest, CompletionResult, LLMProvider } from '../src/llm/provider.js';
import { tokenize } from '../src/search/retrieval.js';
import { parseConfig, type ConfigInput } from '../src/config.js';

export const FIXTURES = resolve(import.meta.dirname, 'fixtures');
export const TODO_API = join(FIXTURES, 'todo-api');

/** Deterministic offline embedder: hashed bag of words, L2-normalized. */
export class FakeEmbedder implements Embedder {
  readonly id = 'fake:hash-bow';
  calls = 0;
  constructor(private readonly dim = 256) {}
  async embed(texts: string[]): Promise<number[][]> {
    this.calls += texts.length;
    return texts.map((t) => {
      const v = new Array<number>(this.dim).fill(0);
      for (const tok of tokenize(t)) {
        let h = 2166136261;
        for (let i = 0; i < tok.length; i++) h = Math.imul(h ^ tok.charCodeAt(i), 16777619);
        v[Math.abs(h) % this.dim]! += 1;
      }
      const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / n);
    });
  }
}

export interface ScriptedAnswer {
  verdict: 'implemented' | 'partial' | 'missing' | 'not-verifiable';
  /** Cite every shown chunk whose header contains one of these paths. */
  evidence?: string[];
  confidence?: number;
}

/**
 * A provider that answers from a script keyed by requirement id, citing the
 * chunk labels whose file matches the expected evidence. Records every request.
 */
export class ScriptedProvider implements LLMProvider {
  readonly name = 'Scripted';
  readonly model = 'scripted-1';
  requests: CompletionRequest[] = [];

  constructor(
    private readonly answers: Record<string, ScriptedAnswer | (() => never)>,
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(req);
    const id = /^REQUIREMENT (\S+)/m.exec(req.prompt)?.[1] ?? '';
    const answer = this.answers[id];
    if (typeof answer === 'function') answer();
    const a = (answer ?? { verdict: 'missing' }) as ScriptedAnswer;
    const evidence: Array<{ chunk: string; reason: string }> = [];
    for (const m of req.prompt.matchAll(/^\[(C\d+)\] (\S+):\d+-\d+/gm)) {
      if (a.evidence?.some((p) => m[2] === p)) evidence.push({ chunk: m[1]!, reason: `implements ${id}` });
    }
    return {
      text: JSON.stringify({ verdict: a.verdict, confidence: a.confidence ?? 0.9, evidence, notes: `scripted ${a.verdict}` }),
      inputTokens: Math.ceil(req.prompt.length / 4),
      outputTokens: 50,
    };
  }
}

export function testConfig(overrides: Partial<ConfigInput> = {}) {
  return parseConfig({ provider: { concurrency: 2, maxRetries: 2 }, ...overrides });
}

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'specsync-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const noSleep = () => Promise.resolve();
