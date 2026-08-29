import OpenAI from 'openai';
import type { LLMProvider } from './provider.js';

export class OpenAIProvider implements LLMProvider {
  readonly name = 'OpenAI (gpt-4o-mini)';
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async complete(prompt: string): Promise<string> {
    const response = await this.client.chat.completions.create(
      {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
      },
      { timeout: 30_000 },
    );
    return response.choices[0]?.message?.content ?? '{}';
  }
}
