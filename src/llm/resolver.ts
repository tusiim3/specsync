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
    // Quick validation: attempt a minimal call to catch invalid keys early
    try {
      await provider.complete('{"test":true}');
      return provider;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('API_KEY_INVALID') || msg.includes('API key not valid')) {
        process.stderr.write(
          '  Warning: GEMINI_API_KEY is invalid, falling back to next provider.\n',
        );
      } else {
        // Other errors (network etc.) — still fall through
        process.stderr.write(`  Warning: Gemini probe failed (${msg.slice(0, 80)}), falling back.\n`);
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
