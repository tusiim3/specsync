import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';
import type { DriftReport } from '../types.js';

/** Keep this many runs in the history file. */
export const HISTORY_LIMIT = 50;

interface HistoryFile {
  version: 1;
  runs: DriftReport[];
}

export async function readHistory(path: string): Promise<DriftReport[]> {
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(await readFile(path, 'utf-8')) as Partial<HistoryFile> & { runs?: unknown[] };
    // Older (pre-1.0) history files had a different report shape; keep only current ones.
    return (data.runs ?? []).filter(
      (r): r is DriftReport => typeof r === 'object' && r !== null && (r as DriftReport).schemaVersion === 1,
    );
  } catch {
    return [];
  }
}

export async function appendRun(report: DriftReport, path: string, limit = HISTORY_LIMIT): Promise<void> {
  const runs = await readHistory(path);
  runs.push(report);
  await mkdir(dirname(path), { recursive: true });
  const file: HistoryFile = { version: 1, runs: runs.slice(-limit) };
  await writeFile(path, JSON.stringify(file, null, 2), 'utf-8');
}

/** The most recent run before `current` for the same spec set and repo. */
export function previousRun(runs: DriftReport[], current: Pick<DriftReport, 'specFiles' | 'repoDir' | 'runId'>): DriftReport | undefined {
  const key = (r: Pick<DriftReport, 'specFiles' | 'repoDir'>) => `${[...r.specFiles].sort().join('|')}::${r.repoDir}`;
  const k = key(current);
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i]!;
    if (r.runId !== current.runId && key(r) === k) return r;
  }
  return undefined;
}

export async function readReport(path: string): Promise<DriftReport> {
  const data = JSON.parse(await readFile(path, 'utf-8')) as DriftReport;
  if (data.schemaVersion !== 1 || !Array.isArray(data.results)) {
    throw new Error(`${path} is not a SpecSync JSON report (schemaVersion 1).`);
  }
  return data;
}
