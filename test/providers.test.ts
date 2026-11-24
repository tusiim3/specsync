import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { OpenAICompatibleProvider } from '../src/llm/openai-compatible.js';
import { AnthropicProvider } from '../src/llm/anthropic.js';
import { ProviderError, ConfigurationError } from '../src/llm/provider.js';
import { resolveProvider, GEMINI_OPENAI_BASE_URL } from '../src/llm/resolver.js';
import { VERDICT_SCHEMA } from '../src/agents/verdict.js';
import { testConfig } from './helpers.js';

type Handler = (req: IncomingMessage, body: unknown, res: ServerResponse) => void;

let server: Server | undefined;
async function serve(handler: Handler): Promise<string> {
  server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => handler(req, data ? JSON.parse(data) : undefined, res));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

const request = { system: 'sys', prompt: 'REQUIREMENT X', schema: VERDICT_SCHEMA, maxOutputTokens: 100 };

describe('OpenAICompatibleProvider', () => {
  it('sends a strict json_schema request and returns text and usage', async () => {
    let seen: Record<string, unknown> | undefined;
    const url = await serve((req, body, res) => {
      seen = { path: req.url, auth: req.headers['authorization'], ...(body as object) };
      json(res, 200, {
        id: 'x',
        object: 'chat.completion',
        created: 0,
        model: 'm',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"ok":true}' } }],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      });
    });
    const p = new OpenAICompatibleProvider({ name: 'Test', model: 'm', apiKey: 'k', baseURL: url, timeoutMs: 5000 });
    const out = await p.complete(request);
    expect(out).toEqual({ text: '{"ok":true}', inputTokens: 12, outputTokens: 3 });
    expect(seen).toMatchObject({
      path: '/chat/completions',
      auth: 'Bearer k',
      model: 'm',
      max_completion_tokens: 100,
      response_format: { type: 'json_schema', json_schema: { name: 'requirement_verdict', strict: true } },
    });
    expect((seen!['messages'] as Array<{ role: string }>).map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('maps 429 to a retryable error with Retry-After, and 401 to a fatal one', async () => {
    let status = 429;
    const url = await serve((_req, _body, res) => json(res, status, { error: { message: 'nope' } }, { 'retry-after': '2' }));
    const p = new OpenAICompatibleProvider({ name: 'Test', model: 'm', apiKey: 'k', baseURL: url, timeoutMs: 5000 });
    const e1 = await p.complete(request).catch((e) => e);
    expect(e1).toBeInstanceOf(ProviderError);
    expect(e1).toMatchObject({ status: 429, retryable: true, fatal: false, retryAfterMs: 2000 });
    status = 401;
    const e2 = await p.complete(request).catch((e) => e);
    expect(e2).toMatchObject({ status: 401, retryable: false, fatal: true });
  });

  it('times out with a retryable error', async () => {
    const url = await serve(() => {
      /* never respond */
    });
    const p = new OpenAICompatibleProvider({ name: 'Test', model: 'm', apiKey: 'k', baseURL: url, timeoutMs: 200 });
    const e = await p.complete(request).catch((err) => err);
    expect(e).toMatchObject({ retryable: true });
    expect(String(e.message)).toMatch(/timed out/);
  });

  it('treats an empty reply as retryable', async () => {
    const url = await serve((_r, _b, res) =>
      json(res, 200, { id: 'x', object: 'chat.completion', created: 0, model: 'm', choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '' } }] }),
    );
    const p = new OpenAICompatibleProvider({ name: 'Test', model: 'm', apiKey: 'k', baseURL: url, timeoutMs: 5000 });
    await expect(p.complete(request)).rejects.toMatchObject({ retryable: true });
  });
});

describe('AnthropicProvider', () => {
  it('sends output_config json_schema and server-side fallbacks on supported models', async () => {
    let seen: { url?: string; beta?: string; body?: Record<string, unknown> } = {};
    const url = await serve((req, body, res) => {
      seen = { url: req.url, beta: req.headers['anthropic-beta'] as string, body: body as Record<string, unknown> };
      json(res, 200, {
        id: 'msg',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: '{"verdict":"missing"}' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 20, output_tokens: 5 },
      });
    });
    const p = new AnthropicProvider({ model: 'claude-opus-5-5', apiKey: 'k', baseURL: url, timeoutMs: 5000 });
    const out = await p.complete(request);
    expect(out).toEqual({ text: '{"verdict":"missing"}', inputTokens: 20, outputTokens: 5 });
    expect(seen.url).toMatch(/^\/v1\/messages/);
    expect(seen.beta).toContain('server-side-fallback-2026-07-01');
    expect(seen.body).toMatchObject({
      model: 'claude-opus-5-5',
      system: 'sys',
      fallbacks: 'default',
      output_config: { format: { type: 'json_schema' } },
    });
    expect(seen.body!['thinking']).toBeUndefined();
  });

  it('omits fallbacks on other models and turns a refusal into a non-retryable error', async () => {
    let body: Record<string, unknown> = {};
    const url = await serve((_req, b, res) => {
      body = b as Record<string, unknown>;
      json(res, 200, {
        id: 'msg',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-5-5',
        content: [],
        stop_reason: 'refusal',
        usage: { input_tokens: 1, output_tokens: 0 },
      });
    });
    const p = new AnthropicProvider({ model: 'claude-haiku-5-5', apiKey: 'k', baseURL: url, timeoutMs: 5000 });
    await expect(p.complete(request)).rejects.toMatchObject({ retryable: false, fatal: false });
    expect(body['fallbacks']).toBeUndefined();
  });

  it('maps 529 overloaded to retryable', async () => {
    const url = await serve((_r, _b, res) => json(res, 529, { type: 'error', error: { type: 'overloaded_error', message: 'busy' } }));
    const p = new AnthropicProvider({ model: 'claude-haiku-5-5', apiKey: 'k', baseURL: url, timeoutMs: 5000 });
    await expect(p.complete(request)).rejects.toMatchObject({ status: 529, retryable: true });
  });
});

