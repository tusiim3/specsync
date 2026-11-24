import { describe, expect, it } from 'vitest';
import { chunkSource, windowChunks } from '../src/ingest/code-chunker.js';

const summary = (chunks: Awaited<ReturnType<typeof chunkSource>>) =>
  chunks.map((c) => `${c.kind}:${c.symbol ?? ''}:${c.exported ? 'pub' : 'priv'}`);

describe('chunkSource', () => {
  it('chunks JS functions, CommonJS member assignments and chained assignments', async () => {
    const src = [
      "'use strict';",
      "var http = require('http');",
      '',
      '/**',
      ' * Send a response.',
      ' */',
      '',
      'res.send = function send(body) {',
      '  return body;',
      '};',
      '',
      'res.set = res.header = function header(field, val) {',
      '  return this;',
      '};',
      '',
      'function helper() { return 1; }',
      '',
      'const arrow = async (x) => x * 2;',
      'module.exports = { helper };',
    ].join('\n');
    const chunks = await chunkSource('lib/res.js', src);
    expect(summary(chunks)).toEqual([
      'function:res.send:pub',
      'function:res.set:pub',
      'function:helper:pub',
      'function:arrow:priv',
    ]);
    // Doc comment separated by a blank line is pulled into the function chunk.
    expect(chunks[0]!.startLine).toBe(4);
    expect(chunks[0]!.content).toContain('Send a response.');
    expect(chunks[0]!.id).toBe('lib/res.js:4-10');
  });

  it('marks TypeScript exports and class members', async () => {
    const src = [
      'export interface User { id: string }',
      'export class UserService {',
      '  create(name: string) { return name; }',
      '  private secret() { return 1; }',
      '}',
      'class Internal { run() {} }',
      'export default function main() {}',
    ].join('\n');
    expect(summary(await chunkSource('src/users.ts', src))).toEqual([
      'type:User:pub',
      'class:UserService:pub',
      'class:Internal:priv',
      'function:main:pub',
    ]);
  });

  it('splits a large class into its methods', async () => {
    const methods = Array.from({ length: 12 }, (_, i) =>
      [`  method${i}(a: number) {`, ...Array.from({ length: 12 }, () => '    a += 1;'), '    return a;', '  }'].join('\n'),
    );
    const src = `export class Big {\n  count = 0;\n${methods.join('\n')}\n}\n`;
    const chunks = await chunkSource('src/big.ts', src);
    const methodChunks = chunks.filter((c) => c.kind === 'method');
    expect(methodChunks).toHaveLength(12);
    expect(methodChunks[0]!.symbol).toBe('Big.method0');
    expect(methodChunks.every((c) => c.exported)).toBe(true);
  });

  it('keeps top-level code between declarations as module chunks', async () => {
    const src = [
      "import express from 'express';",
      'const app = express();',
      "app.get('/health', (req, res) => res.json({ ok: true }));",
      "app.post('/todos', createTodo);",
      'function createTodo(req, res) { res.status(201).end(); }',
      'app.listen(3000);',
    ].join('\n');
    const chunks = await chunkSource('src/app.ts', src);
    expect(chunks.map((c) => c.kind)).toEqual(['module', 'function']);
    expect(chunks[0]!.content).toContain("app.post('/todos'");
  });

  it('handles Python visibility and decorators', async () => {
    const src = [
      'import os',
      '',
      '@app.route("/x")',
      'def handler():',
      '    return 1',
      '',
      'def _private():',
      '    pass',
      '',
      'class Service:',
      '    def run(self):',
      '        pass',
    ].join('\n');
    expect(summary(await chunkSource('app.py', src))).toEqual([
      'function:handler:pub',
      'function:_private:priv',
      'class:Service:pub',
    ]);
  });

  it('handles Go, Java and Rust visibility', async () => {
    const go = 'package x\n\nfunc Exported() {}\n\nfunc internal() {}\n\ntype Thing struct{}\n';
    expect(summary(await chunkSource('x.go', go))).toEqual([
      'function:Exported:pub',
      'function:internal:priv',
      'type:Thing:pub',
    ]);
    const java = 'public class A {\n  public void run() {}\n  private void hide() {}\n}\n';
    expect(summary(await chunkSource('A.java', java))).toEqual(['class:A:pub']);
    const rust = 'pub fn open() {}\nfn close() {}\n';
    expect(summary(await chunkSource('lib.rs', rust))).toEqual(['function:open:pub', 'function:close:priv']);
  });

  it('falls back to overlapping line windows for languages without a parser', async () => {
    const src = Array.from({ length: 130 }, (_, i) => `val x${i} = ${i}`).join('\n');
    const chunks = await chunkSource('Main.kt', src);
    expect(chunks.map((c) => [c.startLine, c.endLine])).toEqual([
      [1, 60],
      [51, 110],
      [101, 130],
    ]);
    expect(chunks.every((c) => c.kind === 'window' && !c.exported)).toBe(true);
  });

  it('returns nothing for unknown extensions and empty windows', async () => {
    expect(await chunkSource('README', 'hello')).toEqual([]);
    expect(windowChunks('a.kt', ['', '  ', ''], 'kotlin')).toEqual([]);
  });

  it('gives chunks content hashes that change with content', async () => {
    const [a] = await chunkSource('a.ts', 'export function f() { return 1; }');
    const [b] = await chunkSource('a.ts', 'export function f() { return 2; }');
    expect(a!.hash).not.toEqual(b!.hash);
  });
});
