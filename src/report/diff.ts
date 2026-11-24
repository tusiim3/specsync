import type { DriftReport, Requirement, Verdict } from '../types.js';

export interface VerdictChange {
  requirement: Requirement;
  from: Verdict;
  to: Verdict;
}

export interface ReportDiff {
  scoreBefore: number | null;
  scoreAfter: number | null;
  /** Coverage got worse: implemented→partial/missing, partial→missing. */
  regressions: VerdictChange[];
  /** Coverage got better. */
  improvements: VerdictChange[];
  /** Other verdict changes (to/from not-verifiable or error). */
  otherChanges: VerdictChange[];
  added: Requirement[];
  removed: Requirement[];
}

const RANK: Partial<Record<Verdict, number>> = { implemented: 2, partial: 1, missing: 0 };

/** Compare two runs requirement by requirement (matched by id). */
export function diffReports(before: DriftReport, after: DriftReport): ReportDiff {
  const prev = new Map(before.results.map((r) => [r.requirementId, r.verdict]));
  const prevReqs = new Map(before.requirements.map((r) => [r.id, r]));
  const currIds = new Set(after.requirements.map((r) => r.id));
  const diff: ReportDiff = {
    scoreBefore: before.score,
    scoreAfter: after.score,
    regressions: [],
    improvements: [],
    otherChanges: [],
    added: [],
    removed: before.requirements.filter((r) => !currIds.has(r.id)),
  };

  for (const req of after.requirements) {
    const to = after.results.find((r) => r.requirementId === req.id)?.verdict;
    const from = prev.get(req.id);
    if (!prevReqs.has(req.id) || !from) {
      diff.added.push(req);
      continue;
    }
    if (!to || to === from) continue;
    const change = { requirement: req, from, to };
    const a = RANK[from];
    const b = RANK[to];
    if (a !== undefined && b !== undefined) (b < a ? diff.regressions : diff.improvements).push(change);
    else diff.otherChanges.push(change);
  }
  return diff;
}

export function hasChanges(d: ReportDiff): boolean {
  return (
    d.scoreBefore !== d.scoreAfter ||
    d.regressions.length + d.improvements.length + d.otherChanges.length + d.added.length + d.removed.length > 0
  );
}
