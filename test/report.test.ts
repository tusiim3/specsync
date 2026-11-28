import { describe, expect, it } from 'vitest';
import { computeScore, countVerdicts, findSurplus, generateReport } from '../src/report/generator.js';
import { diffReports, hasChanges } from '../src/report/diff.js';
import { renderMarkdown, COMMENT_MARKER } from '../src/report/markdown.js';
import { renderSarif } from '../src/report/sarif.js';
import { renderText, scoreBar, wrap } from '../src/report/text.js';
import { appendRun, previousRun, readHistory } from '../src/store/history.js';
import { evaluateThresholds, EXIT } from '../src/cli.js';
import type { CodeChunk, DriftReport, Requirement, RequirementResult, Verdict } from '../src/types.js';
import { testConfig, withTempDir } from './helpers.js';

const req = (id: string, line = 1): Requirement => ({ id, heading: `Heading ${id}`, path: [], body: `Body ${id}`, source: { file: 'docs/spec.md', line } });
const res = (id: string, verdict: Verdict, evidence: string[] = []): RequirementResult => ({
  requirementId: id,
  verdict,
  confidence: 0.8,
  evidence: evidence.map((chunkId) => ({ chunkId, filePath: chunkId.split(':')[0]!, startLine: 1, endLine: 5, reason: 'r' })),
  notes: `note ${id}`,
  cached: false,
  ...(verdict === 'error' ? { error: 'boom' } : {}),
});
const chunk = (id: string, exported = true, kind: CodeChunk['kind'] = 'function'): CodeChunk => ({
  id,
  filePath: id.split(':')[0]!,
  startLine: 1,
  endLine: 5,
  language: 'ts',
  kind,
  symbol: id.split(':')[0]!.replace(/\W/g, ''),
  exported,
  content: 'x',
  hash: 'h',
});

function report(verdicts: Record<string, Verdict>, chunks: CodeChunk[] = []): DriftReport {
  const requirements = Object.keys(verdicts).map((id, i) => req(id, i * 5 + 1));
  const results = Object.entries(verdicts).map(([id, v]) => res(id, v, v === 'implemented' || v === 'partial' ? ['a.ts:1-5'] : []));
  return generateReport({
    specFiles: ['docs/spec.md'],
    repoDir: 'src',
    provider: 'Test',
    model: 'm',
    requirements,
    results,
    chunks,
    surplusLimit: 10,
    stats: { files: 1, chunks: chunks.length, llmCalls: 3, cacheHits: 1, inputTokens: 10, outputTokens: 5, durationMs: 1234 },
  });
}

describe('score and counts', () => {
  it('weights partial as half and excludes not-verifiable and errors', () => {
    const results = [res('a', 'implemented'), res('b', 'partial'), res('c', 'missing'), res('d', 'not-verifiable'), res('e', 'error')];
    expect(computeScore(results)).toBe(50);
    expect(countVerdicts(results)).toEqual({ implemented: 1, partial: 1, missing: 1, notVerifiable: 1, error: 1 });
    expect(computeScore([res('d', 'not-verifiable')])).toBeNull();
  });

  it('keeps results in spec order', () => {
    const r = generateReport({
      specFiles: [], repoDir: '.', provider: 'p', model: 'm',
      requirements: [req('x'), req('y')],
      results: [res('y', 'missing'), res('x', 'implemented')],
      chunks: [], surplusLimit: 5,
      stats: { files: 0, chunks: 0, llmCalls: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 },
    });
    expect(r.results.map((x) => x.requirementId)).toEqual(['x', 'y']);
  });
});

describe('surplus', () => {
  it('lists public, uncited declarations only', () => {
    const chunks = [chunk('a.ts:1-5'), chunk('b.ts:1-5'), chunk('c.ts:1-5', false), chunk('d.ts:1-5', true, 'module')];
    const { items, publicSymbols } = findSurplus(chunks, [res('r', 'implemented', ['a.ts:1-5']), res('s', 'missing', ['b.ts:1-5'])]);
    expect(items.map((i) => i.chunkId)).toEqual(['b.ts:1-5']);
    expect(publicSymbols).toBe(2);
  });
});

describe('diff', () => {
  it('classifies regressions, improvements, added and removed requirements', () => {
    const before = report({ a: 'implemented', b: 'missing', c: 'partial', gone: 'missing' });
    const after = report({ a: 'partial', b: 'implemented', c: 'not-verifiable', fresh: 'missing' });
    const d = diffReports(before, after);
    expect(d.regressions.map((c) => [c.requirement.id, c.from, c.to])).toEqual([['a', 'implemented', 'partial']]);
    expect(d.improvements.map((c) => c.requirement.id)).toEqual(['b']);
    expect(d.otherChanges.map((c) => c.requirement.id)).toEqual(['c']);
    expect(d.added.map((r) => r.id)).toEqual(['fresh']);
    expect(d.removed.map((r) => r.id)).toEqual(['gone']);
    expect(hasChanges(d)).toBe(true);
    expect(hasChanges(diffReports(before, before))).toBe(false);
  });
});

