/** Minimal LLM provider interface used by SpecSync */
export interface LLMProvider {
  /** Send a single prompt string, return the model's text response */
  complete(prompt: string): Promise<string>;
  /** Human-readable name for logging */
  readonly name: string;
}

export class ConfigurationError extends Error {
  constructor() {
    super(
      [
        '',
        '┌─────────────────────────────────────────────────────────┐',
        '│  SpecSync: No LLM provider configured                   │',
        '├─────────────────────────────────────────────────────────┤',
        '│  Set ONE of the following environment variables:        │',
        '│                                                         │',
        '│  GEMINI_API_KEY=...   (https://aistudio.google.com)     │',
        '│  OPENAI_API_KEY=...   (https://platform.openai.com)     │',
        '│                                                         │',
        '│  Or run Ollama locally:  https://ollama.ai              │',
        '│    ollama serve          (starts the daemon)            │',
        '│    ollama pull llama3    (downloads the model)          │',
        '│                                                         │',
        '│  Then copy .env.example → .env and fill in your key.   │',
        '└─────────────────────────────────────────────────────────┘',
        '',
      ].join('\n'),
    );
    this.name = 'ConfigurationError';
  }
}
