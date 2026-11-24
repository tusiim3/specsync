import { describe, expect, it, vi } from 'vitest';
import { Bm25Index, HybridRetriever, cosine, stem, tokenize } from '../src/search/retrieval.js';
import { extractJson, interpretResponse, renderCandidates } from '../src/agents/verdict.js';
import { withRetry } from '../src/llm/retry.js';
import { ProviderError, classifyStatus, parseRetryAfter, retryHintFromMessage } from '../src/llm/provider.js';
import { Cache } from '../src/cache/cache.js';
import type { CodeChunk, EmbeddedChunk, Requirement } from '../src/types.js';
import { FakeEmbedder, withTempDir } from './helpers.js';

const chunk = (id: string, content: string, extra: Partial<CodeChunk> = {}): CodeChunk => {
  const [filePath, range] = id.split(':');
  const [s, e] = range!.split('-').map(Number);
  return {
    id,
    filePath: filePath!,
    startLine: s!,
    endLine: e!,
    language: 'typescript',
    kind: 'function',
    exported: true,
    content,
    hash: id,
    ...extra,
  };
};

const req: Requirement = { id: 'REQ-1', heading: 'Create', path: [], body: 'Create todos', source: { file: 'spec.md', line: 3 } };

describe('tokenize and stem', () => {
  it('splits identifiers and applies a light stemmer', () => {
    expect(tokenize('parseRequestBody snake_case JSONParser')).toEqual(['pars', 'request', 'body', 'snak', 'case', 'json', 'pars']);
    expect(['route', 'routes', 'routing', 'routed'].map(stem)).toEqual(['rout', 'rout', 'rout', 'rout']);
    expect(['server', 'serve', 'serving'].map(stem)).toEqual(['serv', 'serv', 'serv']);
    expect(['class', 'classes', 'status', 'policies'].map(stem)).toEqual(['class', 'class', 'status', 'policy']);
  });
});

describe('retrieval', () => {
  it('BM25 ranks documents containing rare query terms first', () => {
    const idx = new Bm25Index(['rate limit tokens per minute', 'create todo title', 'delete todo by id']);
    const scores = idx.scores('limit requests per minute');
    expect(scores[0]).toBeGreaterThan(scores[1]!);
    expect(scores[2]).toBe(0);
  });

  it('cosine handles zero vectors', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([0, 0], [1, 0])).toBe(0);
  });

  it('fuses lexical and semantic rankings across several queries', async () => {
    const emb = new FakeEmbedder();
    const chunks = [
      chunk('a.ts:1-5', 'function sendJson(res) { res.json() }'),
      chunk('b.ts:1-5', 'function redirect(res, url) { res.redirect(url) }'),
      chunk('c.ts:1-5', 'function unrelated() { return 42 }'),
    ];
    const vectors = await emb.embed(chunks.map((c) => c.content));
    const embedded: EmbeddedChunk[] = chunks.map((c, i) => ({ ...c, vector: vectors[i]! }));
    const r = new HybridRetriever(embedded, chunks.map((c) => c.content));
    const q = async (text: string) => ({ text, vector: (await emb.embed([text]))[0]! });
    expect(r.search([await q('send json response')], 1).map((c) => c.id)).toEqual(['a.ts:1-5']);
    const both = r.search([await q('send json response'), await q('redirect to url')], 2).map((c) => c.id);
    expect(both.sort()).toEqual(['a.ts:1-5', 'b.ts:1-5']);
    expect(r.search([], 3)).toEqual([]);
  });
});

