import { readFile } from 'fs/promises';
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
 * .gitignore and .specsyncignore files are honored at every directory level.
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

  const matchers = await loadIgnoreFiles(repoDir, exclude);
  return [...new Set(files.map((f) => f.replace(/\\/g, '/').replace(/^\.\//, '')))]
    .filter((f) => !isIgnored(f, matchers))
    .sort();
}

interface IgnoreScope {
  /** Directory (repo-relative, '' for root) the patterns apply under. */
  dir: string;
  ig: ReturnType<typeof ignore>;
}

/** Collect .gitignore and .specsyncignore files at every level of the repo. */
async function loadIgnoreFiles(repoDir: string, exclude: string[]): Promise<IgnoreScope[]> {
  const found = await glob(['**/.gitignore', '**/.specsyncignore'], {
    cwd: repoDir,
    ignore: exclude,
    dot: true,
    nodir: true,
    posix: true,
  });
  const byDir = new Map<string, ReturnType<typeof ignore>>();
  for (const rel of found.sort()) {
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const ig = byDir.get(dir) ?? ignore();
    ig.add(await readFile(join(repoDir, rel), 'utf-8'));
    byDir.set(dir, ig);
  }
  return [...byDir.entries()].map(([dir, ig]) => ({ dir, ig }));
}

/** A file is ignored when any ignore file in one of its ancestor directories matches it. */
function isIgnored(file: string, scopes: IgnoreScope[]): boolean {
  for (const { dir, ig } of scopes) {
    if (dir === '') {
      if (ig.ignores(file)) return true;
    } else if (file.startsWith(`${dir}/`) && ig.ignores(file.slice(dir.length + 1))) {
      return true;
    }
  }
  return false;
}
