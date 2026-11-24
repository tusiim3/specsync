import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { glob } from 'glob';
import ignore from 'ignore';
import { DEFAULT_EXCLUDE } from '../config.js';
import { SOURCE_EXTENSIONS } from './languages.js';

const TEST_PATTERNS = new Set([
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**',
  '**/test/**',
  '**/tests/**',
]);

export interface FileListOptions {
  include?: string[];
  exclude?: string[];
  excludeTests?: boolean;
}

/**
 * List source files under `repoDir`, as repo-relative POSIX paths, sorted.
 * Exclusions are matched relative to the repo root, so a repo that itself
 * lives under a folder named "build" or "dist" is still analyzed.
 * Root .gitignore and .specsyncignore files are honored.
 */
export async function listSourceFiles(repoDir: string, opts: FileListOptions = {}): Promise<string[]> {
  const include = opts.include?.length
    ? opts.include
    : [`**/*.{${SOURCE_EXTENSIONS.map((e) => e.slice(1)).join(',')}}`];
  const defaults = opts.excludeTests === false ? DEFAULT_EXCLUDE.filter((p) => !TEST_PATTERNS.has(p)) : DEFAULT_EXCLUDE;
  const exclude = [...defaults, ...(opts.exclude ?? [])];

  const files = await glob(include, {
    cwd: repoDir,
    ignore: exclude,
    nodir: true,
    dot: false,
    posix: true,
    follow: false,
  });

  const ig = ignore();
  for (const name of ['.gitignore', '.specsyncignore']) {
    const p = join(repoDir, name);
    if (existsSync(p)) ig.add(await readFile(p, 'utf-8'));
  }
  return [...new Set(files.map((f) => f.replace(/\\/g, '/').replace(/^\.\//, '')))]
    .filter((f) => !ig.ignores(f))
    .sort();
}