describe('verdict parsing', () => {
  const { candidates } = renderCandidates([chunk('src/a.ts:1-10', 'code a'), chunk('src/b.ts:5-9', 'code b', { symbol: 'B' })], 4000);

  it('maps chunk labels to evidence and drops unknown labels', () => {
    const raw = JSON.stringify({
      verdict: 'implemented',
      confidence: 0.9,
      evidence: [
        { chunk: 'C2', reason: 'does it' },
        { chunk: '[C1]', reason: 'helps' },
        { chunk: 'C9', reason: 'hallucinated' },
        { chunk: 'C2', reason: 'duplicate' },
      ],
      notes: 'ok',
    });
    const r = interpretResponse(req, raw, candidates);
    expect(r.verdict).toBe('implemented');
    expect(r.evidence.map((e) => [e.filePath, e.startLine, e.symbol])).toEqual([
      ['src/b.ts', 5, 'B'],
      ['src/a.ts', 1, undefined],
    ]);
  });

  it('downgrades an uncited coverage claim to low-confidence partial', () => {
    const raw = JSON.stringify({ verdict: 'implemented', confidence: 0.95, evidence: [{ chunk: 'C7', reason: 'x' }], notes: 'yes' });
    const r = interpretResponse(req, raw, candidates);
    expect(r.verdict).toBe('partial');
    expect(r.confidence).toBe(0.3);
    expect(r.notes).toMatch(/cited no shown code/);
  });

  it('clears evidence for missing verdicts and rejects invalid shapes', () => {
    const r = interpretResponse(
      req,
      JSON.stringify({ verdict: 'missing', confidence: 1, evidence: [{ chunk: 'C1', reason: 'x' }], notes: 'no' }),
      candidates,
    );
    expect(r.evidence).toEqual([]);
    expect(() => interpretResponse(req, '{"verdict":"maybe"}', candidates)).toThrow();
  });

  it('extracts JSON from fenced or chatty replies', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! {"a":2} Hope that helps')).toEqual({ a: 2 });
    expect(() => extractJson('no json here')).toThrow();
  });

  it('shortens long chunks with an explicit omission marker', () => {
    const long = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n');
    const { text } = renderCandidates([chunk('big.ts:1-400', long)], 500);
    expect(text).toMatch(/… \(\d+ lines omitted\) …/);
    expect(text).toContain('line 0 ');
    expect(text).toContain('line 399 ');
  });
});

describe('withRetry', () => {
  it('retries retryable errors with backoff, honoring Retry-After', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls === 1) throw new ProviderError('busy', { status: 503, retryable: true });
        if (calls === 2) throw new ProviderError('slow down', { status: 429, retryable: true, retryAfterMs: 7000 });
        return 'ok';
      },
      { maxRetries: 3, baseDelayMs: 100, sleep: async (ms) => void sleeps.push(ms), random: () => 0 },
    );
    expect(result).toBe('ok');
    expect(sleeps).toEqual([50, 7250]);
  });

  it('does not retry non-retryable errors and gives up after maxRetries', async () => {
    const fatal = vi.fn(async () => {
      throw new ProviderError('bad key', { status: 401, fatal: true });
    });
    await expect(withRetry(fatal, { maxRetries: 3, sleep: async () => {} })).rejects.toThrow('bad key');
    expect(fatal).toHaveBeenCalledTimes(1);

    const flaky = vi.fn(async () => {
      throw new ProviderError('down', { status: 500, retryable: true });
    });
    await expect(withRetry(flaky, { maxRetries: 2, sleep: async () => {} })).rejects.toThrow('down');
    expect(flaky).toHaveBeenCalledTimes(3);
  });

  it('classifies statuses and parses Retry-After', () => {
    expect(classifyStatus(429)).toEqual({ retryable: true, fatal: false });
    expect(classifyStatus(503)).toEqual({ retryable: true, fatal: false });
    expect(classifyStatus(401)).toEqual({ retryable: false, fatal: true });
    expect(classifyStatus(400)).toEqual({ retryable: false, fatal: false });
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(retryHintFromMessage('Quota exceeded. Please retry in 42.94s.')).toBe(42940);
    expect(retryHintFromMessage('nope')).toBeUndefined();
  });
});