describe('resolveProvider', () => {
  const noOllama = { OLLAMA_BASE_URL: 'http://127.0.0.1:9' };

  it('auto-selects Gemini, then Anthropic, then OpenAI', async () => {
    const cfg = testConfig();
    expect((await resolveProvider(cfg, { ...noOllama, GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o' })).name).toBe('Gemini');
    expect((await resolveProvider(cfg, { ...noOllama, ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' })).name).toBe('Anthropic');
    const openai = await resolveProvider(cfg, { ...noOllama, OPENAI_API_KEY: 'o' });
    expect([openai.name, openai.model]).toEqual(['OpenAI', 'gpt-5-mini']);
  });

  it('throws a helpful error when nothing is configured', async () => {
    await expect(resolveProvider(testConfig(), noOllama)).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('respects explicit provider, model and env overrides', async () => {
    const p = await resolveProvider(testConfig({ provider: { name: 'gemini', model: 'gemini-x' } }), { GEMINI_API_KEY: 'g' });
    expect([p.name, p.model]).toEqual(['Gemini', 'gemini-x']);
    const a = await resolveProvider(testConfig({ provider: { name: 'anthropic' } }), { ANTHROPIC_API_KEY: 'a', ANTHROPIC_MODEL: 'claude-sonnet-5-5' });
    expect(a.model).toBe('claude-sonnet-5-5');
    await expect(resolveProvider(testConfig({ provider: { name: 'openai' } }), {})).rejects.toThrow(/OPENAI_API_KEY/);
    await expect(resolveProvider(testConfig({ provider: { name: 'openai-compatible' } }), {})).rejects.toThrow(/baseUrl/);
    expect(GEMINI_OPENAI_BASE_URL).toMatch(/generativelanguage\.googleapis\.com/);
  });
});
