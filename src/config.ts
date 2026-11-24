import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { z } from 'zod';

export const CONFIG_FILENAMES = ['specsync.config.json', '.specsyncrc.json'];

export const PROVIDER_NAMES = ['auto', 'gemini', 'anthropic', 'openai', 'ollama', 'openai-compatible'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export const EMBEDDING_PROVIDERS = ['auto', 'local', 'openai', 'gemini', 'openai-compatible'] as const;

/** Sections whose headings match these patterns are not treated as requirements. */
export const DEFAULT_IGNORE_SECTIONS = [
  '^(table of )?contents$',
  '^toc$',
  '^glossary$',
  '^references?$',
  '^(change ?log|revision history|document history)$',
  '^(out of scope|non[- ]?goals?|not in scope)$',
  '^appendix\\b',
  '^open questions$',
];

export const DEFAULT_EXCLUDE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/coverage/**',
  '**/vendor/**',
  '**/.git/**',
  '**/.specsync/**',
  '**/*.min.js',
  '**/*.d.ts',
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**',
  '**/test/**',
  '**/tests/**',
];

const ProviderSchema = z
  .object({
    name: z.enum(PROVIDER_NAMES).default('auto'),
    model: z.string().optional(),
    baseUrl: z.string().optional(),
    /** Name of the env var holding the key, for openai-compatible endpoints. */
    apiKeyEnv: z.string().optional(),
    concurrency: z.number().int().min(1).max(64).default(4),
    timeoutMs: z.number().int().min(1000).default(120_000),
    maxRetries: z.number().int().min(0).max(10).default(6),
    /** Pace calls to stay under a provider quota (e.g. 15 for Gemini's free tier). */
    requestsPerMinute: z.number().positive().optional(),
  })
  .default({ name: 'auto', concurrency: 4, timeoutMs: 120_000, maxRetries: 6 });

const EmbeddingsSchema = z
  .object({
    /** auto: local model, falling back to Gemini/OpenAI embeddings if it cannot be downloaded. */
    provider: z.enum(EMBEDDING_PROVIDERS).default('auto'),
    model: z.string().optional(),
    baseUrl: z.string().optional(),
    apiKeyEnv: z.string().optional(),
  })
  .default({ provider: 'auto' });

export const ConfigSchema = z.object({
  /** One or more spec documents (.md, .markdown, .txt, .docx, .pdf, .html). */
  spec: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
  /** Root of the code to analyze. */
  repo: z.string().default('.'),
  /** Globs (relative to repo) to include. Defaults to all supported source files. */
  include: z.array(z.string()).optional(),
  /** Globs (relative to repo) to exclude, added to the defaults. */
  exclude: z.array(z.string()).default([]),
  /** Set false to analyze test files too. */
  excludeTests: z.boolean().default(true),
  provider: ProviderSchema,
  embeddings: EmbeddingsSchema,
  retrieval: z
    .object({
      topK: z.number().int().min(1).max(50).default(8),
      /** Approximate token budget for code shown to the model per requirement. */
      maxCandidateTokens: z.number().int().min(500).default(8000),
    })
    .default({ topK: 8, maxCandidateTokens: 8000 }),
  /** "headings": one requirement per spec section. "llm": split sections into atomic requirements. */
  extraction: z.enum(['headings', 'llm']).default('headings'),
  ignoreSections: z.array(z.string()).default(DEFAULT_IGNORE_SECTIONS),
  thresholds: z
    .object({
      minScore: z.number().min(0).max(100).optional(),
      failOn: z.array(z.enum(['missing', 'partial', 'error', 'regression'])).default(['error']),
    })
    .default({ failOn: ['error'] }),
  surplus: z.object({ limit: z.number().int().min(0).default(25) }).default({ limit: 25 }),
  cacheDir: z.string().default('.specsync/cache'),
  historyFile: z.string().default('.specsync/history.json'),
  budget: z
    .object({
      maxLlmCalls: z.number().int().min(1).optional(),
      maxInputTokens: z.number().int().min(1).optional(),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Parse and validate a config object, with readable errors. */
export function parseConfig(input: unknown, source = 'config'): Config {
  const result = ConfigSchema.safeParse(input ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid ${source}:\n${issues}`);
  }
  return result.data;
}

/** Find a config file in `cwd`. */
export function findConfigFile(cwd: string): string | undefined {
  for (const name of CONFIG_FILENAMES) {
    const p = resolve(cwd, name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

export interface LoadedConfig {
  config: Config;
  /** Directory relative paths in the config resolve against. */
  baseDir: string;
  file?: string;
}

/**
 * Load config from an explicit path or the first config file in `cwd`,
 * then apply `overrides` (from CLI flags) on top.
 */
export async function loadConfig(opts: {
  cwd: string;
  configPath?: string;
  overrides?: Partial<ConfigInput>;
}): Promise<LoadedConfig> {
  const file = opts.configPath ? resolve(opts.cwd, opts.configPath) : findConfigFile(opts.cwd);
  let raw: Record<string, unknown> = {};
  if (file) {
    if (!existsSync(file)) throw new ConfigError(`Config file not found: ${file}`);
    try {
      raw = JSON.parse(await readFile(file, 'utf-8')) as Record<string, unknown>;
    } catch (err) {
      throw new ConfigError(`Could not parse ${file}: ${(err as Error).message}`);
    }
  }
  const merged = deepMerge(raw, (opts.overrides ?? {}) as Record<string, unknown>);
  const config = parseConfig(merged, file ?? 'options');
  return { config, baseDir: file ? dirname(file) : opts.cwd, file };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Merge b into a; undefined values in b are ignored, arrays replace. */
export function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k] as Record<string, unknown>, v) : v;
  }
  return out;
}

export function specList(config: Config): string[] {
  if (!config.spec) return [];
  return Array.isArray(config.spec) ? config.spec : [config.spec];
}