describe('Cache', () => {
  it('round-trips embeddings and verdicts through disk', async () => {
    await withTempDir(async (dir) => {
      const c = new Cache(dir);
      await c.load();
      const k = c.key('emb', 'model', 'text');
      c.setEmbedding(k, [0.5, -1, 2]);
      c.setVerdict('v1', { requirementId: 'R', verdict: 'missing', confidence: 1, evidence: [], notes: 'n' });
      await c.save();

      const again = new Cache(dir);
      await again.load();
      expect(again.getEmbedding(k)).toEqual([0.5, -1, 2]);
      expect(again.getVerdict('v1')?.verdict).toBe('missing');
      expect(again.getVerdict('nope')).toBeUndefined();
    });
  });

  it('keys differ when any part differs, and a disabled cache stores nothing', async () => {
    const c = Cache.disabled();
    expect(c.key('a', 'bc')).not.toEqual(c.key('ab', 'c'));
    c.setEmbedding('k', [1]);
    expect(c.getEmbedding('k')).toBeUndefined();
    await c.save();
  });

  it('treats a corrupt cache file as empty', async () => {
    await withTempDir(async (dir) => {
      const { writeFile } = await import('fs/promises');
      await writeFile(`${dir}/verdicts.json`, '{not json');
      const c = new Cache(dir);
      await c.load();
      expect(c.getVerdict('x')).toBeUndefined();
    });
  });
});

describe('RateGate', () => {
  it('spaces calls by requests-per-minute and pauses everyone after a rate limit', async () => {
    const { RateGate } = await import('../src/llm/rate-gate.js');
    let now = 0;
    const waits: number[] = [];
    const gate = new RateGate(60, () => now, async (ms) => {
      waits.push(ms);
    });
    await Promise.all([gate.wait(), gate.wait(), gate.wait()]);
    expect(waits).toEqual([1000, 2000]);
    waits.length = 0;
    now = 10_000;
    gate.pause(5000);
    await gate.wait();
    expect(waits).toEqual([5000]);
    const free = new RateGate(undefined, () => 0, async (ms) => void waits.push(ms));
    waits.length = 0;
    await free.wait();
    expect(waits).toEqual([]);
  });
});

describe('FallbackEmbedder and createEmbedder', () => {
  it('uses the primary when it loads, otherwise switches before embedding', async () => {
    const { FallbackEmbedder } = await import('../src/embed/embedder.js');
    const ok = { id: 'local:x', prepare: async () => {}, embed: async (t: string[]) => t.map(() => [1]) };
    const broken = { id: 'local:x', prepare: async () => { throw new Error('download blocked'); }, embed: async () => [] };
    const api = { id: 'api:gemini', embed: async (t: string[]) => t.map(() => [2]) };
    const logs: string[] = [];

    const a = new FallbackEmbedder(ok, () => api, (m) => logs.push(m));
    expect(await a.embed(['q'])).toEqual([[1]]);
    expect(a.id).toBe('local:x');

    const b = new FallbackEmbedder(broken, () => api, (m) => logs.push(m));
    expect(await b.embed(['q'])).toEqual([[2]]);
    expect(b.id).toBe('api:gemini');
    expect(logs.join()).toMatch(/download blocked/);

    const c = new FallbackEmbedder(broken, undefined, () => {});
    await expect(c.embed(['q'])).rejects.toThrow(/--embeddings gemini/);
  });

  it('builds the configured embedder and requires keys for API providers', async () => {
    const { createEmbedder } = await import('../src/embed/embedder.js');
    const { testConfig } = await import('./helpers.js');
    expect(createEmbedder(testConfig(), () => {}, {}).id).toBe('local:Xenova/bge-small-en-v1.5');
    expect(createEmbedder(testConfig({ embeddings: { provider: 'gemini' } }), () => {}, { GEMINI_API_KEY: 'k' }).id).toMatch(/gemini-embedding-001/);
    expect(() => createEmbedder(testConfig({ embeddings: { provider: 'openai' } }), () => {}, {})).toThrow(/OPENAI_API_KEY/);
  });
});
