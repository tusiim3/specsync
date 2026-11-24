import pLimit from 'p-limit';
import type { Cache } from '../cache/cache.js';
import type { LLMProvider } from '../llm/provider.js';
import { ProviderError } from '../llm/provider.js';
import { withRetry } from '../llm/retry.js';
import type { HybridRetriever, Query } from '../search/retrieval.js';
import type { Requirement, RequirementResult } from '../types.js';
import {
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  VERDICT_SCHEMA,
  buildPrompt,
  interpretResponse,
  renderCandidates,
} from './verdict.js';
import { requirementText } from '../ingest/section-split.js';

export interface AnalyzeOptions {
  topK: number;
  maxCandidateTokens: number;
  concurrency: number;
  maxRetries: number;
  /** Abort before any call if the uncached work exceeds these. */
  budget?: { maxLlmCalls?: number; maxInputTokens?: number };
  dryRun?: boolean;
  log?: (msg: string) => void;
  /** Test hook to skip backoff delays. */
  sleep?: (ms: number) => Promise<void>;
}

export interface PlannedCall {
  requirement: Requirement;
  prompt: string;
  cacheKey: string;
  cached?: Omit<RequirementResult, 'cached'>;
  candidates: ReturnType<typeof renderCandidates>['candidates'];
}

export interface AnalyzeResult {
  results: RequirementResult[];
  llmCalls: number;
  cacheHits: number;
  inputTokens: number;
  outputTokens: number;
  /** Estimated input tokens for the calls that were (or would be) made. */
  estimatedInputTokens: number;
  plannedCalls: number;
}

export class BudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetError';
  }
}

export class FatalProviderError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'FatalProviderError';
  }
}

const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/**
 * Judge every requirement against its retrieved code, in parallel.
 * Verdicts are cached by (model, prompt version, requirement text, candidate code),
 * so unchanged requirements cost nothing on the next run.
 */
export async function analyzeRequirements(
  requirements: Array<Requirement & { queries: Query[] }>,
  retriever: HybridRetriever,
  provider: LLMProvider,
  cache: Cache,
  opts: AnalyzeOptions,
): Promise<AnalyzeResult> {
  const log = opts.log ?? (() => {});

  // Plan: retrieve candidates and check the cache before spending anything.
  const plan: PlannedCall[] = requirements.map((req) => {
    const text = requirementText(req);
    // Requirements that enumerate several behaviours get a larger candidate set.
    const k = Math.min(opts.topK + Math.max(0, req.queries.length - 1), opts.topK * 2);
    const chunks = retriever.search(req.queries, k);
    const { text: candidatesText, candidates } = renderCandidates(chunks, opts.maxCandidateTokens);
    const prompt = buildPrompt(req, candidatesText);
    const cacheKey = cache.key(
      'verdict',
      PROMPT_VERSION,
      provider.model,
      req.id,
      text,
      candidates.map((c) => `${c.label}=${c.chunk.id}#${c.chunk.hash}`).join(','),
    );
    const cached = cache.getVerdict(cacheKey);
    return { requirement: req, prompt, cacheKey, cached, candidates };
  });

  const uncached = plan.filter((p) => !p.cached);
  const estimatedInputTokens = uncached.reduce(
    (sum, p) => sum + estimateTokens(SYSTEM_PROMPT) + estimateTokens(p.prompt),
    0,
  );

  const base = {
    llmCalls: 0,
    cacheHits: plan.length - uncached.length,
    inputTokens: 0,
    outputTokens: 0,
    estimatedInputTokens,
    plannedCalls: uncached.length,
  };

  if (opts.dryRun) return { ...base, results: [] };

  const { maxLlmCalls, maxInputTokens } = opts.budget ?? {};
  if (maxLlmCalls !== undefined && uncached.length > maxLlmCalls) {
    throw new BudgetError(`This run needs ${uncached.length} LLM calls, over the budget of ${maxLlmCalls}.`);
  }
  if (maxInputTokens !== undefined && estimatedInputTokens > maxInputTokens) {
    throw new BudgetError(
      `This run needs about ${estimatedInputTokens} input tokens, over the budget of ${maxInputTokens}.`,
    );
  }

  const limit = pLimit(opts.concurrency);
  let fatal: FatalProviderError | null = null;
  const totals = { llmCalls: 0, inputTokens: 0, outputTokens: 0 };
  const width = String(plan.length).length;
  let done = 0;

  const results = await Promise.all(
    plan.map((p) =>
      limit(async (): Promise<RequirementResult> => {
        const req = p.requirement;
        const tag = () => `[${String(++done).padStart(width, '0')}/${plan.length}]`;
        if (p.cached) {
          log(`${tag()} ${symbolFor(p.cached.verdict)} ${p.cached.verdict.padEnd(14)} ${req.heading} (cached)`);
          return { ...p.cached, cached: true };
        }
        if (fatal) {
          return errorResult(req.id, 'skipped after a fatal provider error');
        }
        try {
          const result = await judge(p, provider, opts, totals, log);
          cache.setVerdict(p.cacheKey, result);
          log(`${tag()} ${symbolFor(result.verdict)} ${result.verdict.padEnd(14)} ${req.heading}`);
          return { ...result, cached: false };
        } catch (err) {
          if (err instanceof ProviderError && err.fatal) {
            fatal ??= new FatalProviderError(err.message, err);
          }
          const msg = err instanceof Error ? err.message : String(err);
          log(`${tag()} ! error          ${req.heading}: ${msg}`);
          return errorResult(req.id, msg);
        }
      }),
    ),
  );

  if (fatal) throw fatal;
  return { ...base, ...totals, results };
}

async function judge(
  p: PlannedCall,
  provider: LLMProvider,
  opts: AnalyzeOptions,
  totals: { llmCalls: number; inputTokens: number; outputTokens: number },
  log: (msg: string) => void,
): Promise<Omit<RequirementResult, 'cached'>> {
  // One extra attempt if the reply is not valid against the schema.
  for (let attempt = 0; ; attempt++) {
    const res = await withRetry(
      () => {
        totals.llmCalls++;
        return provider.complete({
          system: SYSTEM_PROMPT,
          prompt: p.prompt,
          schema: VERDICT_SCHEMA,
          maxOutputTokens: 16000,
        });
      },
      {
        maxRetries: opts.maxRetries,
        sleep: opts.sleep,
        onRetry: (n, delay, err) =>
          log(`      retry ${n}/${opts.maxRetries} for "${p.requirement.heading}" in ${Math.round(delay / 1000)}s: ${err.message}`),
      },
    );
    totals.inputTokens += res.inputTokens;
    totals.outputTokens += res.outputTokens;
    try {
      return interpretResponse(p.requirement, res.text, p.candidates);
    } catch (err) {
      if (attempt >= 1) {
        throw new Error(`invalid model response: ${(err as Error).message}`);
      }
    }
  }
}

function errorResult(requirementId: string, error: string): RequirementResult {
  return {
    requirementId,
    verdict: 'error',
    confidence: 0,
    evidence: [],
    notes: '',
    cached: false,
    error,
  };
}

export function symbolFor(verdict: RequirementResult['verdict']): string {
  switch (verdict) {
    case 'implemented':
      return '✓';
    case 'partial':
      return '◐';
    case 'missing':
      return '✗';
    case 'not-verifiable':
      return '–';
    default:
      return '!';
  }
}
