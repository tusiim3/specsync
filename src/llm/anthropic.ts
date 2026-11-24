import Anthropic from '@anthropic-ai/sdk';
import {
  ProviderError,
  classifyStatus,
  parseRetryAfter,
  type CompletionRequest,
  type CompletionResult,
  type LLMProvider,
} from './provider.js';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

/** Models that accept server-side refusal fallbacks (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set([
  'claude-fable-5-2',
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
]);

export interface AnthropicOptions {
  model: string;
  apiKey?: string;
  baseURL?: string;
  timeoutMs: number;
}

/** Claude via the official Anthropic SDK, with JSON-schema structured output. */
export class AnthropicProvider implements LLMProvider {
  readonly name = 'Anthropic';
  readonly model: string;
  private readonly client: Anthropic;

  constructor(opts: AnthropicOptions) {
    this.model = opts.model;
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      timeout: opts.timeoutMs,
      maxRetries: 0,
    });
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const body = {
      model: this.model,
      max_tokens: req.maxOutputTokens ?? 16000,
      system: req.system,
      messages: [{ role: 'user' as const, content: req.prompt }],
      output_config: { format: { type: 'json_schema' as const, schema: req.schema.schema } },
    };
    try {
      // On models that support it, let the API re-run a refused request on a fallback model.
      const response = FALLBACK_MODELS.has(this.model)
        ? await this.client.beta.messages.create({
            ...body,
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
          })
        : await this.client.messages.create(body);

      if (response.stop_reason === 'refusal') {
        throw new ProviderError('Claude declined to answer this request (refusal)', { retryable: false });
      }
      if (response.stop_reason === 'max_tokens') {
        throw new ProviderError('Claude hit max_tokens before finishing the verdict', { retryable: false });
      }
      let text = '';
      for (const block of response.content) {
        if (block.type === 'text') text += block.text;
      }
      return {
        text,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
    } catch (err) {
      throw toProviderError(err);
    }
  }
}

function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new ProviderError('Anthropic request timed out', { retryable: true, cause: err });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError(`Anthropic connection failed: ${err.message}`, { retryable: true, cause: err });
  }
  if (err instanceof Anthropic.APIError) {
    const { retryable, fatal } = classifyStatus(err.status);
    return new ProviderError(`Anthropic API error ${err.status ?? ''}: ${err.message}`.trim(), {
      status: err.status,
      retryable,
      fatal,
      retryAfterMs: parseRetryAfter(err.headers?.get?.('retry-after')),
      cause: err,
    });
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new ProviderError(`Anthropic request failed: ${msg}`, { retryable: true, cause: err });
}
