import OpenAI from 'openai';
import {
  ProviderError,
  classifyStatus,
  parseRetryAfter,
  retryHintFromMessage,
  type CompletionRequest,
  type CompletionResult,
  type LLMProvider,
} from './provider.js';

export interface OpenAICompatibleOptions {
  name: string;
  model: string;
  apiKey: string;
  baseURL?: string;
  timeoutMs: number;
  /** Some local servers (older Ollama, LM Studio) only support json_object mode. */
  jsonMode?: 'schema' | 'object';
}

/**
 * Any OpenAI-compatible Chat Completions endpoint: OpenAI itself, Gemini's
 * OpenAI-compatible endpoint, Ollama's /v1, OpenRouter, Groq, LM Studio, vLLM.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  private readonly client: OpenAI;
  private readonly jsonMode: 'schema' | 'object';

  constructor(opts: OpenAICompatibleOptions) {
    this.name = opts.name;
    this.model = opts.model;
    this.jsonMode = opts.jsonMode ?? 'schema';
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      timeout: opts.timeoutMs,
      // SpecSync's own withRetry owns retries so backoff is consistent across providers.
      maxRetries: 0,
    });
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.prompt },
        ],
        response_format:
          this.jsonMode === 'schema'
            ? {
                type: 'json_schema',
                json_schema: { name: req.schema.name, schema: req.schema.schema, strict: true },
              }
            : { type: 'json_object' },
        ...(req.maxOutputTokens ? { max_completion_tokens: req.maxOutputTokens } : {}),
      });
      const choice = response.choices[0];
      const text = choice?.message?.content ?? '';
      if (!text) {
        const reason = choice?.finish_reason ?? 'unknown';
        throw new ProviderError(`${this.name} returned an empty response (finish_reason: ${reason})`, {
          retryable: reason !== 'content_filter',
        });
      }
      return {
        text,
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      };
    } catch (err) {
      throw toProviderError(this.name, err);
    }
  }
}

export function toProviderError(name: string, err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    return new ProviderError(`${name} request timed out`, { retryable: true, cause: err });
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new ProviderError(`${name} connection failed: ${err.message}`, { retryable: true, cause: err });
  }
  if (err instanceof OpenAI.APIError) {
    const { retryable, fatal } = classifyStatus(err.status);
    return new ProviderError(`${name} API error ${err.status ?? ''}: ${err.message}`.trim(), {
      status: err.status,
      retryable,
      fatal,
      retryAfterMs: parseRetryAfter(err.headers?.get?.('retry-after')) ?? retryHintFromMessage(err.message),
      cause: err,
    });
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new ProviderError(`${name} request failed: ${msg}`, { retryable: true, cause: err });
}
