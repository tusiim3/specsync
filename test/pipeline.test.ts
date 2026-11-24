import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { runPipeline, isDryRunPlan, InputError, displayPath } from '../src/pipeline.js';
import { Cache } from '../src/cache/cache.js';
import { ProviderError } from '../src/llm/provider.js';
import { FatalProviderError, BudgetError } from '../src/agents/orchestrator.js';
import type { DriftReport } from '../src/types.js';
import { FakeEmbedder, ScriptedProvider, TODO_API, noSleep, testConfig, withTempDir, type ScriptedAnswer } from './helpers.js';

const expected = JSON.parse(readFileSync(join(TODO_API, 'expected.json'), 'utf-8')) as {
  labels: Record<string, ScriptedAnswer>;
};

/** A provider that answers each requirement with its ground-truth label. */
const truthProvider = () => new ScriptedProvider(expected.labels);

async function run(opts: { cacheDir?: string; provider?: ScriptedProvider; config?: Parameters<typeof testConfig>[0]; dryRun?: boolean } = {}) {
  const config = testConfig({ spec: 'docs/spec.md', repo: '.', ...opts.config });
  return runPipeline({
    config,
    baseDir: TODO_API,
    provider: opts.provider ?? truthProvider(),
    embedder: new FakeEmbedder(),
    cache: opts.cacheDir ? new Cache(opts.cacheDir) : Cache.disabled(),
    dryRun: opts.dryRun,
    sleep: noSleep,
  });
}

describe('pipeline (golden, todo-api fixture)', () => {
  it('produces verdicts, evidence, score and surplus', async () => {
    const report = (await run()) as DriftReport;
    expect(report.requirements.map((r) => r.id)).toEqual([
      'REQ-1', 'REQ-2', 'REQ-3', 'REQ-4', 'REQ-5', 'REQ-6', 'REQ-7', 'REQ-8', 'REQ-9',
    ]);
    expect(Object.fromEntries(report.results.map((r) => [r.requirementId, r.verdict]))).toEqual(
      Object.fromEntries(Object.entries(expected.labels).map(([k, v]) => [k, v.verdict])),
    );
    // Retrieval surfaced the right file for every covered requirement.
    for (const [id, label] of Object.entries(expected.labels)) {
      const r = report.results.find((x) => x.requirementId === id)!;
      for (const file of label.evidence ?? []) {
        expect(r.evidence.map((e) => e.filePath), `${id} evidence`).toContain(file);
      }
    }
    // 5 implemented + 0.5 partial over 8 scored (REQ-9 is not verifiable) = 69.
    expect(report.score).toBe(69);
    expect(report.counts).toEqual({ implemented: 5, partial: 1, missing: 2, notVerifiable: 1, error: 0 });
    expect(report.complete).toBe(true);
    // purgeAll is public and no requirement points at it.
    expect(report.surplus.map((s) => s.symbol)).toContain('purgeAll');
    expect(report.surplus.map((s) => s.symbol)).not.toContain('createTodo');
    expect(report.stats).toMatchObject({ files: 6, llmCalls: 9, cacheHits: 0 });
    expect(report.specFiles[0]).toMatch(/docs\/spec\.md$/);
  });

  it('shows the model the requirement and labelled code, never truncated silently', async () => {
    const provider = truthProvider();
    await run({ provider });
    const prompt = provider.requests.find((r) => r.prompt.startsWith('REQUIREMENT REQ-1'))!.prompt;
    expect(prompt).toContain('at most 200 characters');
    expect(prompt).toMatch(/\[C1\] \S+:\d+-\d+/);
    expect(prompt).toContain('title must be at most');
  });

  it('serves an unchanged rerun entirely from the cache', async () => {
    await withTempDir(async (dir) => {
      const first = (await run({ cacheDir: dir })) as DriftReport;
      const provider = truthProvider();
      const second = (await run({ cacheDir: dir, provider })) as DriftReport;
      expect(provider.requests).toHaveLength(0);
      expect(second.stats).toMatchObject({ llmCalls: 0, cacheHits: 9 });
      expect(second.results.every((r) => r.cached)).toBe(true);
      expect(second.score).toBe(first.score);
    });
  });

  it('marks failing requirements as errors and the run as incomplete', async () => {
    const provider = new ScriptedProvider({
      ...expected.labels,
      'REQ-2': () => {
        throw new ProviderError('overloaded', { status: 503, retryable: true });
      },
    });
    const report = (await run({ provider })) as DriftReport;
    const r2 = report.results.find((r) => r.requirementId === 'REQ-2')!;
    expect(r2.verdict).toBe('error');
    expect(r2.error).toMatch(/overloaded/);
    expect(report.complete).toBe(false);
    // 3 attempts (maxRetries 2) for REQ-2, one for every other requirement.
    expect(provider.requests.filter((r) => r.prompt.startsWith('REQUIREMENT REQ-2'))).toHaveLength(3);
    expect(report.score).toBe(64); // errors are left out of the score
  });

  it('stops on a fatal provider error such as a bad key', async () => {
    const provider = new ScriptedProvider(
      Object.fromEntries(
        Object.keys(expected.labels).map((k) => [
          k,
          () => {
            throw new ProviderError('invalid api key', { status: 401, fatal: true });
          },
        ]),
      ),
    );
    await expect(run({ provider })).rejects.toBeInstanceOf(FatalProviderError);
  });

  it('plans without calling the model in a dry run, and enforces budgets', async () => {
    const provider = truthProvider();
    const plan = await run({ provider, dryRun: true });
    expect(isDryRunPlan(plan)).toBe(true);
    expect(plan).toMatchObject({ requirements: 9, files: 6, plannedCalls: 9, cachedVerdicts: 0 });
    expect(provider.requests).toHaveLength(0);
    await expect(run({ config: { budget: { maxLlmCalls: 3 } } })).rejects.toBeInstanceOf(BudgetError);
  });

  it('reports clear input errors', async () => {
    await expect(run({ config: { spec: 'nope.md' } })).rejects.toBeInstanceOf(InputError);
    await expect(run({ config: { repo: 'missing-dir' } })).rejects.toThrow(/Repo directory not found/);
    const config = testConfig({ repo: '.' });
    await expect(
      runPipeline({ config, baseDir: TODO_API, provider: truthProvider(), embedder: new FakeEmbedder(), cache: Cache.disabled() }),
    ).rejects.toThrow(/No spec given/);
  });
});

describe('displayPath', () => {
  it('is relative inside cwd, "." for cwd itself, absolute outside', () => {
    expect(displayPath('/a/b', '/a/b')).toBe('.');
    expect(displayPath('/a/b/c/d.md', '/a/b')).toBe('c/d.md');
    expect(displayPath('/x/y', '/a/b')).toBe('/x/y');
  });
});
