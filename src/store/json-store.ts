import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import type { DriftReport } from '../types.js';

interface Store {
  runs: DriftReport[];
}

export async function appendRun(report: DriftReport, storePath: string): Promise<void> {
  let store: Store = { runs: [] };

  if (existsSync(storePath)) {
    try {
      const raw = await readFile(storePath, 'utf-8');
      store = JSON.parse(raw) as Store;
    } catch {
      store = { runs: [] };
    }
  }

  store.runs.push(report);
  await writeFile(storePath, JSON.stringify(store, null, 2), 'utf-8');
}
