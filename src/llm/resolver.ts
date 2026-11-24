import type { Config } from '../config.js';
import { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from './anthropic.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { ConfigurationError, type LLMProvider } from './provider.js';

export const GEMINI_OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';
export const DEFAULT_MODELS = {
  gemini: 'gemini-3.5-flash-lite',
  anthropic: DEFAULT_ANTHROPIC_MODEL,
  openai: 'gpt-5.4-mini',
  ollama: 'qwen3:8b',
} as const;

type Env = Record<string, string | undefined>;

function ollamaBaseUrl(env: Env): string {
  return (env['OLLAMA_BASE_URL'] ?? env['OLLAMA_HOST'] ?? 'http://localhost:11434').replace(/\/+$/, '');
}

/** True when an Ollama server answers on its tags endpoint. */
export async function ollamaReachable(env: Env = process.env): Promise<boolean> {
  try {
    const res = await fetch(`${ollamaBaseUrl(env)}/api/tags`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function need(env: Env, key: string, provider: string): string {
  const v = env[key];
  if (!v) throw new ConfigurationError(`Provider "${provider}" needs ${key} to be set (env or .env file).`);
  return v;
}

/**
 * Build the LLM provider from config and environment.
 * "auto" picks the first available of: Gemini, Anthropic, OpenAI, local Ollama.
 */
export async function resolveProvider(config: Config, env: Env = process.env): Promise<LLMProvider> {
  const p = config.provider;
  let name = p.name;
  const envModel = env['SPECSYNC_MODEL'];

  if (name === 'auto') {
    if (env['GEMINI_API_KEY']) name = 'gemini';
    else if (env['ANTHROPIC_API_KEY']) name = 'anthropic';
    else if (env['OPENAI_API_KEY']) name = 'openai';
    else if (await ollamaReachable(env)) name = 'ollama';
    else throw new ConfigurationError();
  }

  const timeoutMs = p.timeoutMs;
  switch (name) {
    case 'gemini':
      return new OpenAICompatibleProvider({
        name: 'Gemini',
        model: p.model ?? envModel ?? env['GEMINI_MODEL'] ?? DEFAULT_MODELS.gemini,
        apiKey: need(env, p.apiKeyEnv ?? 'GEMINI_API_KEY', 'gemini'),
        baseURL: p.baseUrl ?? GEMINI_OPENAI_BASE_URL,
        timeoutMs,
      });
    case 'anthropic':
      return new AnthropicProvider({
        model: p.model ?? envModel ?? env['ANTHROPIC_MODEL'] ?? DEFAULT_MODELS.anthropic,
        apiKey: need(env, p.apiKeyEnv ?? 'ANTHROPIC_API_KEY', 'anthropic'),
        baseURL: p.baseUrl,
        timeoutMs,
      });
    case 'openai':
      return new OpenAICompatibleProvider({
        name: 'OpenAI',
        model: p.model ?? envModel ?? env['OPENAI_MODEL'] ?? DEFAULT_MODELS.openai,
        apiKey: need(env, p.apiKeyEnv ?? 'OPENAI_API_KEY', 'openai'),
        baseURL: p.baseUrl ?? env['OPENAI_BASE_URL'],
        timeoutMs,
      });
    case 'ollama':
      return new OpenAICompatibleProvider({
        name: 'Ollama',
        model: p.model ?? envModel ?? env['OLLAMA_MODEL'] ?? DEFAULT_MODELS.ollama,
        apiKey: 'ollama',
        baseURL: p.baseUrl ?? `${ollamaBaseUrl(env)}/v1`,
        timeoutMs,
      });
    case 'openai-compatible': {
      const baseURL = p.baseUrl ?? env['SPECSYNC_BASE_URL'];
      const model = p.model ?? envModel;
      if (!baseURL || !model) {
        throw new ConfigurationError(
          'Provider "openai-compatible" needs provider.baseUrl and provider.model (or SPECSYNC_BASE_URL and SPECSYNC_MODEL).',
        );
      }
      return new OpenAICompatibleProvider({
        name: 'OpenAI-compatible',
        model,
        apiKey: env[p.apiKeyEnv ?? 'SPECSYNC_API_KEY'] ?? 'none',
        baseURL,
        timeoutMs,
      });
    }
  }
}