describe('renderers', () => {
  const r = report({ a: 'implemented', b: 'missing', c: 'partial', d: 'error' }, [chunk('a.ts:1-5'), chunk('z.ts:1-5')]);

  it('text: shows score, sections, notes and no ANSI codes without color', () => {
    const t = renderText(r);
    expect(t).toContain('spec coverage 50/100');
    expect(t).toContain('MISSING');
    expect(t).toContain('Heading b');
    expect(t).toContain('note b');
    expect(t).toContain('Incomplete run');
    expect(t).toContain('ERRORS');
    expect(t).not.toMatch(/\x1b\[/);
    expect(renderText(r, undefined, { color: true })).toMatch(/\x1b\[/);
    expect(scoreBar(50, 10)).toBe('█████░░░░░');
    // Implemented rows are one line unless verbose.
    expect(t).not.toContain('note a');
    expect(renderText(r, undefined, { verbose: true })).toContain('note a');
    expect(wrap('aaa bbb ccc ddd', 40, '  ')).toEqual(['  aaa bbb ccc ddd']);
    expect(wrap('word '.repeat(20).trim(), 40, '    ').every((l) => l.startsWith('    ') && l.length <= 40)).toBe(true);
  });

  it('markdown: headline, links when a link base is given, compact comment marker', () => {
    const md = renderMarkdown(r, undefined, { linkBase: 'https://github.com/o/r/blob/abc/' });
    expect(md).toContain('**Spec coverage: 50/100**');
    expect(md).toContain('[`src/a.ts:1-5`](https://github.com/o/r/blob/abc/src/a.ts#L1-L5)');
    expect(md).toContain('[`docs/spec.md:6`](https://github.com/o/r/blob/abc/docs/spec.md#L6)');
    expect(md).toContain('[!WARNING]');
    expect(md).toContain('Unmapped public code (1 of 2 public symbols)');
    const compact = renderMarkdown(r, diffReports(report({ a: 'implemented', b: 'implemented' }), r), { compact: true });
    expect(compact.startsWith(COMMENT_MARKER)).toBe(true);
    expect(compact).toContain('<details>');
    expect(compact).toContain('🔻 **Heading b**: implemented → missing');
  });

  it('markdown escapes table pipes', () => {
    const x = report({ a: 'missing' });
    x.requirements[0]!.heading = 'a | b';
    expect(renderMarkdown(x)).toContain('a \\| b');
  });

  it('sarif: reports missing and partial at the spec line', () => {
    const sarif = JSON.parse(renderSarif(r));
    expect(sarif.version).toBe('2.1.0');
    const results = sarif.runs[0].results;
    expect(results.map((x: { ruleId: string }) => x.ruleId)).toEqual(['specsync/missing', 'specsync/partial']);
    expect(results[0].locations[0].physicalLocation).toEqual({ artifactLocation: { uri: 'docs/spec.md' }, region: { startLine: 6 } });
    expect(results[1].relatedLocations[0].physicalLocation.artifactLocation.uri).toBe('src/a.ts');
  });
});

describe('thresholds', () => {
  const ok = report({ a: 'implemented', b: 'implemented', c: 'missing' });
  it('passes, fails or errors according to config', () => {
    expect(evaluateThresholds(ok, undefined, testConfig())).toBe(EXIT.ok);
    expect(evaluateThresholds(ok, undefined, testConfig({ thresholds: { minScore: 80 } }))).toBe(EXIT.checkFailed);
    expect(evaluateThresholds(ok, undefined, testConfig({ thresholds: { failOn: ['missing'] } }))).toBe(EXIT.checkFailed);
    const regressed = diffReports(report({ a: 'implemented', b: 'implemented', c: 'implemented' }), ok);
    expect(evaluateThresholds(ok, regressed, testConfig({ thresholds: { failOn: ['regression'] } }))).toBe(EXIT.checkFailed);
    const broken = report({ a: 'implemented', b: 'error' });
    expect(evaluateThresholds(broken, undefined, testConfig())).toBe(EXIT.error);
    expect(evaluateThresholds(broken, undefined, testConfig({ thresholds: { failOn: [] } }))).toBe(EXIT.ok);
  });
});

describe('history', () => {
  it('appends runs, caps the file and finds the previous run for the same spec and repo', async () => {
    await withTempDir(async (dir) => {
      const path = `${dir}/h/history.json`;
      const a = report({ x: 'missing' });
      const other = { ...report({ x: 'missing' }), repoDir: 'elsewhere' };
      const b = report({ x: 'implemented' });
      await appendRun(a, path);
      await appendRun(other, path);
      await appendRun(b, path, 2);
      const runs = await readHistory(path);
      expect(runs).toHaveLength(2);
      expect(previousRun([a, other, b], b)?.runId).toBe(a.runId);
      expect(await readHistory(`${dir}/none.json`)).toEqual([]);
    });
  });
});
