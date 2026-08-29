import type { LLMProvider } from './provider.js';

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'llama3';

export class OllamaProvider implements LLMProvider {
  readonly name: string;
  private baseUrl: string;
  private model: string;

  constructor(
    baseUrl = process.env['OLLAMA_BASE_URL'] ?? DEFAULT_BASE_URL,
    model = process.env['OLLAMA_MODEL'] ?? DEFAULT_MODEL,
  ) {
    this.baseUrl = baseUrl;
    this.model = model;
    this.name = `Ollama (${model})`;
  }

  async complete(prompt: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt, stream: false }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { response: string };
    return data.response;
  }

  /** Quick reachability check — used by resolver */
  static async isReachable(
    baseUrl = process.env['OLLAMA_BASE_URL'] ?? DEFAULT_BASE_URL,
  ): Promise<boolean> {
    try {
      const res = await fetch(`${baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(1_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
