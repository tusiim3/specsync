import { GeminiProvider } from './gemini-provider.js';
import { OpenAIProvider } from './openai-provider.js';
import { OllamaProvider } from './ollama-provider.js';
import { ConfigurationError } from './provider.js';
import type { LLMProvider } from './provider.js';

/**
 * Auto-selects an LLM provider from environment variables.
 * Priority order:
 *   1. GEMINI_API_KEY  → GeminiProvider
 *   2. OPENAI_API_KEY  → OpenAIProvider
 *   3. Ollama reachable → OllamaProvider
 *   4. None            → throws ConfigurationError
 */
export async function resolveProvider(): Promise<LLMProvider> {
  const geminiKey = process.env['GEMINI_API_KEY'];
  if (geminiKey) {
    const provider = new GeminiProvider(geminiKey);
    // Only probe to catch definitively invalid keys.
    // On network errors or any non-auth failure, trust the key and proceed.
    try {
      await provider.complete('{"test":true}');
      return provider;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isAuthError =
        msg.includes('API_KEY_INVALID') ||
        msg.includes('API key not valid') ||
        msg.includes('PERMISSION_DENIED') ||
        msg.includes('401');
      if (isAuthError) {
        process.stderr.write(
          '  Warning: GEMINI_API_KEY is invalid, falling back to next provider.\n',
        );
      } else {
        // Network hiccup, timeout, etc. — key may still be valid, use it
        process.stderr.write(
          `  Note: Gemini probe inconclusive (${msg.slice(0, 80)}), proceeding with Gemini anyway.\n`,
        );
        return provider;
      }
    }
  }

  const openaiKey = process.env['OPENAI_API_KEY'];
  if (openaiKey) {
    return new OpenAIProvider(openaiKey);
  }

  if (await OllamaProvider.isReachable()) {
    return new OllamaProvider();
  }

  throw new ConfigurationError();
}
