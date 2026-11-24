import { randomUUID } from 'crypto';
import type {
  CodeChunk,
  DriftReport,
  Requirement,
  RequirementResult,
  RunStats,
  SurplusItem,
  VerdictCounts,
} from '../types.js';

/** Weight of each verdict in the coverage score. Excluded verdicts are absent. */
export const SCORE_WEIGHTS: Partial<Record<RequirementResult['verdict'], number>> = {
  implemented: 1,
  partial: 0.5,
  missing: 0,
};

export function countVerdicts(results: RequirementResult[]): VerdictCounts {
  const c: VerdictCounts = { implemented: 0, partial: 0, missing: 0, notVerifiable: 0, error: 0 };
  for (const r of results) {
    if (r.verdict === 'not-verifiable') c.notVerifiable++;
    else c[r.verdict]++;
  }
  return c;
}

/**
 * Coverage score, 0..100: implemented counts 1, partial 0.5, missing 0.
 * Not-verifiable and errored requirements are left out of the denominator.
 * Returns null when there is nothing to score.
 */
export function computeScore(results: RequirementResult[]): number | null {
  let sum = 0;
  let n = 0;
  for (const r of results) {
    const w = SCORE_WEIGHTS[r.verdict];
    if (w === undefined) continue;
    sum += w;
    n++;
  }
  return n === 0 ? null : Math.round((sum / n) * 100);
}

/**
 * Public symbols that no implemented/partial requirement cites as evidence.
 * These are candidates for undocumented behaviour (or a spec that is behind the code).
 */
export function findSurplus(chunks: CodeChunk[], results: RequirementResult[]): { items: SurplusItem[]; publicSymbols: number } {
  const cited = new Set<string>();
  for (const r of results) {
    if (r.verdict === 'implemented' || r.verdict === 'partial') for (const e of r.evidence) cited.add(e.chunkId);
  }
  const publicChunks = chunks.filter((c) => c.exported && c.kind !== 'module' && c.kind !== 'window');
  const items = publicChunks
    .filter((c) => !cited.has(c.id))
    .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine)
    .map((c) => ({
      chunkId: c.id,
      filePath: c.filePath,
      startLine: c.startLine,
      endLine: c.endLine,
      symbol: c.symbol,
      kind: c.kind,
    }));
  return { items, publicSymbols: publicChunks.length };
}

export interface GenerateReportInput {
  specFiles: string[];
  repoDir: string;
  provider: string;
  model: string;
  requirements: Requirement[];
  results: RequirementResult[];
  chunks: CodeChunk[];
  surplusLimit: number;
  stats: RunStats;
}

export function generateReport(input: GenerateReportInput): DriftReport {
  // Keep results in spec order.
  const byId = new Map(input.results.map((r) => [r.requirementId, r]));
  const results = input.requirements.map((req) => byId.get(req.id)).filter((r): r is RequirementResult => !!r);
  const counts = countVerdicts(results);
  const surplus = findSurplus(input.chunks, results);
  return {
    schemaVersion: 1,
    runId: randomUUID(),
    timestamp: new Date().toISOString(),
    specFiles: input.specFiles,
    repoDir: input.repoDir,
    provider: input.provider,
    model: input.model,
    score: computeScore(results),
    complete: counts.error === 0,
    counts,
    requirements: input.requirements,
    results,
    surplus: surplus.items.slice(0, input.surplusLimit),
    publicSymbols: surplus.publicSymbols,
    stats: input.stats,
  };
}

export function resultFor(report: DriftReport, id: string): RequirementResult | undefined {
  return report.results.find((r) => r.requirementId === id);
}
