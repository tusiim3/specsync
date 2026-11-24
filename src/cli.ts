import { Command, InvalidArgumentError, Option } from 'commander';
import { writeFile, mkdir, readFile, appendFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { glob } from 'glob';
import { loadDotenv } from './env.js';
import { ConfigError, EMBEDDING_PROVIDERS, loadConfig, PROVIDER_NAMES, type Config, type ConfigInput } from './config.js';
import { resolveProvider } from './llm/resolver.js';
import { ConfigurationError, ProviderError, type LLMProvider } from './llm/provider.js';
import { BudgetError, FatalProviderError } from './agents/orchestrator.js';
import { InputError, isDryRunPlan, runPipeline, validateInputs } from './pipeline.js';
import { renderText } from './report/text.js';
import { renderMarkdown } from './report/markdown.js';
import { renderSarif } from './report/sarif.js';
import { diffReports, type ReportDiff } from './report/diff.js';
import { appendRun, previousRun, readHistory, readReport } from './store/history.js';
import { VERSION } from './version.js';
import type { DriftReport } from './types.js';

/** Exit codes, documented in the README. */
export const EXIT = { ok: 0, checkFailed: 1, error: 2 } as const;

const useColor = () => !!process.stdout.isTTY && !process.env['NO_COLOR'];

interface RunFlags {
  spec?: string[];
  repo?: string;
  config?: string;
  provider?: (typeof PROVIDER_NAMES)[number];
  model?: string;
  embeddings?: (typeof EMBEDDING_PROVIDERS)[number];
  embeddingsModel?: string;
  concurrency?: number;
  topK?: number;
  extract?: 'headings' | 'llm';
  format: 'text' | 'markdown' | 'json' | 'sarif';
  out?: string;
  md?: string;
  json?: string;
  sarif?: string;
  commentMd?: string;
  cache: boolean;
  cacheDir?: string;
  history: boolean;
  baseline?: string;
  linkBase?: string;
  dryRun?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  minScore?: number;
  failOn?: string[];
}

const int = (name: string) => (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError(`${name} must be a non-negative integer`);
  return n;
};

function addRunOptions(cmd: Command): Command {
  return cmd
    .option('-s, --spec <paths...>', 'spec document(s): .md, .txt, .docx, .pdf, .html')
    .option('-r, --repo <dir>', 'code directory to analyze (default: .)')
    .option('-c, --config <file>', 'config file (default: specsync.config.json if present)')
    .addOption(new Option('-p, --provider <name>', 'LLM provider').choices([...PROVIDER_NAMES]))
    .option('-m, --model <id>', 'model id for the provider')
    .addOption(
      new Option('-e, --embeddings <provider>', 'embeddings: auto (local, API fallback), local, gemini, openai').choices([
        ...EMBEDDING_PROVIDERS,
      ]),
    )
    .option('--embeddings-model <id>', 'embedding model id')
    .option('--concurrency <n>', 'parallel LLM calls', int('--concurrency'))
    .option('--top-k <n>', 'code chunks shown to the model per requirement', int('--top-k'))
    .addOption(new Option('--extract <mode>', 'requirement extraction').choices(['headings', 'llm']))
    .addOption(
      new Option('-f, --format <format>', 'stdout format').choices(['text', 'markdown', 'json', 'sarif']).default('text'),
    )
    .option('-o, --out <file>', 'also write the Markdown report here (alias of --md)')
    .option('--md <file>', 'write a Markdown report')
    .option('--json <file>', 'write the JSON report')
    .option('--sarif <file>', 'write a SARIF report for code scanning')
    .option('--comment-md <file>', 'write a compact Markdown summary for a PR comment')
    .option('--link-base <url>', 'link evidence in Markdown, e.g. https://github.com/o/r/blob/<sha>/')
    .option('--baseline <file>', 'JSON report to compare against (default: previous run in history)')
    .option('--no-cache', 'ignore and do not write the local cache')
    .option('--cache-dir <dir>', 'cache directory (default: .specsync/cache)')
    .option('--no-history', 'do not record this run in .specsync/history.json')
    .option('--dry-run', 'show what would run (calls, tokens) without calling the LLM')
    .option('-q, --quiet', 'no progress output')
    .option('-v, --verbose', 'show notes and evidence for every requirement in text output');
}

function overridesFrom(flags: RunFlags): Partial<ConfigInput> {
  const o: Record<string, unknown> = {};
  // Paths given on the command line are relative to the current directory,
  // paths in a config file are relative to that file.
  if (flags.spec) o['spec'] = flags.spec.map((s) => resolve(s));
  if (flags.repo) o['repo'] = resolve(flags.repo);
  if (flags.extract) o['extraction'] = flags.extract;
  if (flags.cacheDir) o['cacheDir'] = resolve(flags.cacheDir);
  const provider: Record<string, unknown> = {};
  if (flags.provider) provider['name'] = flags.provider;
  if (flags.model) provider['model'] = flags.model;
  if (flags.concurrency) provider['concurrency'] = flags.concurrency;
  if (Object.keys(provider).length) o['provider'] = provider;
  if (flags.topK) o['retrieval'] = { topK: flags.topK };
  const embeddings: Record<string, unknown> = {};
  if (flags.embeddings) embeddings['provider'] = flags.embeddings;
  if (flags.embeddingsModel) embeddings['model'] = flags.embeddingsModel;
  if (Object.keys(embeddings).length) o['embeddings'] = embeddings;
  const thresholds: Record<string, unknown> = {};
  if (flags.minScore !== undefined) thresholds['minScore'] = flags.minScore;
  if (flags.failOn) thresholds['failOn'] = flags.failOn;
  if (Object.keys(thresholds).length) o['thresholds'] = thresholds;
  return o as Partial<ConfigInput>;
}

/** A stand-in provider for --dry-run when no key is configured. */
const planningProvider: LLMProvider = {
  name: 'dry-run',
  model: 'none',
  complete: () => Promise.reject(new Error('dry run')),
};

async function execute(flags: RunFlags, mode: 'run' | 'check'): Promise<number> {
  const log = flags.quiet ? () => {} : (m: string) => process.stderr.write(`${m}\n`);
  const { config, baseDir } = await loadConfig({ cwd: process.cwd(), configPath: flags.config, overrides: overridesFrom(flags) });

  validateInputs(config, baseDir);
  let provider: LLMProvider;
  try {
    provider = await resolveProvider(config);
  } catch (err) {
    if (flags.dryRun && err instanceof ConfigurationError) provider = planningProvider;
    else throw err;
  }

  const { Cache } = await import('./cache/cache.js');
  const result = await runPipeline({
    config,
    baseDir,
    provider,
    cache: flags.cache ? undefined : Cache.disabled(),
    dryRun: flags.dryRun,
    log,
  });

  if (isDryRunPlan(result)) {
    const lines = [
      'Dry run (no LLM calls made):',
      `  requirements        ${result.requirements}`,
      `  code files/chunks   ${result.files} / ${result.chunks}`,
      `  cached verdicts     ${result.cachedVerdicts}`,
      `  LLM calls needed    ${result.plannedCalls}`,
      `  est. input tokens   ~${result.estimatedInputTokens.toLocaleString('en-US')}`,
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
    return EXIT.ok;
  }
  const report = result;

  // Compare against an explicit baseline or the previous run for this spec + repo.
  const historyPath = resolve(baseDir, config.historyFile);
  let diff: ReportDiff | undefined;
  let baseline: DriftReport | undefined;
  if (flags.baseline) baseline = await readReport(resolve(flags.baseline));
  else baseline = previousRun(await readHistory(historyPath), report);
  if (baseline) diff = diffReports(baseline, report);

  await emitOutputs(report, diff, flags);
  if (flags.history) await appendRun(report, historyPath);

  if (mode === 'check') return evaluateThresholds(report, diff, config, log);
  return report.complete ? EXIT.ok : EXIT.error;
}

async function writeOut(path: string, content: string) {
  const abs = resolve(path);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf-8');
}

async function emitOutputs(report: DriftReport, diff: ReportDiff | undefined, flags: RunFlags) {
  const mdOpts = { linkBase: flags.linkBase };
  switch (flags.format) {
    case 'json':
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      break;
    case 'markdown':
      process.stdout.write(renderMarkdown(report, diff, mdOpts));
      break;
    case 'sarif':
      process.stdout.write(`${renderSarif(report)}\n`);
      break;
    default:
      process.stdout.write(
        renderText(report, diff, { color: useColor(), verbose: flags.verbose, width: process.stdout.columns || 100 }),
      );
  }
  const md = flags.md ?? flags.out;
  if (md) await writeOut(md, renderMarkdown(report, diff, mdOpts));
  if (flags.json) await writeOut(flags.json, JSON.stringify(report, null, 2));
  if (flags.sarif) await writeOut(flags.sarif, renderSarif(report));
  if (flags.commentMd) await writeOut(flags.commentMd, renderMarkdown(report, diff, { ...mdOpts, compact: true }));
}

/** Apply CI thresholds; returns the exit code. */
export function evaluateThresholds(
  report: DriftReport,
  diff: ReportDiff | undefined,
  config: Config,
  log: (m: string) => void = () => {},
): number {
  const t = config.thresholds;
  const failures: string[] = [];
  if (t.failOn.includes('error') && !report.complete) {
    log(`check: ${report.counts.error} requirement(s) could not be checked`);
    return EXIT.error;
  }
  if (t.minScore !== undefined && (report.score ?? 0) < t.minScore) {
    failures.push(`coverage ${report.score ?? '--'} is below the minimum ${t.minScore}`);
  }
  if (t.failOn.includes('missing') && report.counts.missing > 0) failures.push(`${report.counts.missing} requirement(s) missing`);
  if (t.failOn.includes('partial') && report.counts.partial > 0) failures.push(`${report.counts.partial} requirement(s) partial`);
  if (t.failOn.includes('regression') && diff && diff.regressions.length > 0) {
    failures.push(`${diff.regressions.length} requirement(s) regressed since the baseline`);
  }
  for (const f of failures) log(`check failed: ${f}`);
  if (failures.length === 0) log('check passed');
  return failures.length ? EXIT.checkFailed : EXIT.ok;
}

const SPEC_CANDIDATES = [
  'SPEC.md',
  'spec.md',
  'PRD.md',
  'prd.md',
  'REQUIREMENTS.md',
  'requirements.md',
  'docs/spec.md',
  'docs/SPEC.md',
  'docs/prd.md',
  'docs/PRD.md',
  'docs/requirements.md',
];

async function init(opts: { force?: boolean; spec?: string; repo?: string }) {
  const path = resolve('specsync.config.json');
  if (existsSync(path) && !opts.force) {
    process.stderr.write('specsync.config.json already exists (use --force to overwrite).\n');
    return EXIT.error;
  }
  let spec = opts.spec;
  if (!spec) spec = SPEC_CANDIDATES.find((c) => existsSync(c));
  if (!spec) {
    const found = await glob(['docs/**/*.{md,docx,pdf}', '*.{docx,pdf}'], { ignore: ['**/node_modules/**'] });
    spec = found.find((f) => /spec|prd|requirement/i.test(f));
  }
  let repo = opts.repo;
  if (!repo) repo = ['src', 'lib', 'app'].find((d) => existsSync(d)) ?? '.';

  const config = {
    $schema: 'https://raw.githubusercontent.com/tusiim3/specsync/master/schema/specsync.schema.json',
    spec: spec ?? 'docs/spec.md',
    repo,
    exclude: [],
    provider: { name: 'auto' },
    thresholds: { minScore: 70, failOn: ['error', 'regression'] },
  };
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  process.stdout.write(`Wrote specsync.config.json (spec: ${config.spec}, repo: ${repo}).\n`);
  if (!spec) process.stdout.write('No spec found automatically; edit "spec" to point at your spec or PRD.\n');

  const gi = resolve('.gitignore');
  const line = '.specsync/';
  const current = existsSync(gi) ? await readFile(gi, 'utf-8') : '';
  if (!current.split(/\r?\n/).includes(line)) {
    await appendFile(gi, `${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`);
    process.stdout.write('Added .specsync/ (cache and history) to .gitignore.\n');
  }
  process.stdout.write('Next: set GEMINI_API_KEY (or ANTHROPIC_API_KEY / OPENAI_API_KEY) and run: npx specsync run\n');
  return EXIT.ok;
}

async function diffCommand(a: string | undefined, b: string | undefined, opts: { config?: string; format: string }) {
  let before: DriftReport | undefined;
  let after: DriftReport | undefined;
  if (a && b) {
    before = await readReport(resolve(a));
    after = await readReport(resolve(b));
  } else {
    const { config, baseDir } = await loadConfig({ cwd: process.cwd(), configPath: opts.config });
    const runs = await readHistory(resolve(baseDir, config.historyFile));
    after = runs[runs.length - 1];
    before = after ? previousRun(runs, after) : undefined;
    if (!after || !before) {
      process.stderr.write('Need two runs of the same spec and repo in history to compare (or pass two JSON reports).\n');
      return EXIT.error;
    }
  }
  const d = diffReports(before, after);
  if (opts.format === 'json') {
    process.stdout.write(`${JSON.stringify(d, null, 2)}\n`);
  } else {
    process.stdout.write(renderText(after, d, { color: useColor() }));
  }
  return d.regressions.length ? EXIT.checkFailed : EXIT.ok;
}

function failOnList(v: string): string[] {
  const allowed = ['missing', 'partial', 'error', 'regression'];
  const items = v.split(',').map((s) => s.trim()).filter(Boolean);
  for (const i of items) if (!allowed.includes(i)) throw new InvalidArgumentError(`--fail-on accepts ${allowed.join(', ')}`);
  return items;
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('specsync')
    .description('Find where your code has drifted from your spec.')
    .version(VERSION)
    .showHelpAfterError();

  program
    .command('init')
    .description('create specsync.config.json for this project')
    .option('--spec <path>', 'spec document')
    .option('--repo <dir>', 'code directory')
    .option('--force', 'overwrite an existing config')
    .action(async (opts) => {
      process.exitCode = await init(opts);
    });

  addRunOptions(program.command('run').description('analyze a spec against the code and print a drift report')).action(
    async (flags: RunFlags) => {
      process.exitCode = await execute(flags, 'run');
    },
  );

  addRunOptions(
    program
      .command('check')
      .description('like run, but exit non-zero when thresholds fail (for CI)')
      .option('--min-score <n>', 'minimum coverage score (0-100)', int('--min-score'))
      .option('--fail-on <list>', 'comma list: missing, partial, error, regression', failOnList),
  ).action(async (flags: RunFlags) => {
    process.exitCode = await execute(flags, 'check');
  });

  program
    .command('diff [before] [after]')
    .description('compare two JSON reports, or the last two runs in history')
    .option('-c, --config <file>', 'config file')
    .addOption(new Option('-f, --format <format>', 'output format').choices(['text', 'json']).default('text'))
    .action(async (before, after, opts) => {
      process.exitCode = await diffCommand(before, after, opts);
    });

  return program;
}

export async function main(argv = process.argv): Promise<void> {
  loadDotenv(process.cwd());
  try {
    await buildProgram().parseAsync(argv);
  } catch (err) {
    const known =
      err instanceof ConfigurationError ||
      err instanceof ConfigError ||
      err instanceof InputError ||
      err instanceof BudgetError ||
      err instanceof FatalProviderError ||
      err instanceof ProviderError;
    process.stderr.write(`\nspecsync: ${(err as Error).message}\n`);
    if (!known || process.env['DEBUG']) process.stderr.write(`${(err as Error).stack ?? ''}\n`);
    process.exitCode = EXIT.error;
  }
}
