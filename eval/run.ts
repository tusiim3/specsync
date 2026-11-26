/**
 * Measure verdict accuracy against labelled cases with a real provider.
 *
 *   npm run eval                       # provider from env (auto), local embeddings
 *   npm run eval -- --config my.json   # merge a config file (e.g. different embeddings)
 *   npm run eval -- --model gemini-3.5-flash --out eval/results.md
 *
 * Each case runs with the cache disabled, so results reflect the model, not old runs.
 */
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { parseArgs } from 'util';
import { loadDotenv } from '../src/env.js';
import { loadConfig } from '../src/config.js';
import { resolveProvider } from '../src/llm/resolver.js';
import { runPipeline, isDryRunPlan } from '../src/pipeline.js';
import { Cache } from '../src/cache/cache.js';
import type { Verdict } from '../src/types.js';

interface Case {
  name: string;
  spec: string;
  repo: string;
  setup?: string;
  labels: Record<string, Verdict[]>;
}

const VERDICTS: Verdict[] = ['implemented', 'partial', 'missing', 'not-verifiable', 'error'];

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    case: { type: 'string', multiple: true },
    out: { type: 'string' },
  },
});

loadDotenv(process.cwd());
const root = resolve(import.meta.dirname, '..');
const { cases } = JSON.parse(await readFile(resolve(root, 'eval/cases.json'), 'utf-8')) as { cases: Case[] };

const rows: string[] = [];
let correct = 0;
let total = 0;
// Gap detection: how well "missing" (strictly labelled) is found.
let tp = 0;
let fp = 0;
let fn = 0;
const confusion = new Map<string, number>();
let providerLabel = '';

for (const c of cases) {
  if (values.case && !values.case.includes(c.name)) continue;
  const repo = resolve(root, c.repo);
  if (!existsSync(repo)) {
    console.error(`skip ${c.name}: ${c.repo} not found${c.setup ? ` (run: ${c.setup})` : ''}`);
    continue;
  }
  const overrides: Record<string, unknown> = { spec: resolve(root, c.spec), repo };
  if (values.provider || values.model) overrides['provider'] = { name: values.provider, model: values.model };
  const { config, baseDir } = await loadConfig({ cwd: process.cwd(), configPath: values.config, overrides });
  const provider = await resolveProvider(config);
  providerLabel = `${provider.name} ${provider.model}`;
  console.error(`\n${c.name}: ${providerLabel}`);
  const report = await runPipeline({
    config,
    baseDir,
    provider,
    cache: Cache.disabled(),
    log: (m) => console.error(m),
  });
  if (isDryRunPlan(report)) throw new Error('unexpected dry run');

  for (const [id, accepted] of Object.entries(c.labels)) {
    const got = report.results.find((r) => r.requirementId === id)?.verdict ?? 'error';
    const ok = accepted.includes(got);
    total++;
    if (ok) correct++;
    const key = `${accepted[0]}→${got}`;
    confusion.set(key, (confusion.get(key) ?? 0) + 1);
    const strictMissing = accepted.length === 1 && accepted[0] === 'missing';
    const notMissing = !accepted.includes('missing');
    if (got === 'missing' && strictMissing) tp++;
    else if (got === 'missing' && notMissing) fp++;
    else if (got !== 'missing' && strictMissing) fn++;
    rows.push(`| ${c.name} | ${id} | ${accepted.join(' / ')} | ${got} | ${ok ? '✅' : '❌'} |`);
  }
  const missingLabels = Object.keys(c.labels).filter((id) => !report.requirements.some((r) => r.id === id));
  if (missingLabels.length) console.error(`  warning: labels with no matching requirement: ${missingLabels.join(', ')}`);
}

const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${Math.round((n / d) * 100)}%`);
const lines = [
  `## SpecSync eval: ${providerLabel}`,
  '',
  `- Verdict accuracy: **${correct}/${total} (${pct(correct, total)})**`,
  `- Gap detection: precision ${pct(tp, tp + fp)}, recall ${pct(tp, tp + fn)}`,
  '',
  '| Case | Requirement | Expected | Got | |',
  '|---|---|---|---|---|',
  ...rows,
  '',
  'Confusion (first expected → got): ' +
    [...confusion.entries()]
      .sort((a, b) => VERDICTS.indexOf(a[0].split('→')[0] as Verdict) - VERDICTS.indexOf(b[0].split('→')[0] as Verdict))
      .map(([k, v]) => `${k} ×${v}`)
      .join(', '),
  '',
];
const md = lines.join('\n');
process.stdout.write(md);
if (values.out) await writeFile(values.out, md);
