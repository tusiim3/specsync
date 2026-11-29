/** Provider-neutral interface for the structured completions SpecSync needs. */

export interface JsonSchemaSpec {
  /** Short identifier, letters/digits/underscores. */
  name: string;
  schema: Record<string, unknown>;
}

export interface CompletionRequest {
  system: string;
  prompt: string;
  /** The response must be a JSON object matching this schema. */
  schema: JsonSchemaSpec;
  maxOutputTokens?: number;
}

export interface CompletionResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LLMProvider {
  /** Display name, e.g. "Gemini". */
  readonly name: string;
  readonly model: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

/** An error from a provider call, classified for retry decisions. */
export class ProviderError extends Error {
  readonly status?: number;
  readonly retryable: boolean;
  /** Fatal errors (bad key, unknown model) stop the whole run. */
  readonly fatal: boolean;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    opts: { status?: number; retryable?: boolean; fatal?: boolean; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'ProviderError';
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    this.fatal = opts.fatal ?? false;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/**
 * Classify an HTTP status into retry/fatal buckets.
 * 408/409/429/5xx are retryable; 401/403/404 are fatal (bad key, no access, unknown model).
 */
export function classifyStatus(status: number | undefined): { retryable: boolean; fatal: boolean } {
  if (status === undefined) return { retryable: true, fatal: false };
  if (status === 408 || status === 409 || status === 429 || status >= 500) {
    return { retryable: true, fatal: false };
  }
  if (status === 401 || status === 403 || status === 404) return { retryable: false, fatal: true };
  return { retryable: false, fatal: false };
}

/** Parse a Retry-After header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** Some APIs (Gemini) put the wait in the message: "Please retry in 42.9s". */
export function retryHintFromMessage(message: string): number | undefined {
  const m = /retry in (\d+(?:\.\d+)?)\s*s/i.exec(message);
  return m ? Math.ceil(Number(m[1]) * 1000) : undefined;
}

export class ConfigurationError extends Error {
  constructor(message?: string) {
    super(
      message ??
        [
          'No LLM provider configured.',
          '',
          'Set one of these environment variables (or add it to a .env file):',
          '  GEMINI_API_KEY      https://aistudio.google.com (free tier works)',
          '  ANTHROPIC_API_KEY   https://console.anthropic.com',
          '  OPENAI_API_KEY      https://platform.openai.com',
          '',
          'Or run a local model with Ollama (https://ollama.com):',
          '  ollama serve && ollama pull qwen3:8b',
          '',
          'Then re-run, or pick one explicitly with --provider.',
        ].join('\n'),
    );
    this.name = 'ConfigurationError';
  }
}
