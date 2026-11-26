import { existsSync } from 'fs';
import { isAbsolute, relative, resolve } from 'path';
import { Cache } from './cache/cache.js';
import type { Config } from './config.js';
import { specList } from './config.js';
import { CachedEmbedder, createEmbedder, type Embedder } from './embed/embedder.js';
import { analyzeRequirements } from './agents/orchestrator.js';
import { chunkFiles, chunkSearchText } from './ingest/code-chunker.js';
import { listSourceFiles } from './ingest/files.js';
import { extractAtomicRequirements } from './ingest/llm-extract.js';
import { normalizeToMarkdown } from './ingest/normalize.js';
import { requirementText, splitSections, subQueries } from './ingest/section-split.js';
import type { LLMProvider } from './llm/provider.js';
import { generateReport } from './report/generator.js';
import { HybridRetriever } from './search/retrieval.js';
import type { DriftReport, EmbeddedChunk, Requirement } from './types.js';

export interface PipelineOptions {
  config: Config;
  /** Directory config-relative paths resolve against. */
  baseDir: string;
  provider: LLMProvider;
  /** Injectable for tests; defaults to the configured embedder. */
  embedder?: Embedder;
  cache?: Cache;
  dryRun?: boolean;
  log?: (msg: string) => void;
  /** Test hook to skip backoff delays. */
  sleep?: (ms: number) => Promise<void>;
}

export interface DryRunPlan {
  requirements: number;
  files: number;
  chunks: number;
  plannedCalls: number;
  cachedVerdicts: number;
  estimatedInputTokens: number;
}

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

const toPosix = (p: string) => p.split('\\').join('/');

/** Path shown in reports: relative to cwd when inside it, so reports are portable. */
export function displayPath(abs: string, cwd = process.cwd()): string {
  const rel = relative(cwd, abs);
  if (rel === '') return '.';
  return toPosix(!rel.startsWith('..') && !isAbsolute(rel) ? rel : abs);
}

/** Check that the spec files and repo exist; returns their absolute paths. */
export function validateInputs(config: Config, baseDir: string): { specPaths: string[]; repoDir: string } {
  const specPaths = specList(config).map((s) => resolve(baseDir, s));
  if (specPaths.length === 0) throw new InputError('No spec given. Pass --spec or set "spec" in specsync.config.json.');
  for (const p of specPaths) if (!existsSync(p)) throw new InputError(`Spec file not found: ${p}`);
  const repoDir = resolve(baseDir, config.repo);
  if (!existsSync(repoDir)) throw new InputError(`Repo directory not found: ${repoDir}`);
  return { specPaths, repoDir };
}

export async function loadRequirements(specPaths: string[], config: Config): Promise<Requirement[]> {
  const all: Requirement[] = [];
  const ids = new Set<string>();
  for (const abs of specPaths) {
    const markdown = await normalizeToMarkdown(abs);
    const reqs = splitSections(markdown, { file: displayPath(abs), ignoreSections: config.ignoreSections });
    for (const r of reqs) {
      // Keep ids unique across multiple spec files.
      let id = r.id;
      for (let n = 2; ids.has(id); n++) id = `${r.id}-${n}`;
      ids.add(id);
      all.push({ ...r, id });
    }
  }
  return all;
}

/**
 * Run the whole analysis: ingest specs, chunk and embed code, retrieve candidates,
 * judge each requirement, and build the report.
 */
export async function runPipeline(opts: PipelineOptions): Promise<DriftReport | DryRunPlan> {
  const started = Date.now();
  const { config, provider } = opts;
  const log = opts.log ?? (() => {});

  const { specPaths, repoDir } = validateInputs(config, opts.baseDir);

  const cache = opts.cache ?? new Cache(resolve(opts.baseDir, config.cacheDir));
  await cache.load();

  log('Reading spec...');
  let requirements = await loadRequirements(specPaths, config);
  if (requirements.length === 0) {
    throw new InputError(
      'No requirements found. SpecSync reads one requirement per heading section; make sure the spec has headings (## Section) with text under them.',
    );
  }
  if (config.extraction === 'llm' && !opts.dryRun) {
    requirements = await extractAtomicRequirements(requirements, provider, cache, {
      concurrency: config.provider.concurrency,
      maxRetries: config.provider.maxRetries,
      log,
    });
  }
  log(`  ${requirements.length} requirements from ${specPaths.length} spec file(s)`);

  log('Reading code...');
  const files = await listSourceFiles(repoDir, {
    include: config.include,
    exclude: config.exclude,
    excludeTests: config.excludeTests,
  });
  const chunks = await chunkFiles(repoDir, files);
  log(`  ${chunks.length} chunks from ${files.length} files`);
  if (chunks.length === 0) log('  Warning: no source code found; every requirement will be reported missing.');

  const embedder = new CachedEmbedder(opts.embedder ?? createEmbedder(config, (m) => log(`  ${m}`)), cache);
  log('Embedding...');
  const searchTexts = chunks.map(chunkSearchText);
  const chunkVectors = await embedder.embed(searchTexts);
  const embedded: EmbeddedChunk[] = chunks.map((c, i) => ({ ...c, vector: chunkVectors[i]! }));
  // One query for the whole requirement plus one per list item it enumerates.
  const queryTexts = requirements.map((r) => [requirementText(r), ...subQueries(r)]);
  const flatVectors = await embedder.embed(queryTexts.flat());
  let cursor = 0;
  const withVectors = requirements.map((r, i) => ({
    ...r,
    queries: queryTexts[i]!.map((text, j) => ({
      text,
      vector: flatVectors[cursor++]!,
      // Each list item counts as much as the whole requirement, split among items.
      weight: j === 0 ? 1 : 1 / Math.max(1, Math.sqrt(queryTexts[i]!.length - 1)),
    })),
  }));
  const retriever = new HybridRetriever(embedded, searchTexts);

  log(opts.dryRun ? 'Planning...' : `Checking requirements with ${provider.name} (${provider.model})...`);
  const analysis = await analyzeRequirements(withVectors, retriever, provider, cache, {
    topK: config.retrieval.topK,
    maxCandidateTokens: config.retrieval.maxCandidateTokens,
    concurrency: config.provider.concurrency,
    maxRetries: config.provider.maxRetries,
    requestsPerMinute: config.provider.requestsPerMinute,
    budget: config.budget,
    dryRun: opts.dryRun,
    log: (m) => log(`  ${m}`),
    sleep: opts.sleep,
  });
  await cache.save();

  if (opts.dryRun) {
    return {
      requirements: requirements.length,
      files: files.length,
      chunks: chunks.length,
      plannedCalls: analysis.plannedCalls,
      cachedVerdicts: analysis.cacheHits,
      estimatedInputTokens: analysis.estimatedInputTokens,
    };
  }

  return generateReport({
    specFiles: specPaths.map((p) => displayPath(p)),
    repoDir: displayPath(repoDir),
    provider: provider.name,
    model: provider.model,
    requirements,
    results: analysis.results,
    chunks,
    surplusLimit: config.surplus.limit,
    stats: {
      files: files.length,
      chunks: chunks.length,
      llmCalls: analysis.llmCalls,
      cacheHits: analysis.cacheHits,
      inputTokens: analysis.inputTokens,
      outputTokens: analysis.outputTokens,
      durationMs: Date.now() - started,
    },
  });
}

export function isDryRunPlan(x: DriftReport | DryRunPlan): x is DryRunPlan {
  return 'plannedCalls' in x;
}
