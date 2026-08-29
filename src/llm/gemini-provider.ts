import { GoogleGenerativeAI } from '@google/generative-ai';
import type { LLMProvider } from './provider.js';

export class GeminiProvider implements LLMProvider {
  readonly name = 'Gemini (gemini-3.5-flash-lite)';
  private model;

  constructor(apiKey: string) {
    const genAI = new GoogleGenerativeAI(apiKey);
    this.model = genAI.getGenerativeModel({
      model: 'gemini-3.5-flash-lite',
      generationConfig: { responseMimeType: 'application/json' },
    });
  }

  async complete(prompt: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const result = await this.model.generateContent(prompt);
      return result.response.text();
    } finally {
      clearTimeout(timeout);
    }
  }
}
