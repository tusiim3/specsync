import { describe, expect, it } from 'vitest';
import { writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { ConfigError, deepMerge, loadConfig, parseConfig, specList } from '../src/config.js';
import { loadDotenv } from '../src/env.js';
import { buildProgram } from '../src/cli.js';
import { withTempDir } from './helpers.js';

describe('config', () => {
  it('applies defaults', () => {
    const c = parseConfig({});
    expect(c.repo).toBe('.');
    expect(c.provider).toMatchObject({ name: 'auto', concurrency: 4, maxRetries: 6 });
    expect(c.retrieval.topK).toBe(8);
    expect(c.thresholds.failOn).toEqual(['error']);
    expect(specList(parseConfig({ spec: 'a.md' }))).toEqual(['a.md']);
  });

  it('reports invalid fields with their path', () => {
    expect(() => parseConfig({ provider: { name: 'nope' } })).toThrow(ConfigError);
    expect(() => parseConfig({ retrieval: { topK: 0 } })).toThrow(/retrieval\.topK/);
  });

  it('loads a config file and merges CLI overrides on top', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'specsync.config.json'), JSON.stringify({ spec: 'docs/spec.md', provider: { name: 'gemini', concurrency: 2 } }));
      const { config, baseDir, file } = await loadConfig({ cwd: dir, overrides: { provider: { model: 'm' } } });
      expect(file).toBe(join(dir, 'specsync.config.json'));
      expect(baseDir).toBe(dir);
      expect(config.provider).toMatchObject({ name: 'gemini', concurrency: 2, model: 'm' });
      await writeFile(join(dir, 'bad.json'), '{oops');
      await expect(loadConfig({ cwd: dir, configPath: 'bad.json' })).rejects.toThrow(/Could not parse/);
      await expect(loadConfig({ cwd: dir, configPath: 'missing.json' })).rejects.toThrow(/not found/);
    });
  });

  it('deepMerge ignores undefined and replaces arrays', () => {
    expect(deepMerge({ a: { b: 1, c: [1] } }, { a: { c: [2], d: undefined } })).toEqual({ a: { b: 1, c: [2] } });
  });
});

describe('loadDotenv', () => {
  it('reads quoted values, export prefixes and comments without overriding', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, '.env'), '# c\nexport A="x y"\nB=plain # trailing\nC=\'q\'\nKEEP=new\nnot a line\n');
      const env: NodeJS.ProcessEnv = { KEEP: 'old' };
      loadDotenv(dir, env);
      expect(env).toEqual({ A: 'x y', B: 'plain', C: 'q', KEEP: 'old' });
    });
  });
});

describe('cli init', () => {
  it('writes a config and adds .specsync/ to .gitignore', async () => {
    await withTempDir(async (dir) => {
      const cwd = process.cwd();
      process.chdir(dir);
      try {
        await writeFile('PRD.md', '## A\n\nb\n');
        await writeFile('.gitignore', 'node_modules');
        const { mkdir } = await import('fs/promises');
        await mkdir('src');
        const out: string[] = [];
        const write = process.stdout.write.bind(process.stdout);
        process.stdout.write = ((s: string) => (out.push(s), true)) as typeof process.stdout.write;
        try {
          await buildProgram().parseAsync(['node', 'specsync', 'init']);
        } finally {
          process.stdout.write = write;
        }
        const cfg = JSON.parse(await readFile('specsync.config.json', 'utf-8'));
        expect(cfg).toMatchObject({ spec: 'PRD.md', repo: 'src' });
        expect(await readFile('.gitignore', 'utf-8')).toBe('node_modules\n.specsync/\n');
        expect(out.join('')).toContain('Wrote specsync.config.json');
      } finally {
        process.chdir(cwd);
        process.exitCode = 0;
      }
    });
  });
});
