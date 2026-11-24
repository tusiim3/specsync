import { ProviderError } from './provider.js';

export interface RetryOptions {
  maxRetries: number;
  /** Base delay for exponential backoff. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Called before each retry, e.g. for logging. */
  onRetry?: (attempt: number, delayMs: number, err: ProviderError) => void;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `fn`, retrying retryable ProviderErrors with exponential backoff and full jitter.
 * Honors a provider's Retry-After when it is longer than the computed delay.
 * Non-ProviderErrors and non-retryable errors are rethrown immediately.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const base = opts.baseDelayMs ?? 1000;
  const max = opts.maxDelayMs ?? 30_000;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof ProviderError) || !err.retryable || attempt >= opts.maxRetries) {
        throw err;
      }
      const backoff = Math.min(max, base * 2 ** attempt);
      const jittered = Math.round(backoff / 2 + random() * (backoff / 2));
      const delay = Math.min(max * 2, Math.max(jittered, err.retryAfterMs ?? 0));
      opts.onRetry?.(attempt + 1, delay, err);
      await sleep(delay);
    }
  }
}
