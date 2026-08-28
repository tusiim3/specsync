import { readFile } from 'fs/promises';
import { glob } from 'glob';
import { relative } from 'path';
import type { CodeChunk } from '../types.js';

const INCLUDE_EXTS = ['.js', '.mjs', '.cjs', '.ts', '.mts'];
const EXCLUDE_PATTERNS = [
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '*.test.*',
  '*.spec.*',
  '*.min.js',
];

const DECLARATION_RE =
  /^(?:export\s+)?(?:async\s+)?(?:function\s+\w|class\s+\w|const\s+\w+\s*=\s*(?:async\s+)?\(|const\s+\w+\s*=\s*function)/;

const FALLBACK_WINDOW = 50;

function isExcluded(filePath: string): boolean {
  return EXCLUDE_PATTERNS.some((p) => {
    if (p.startsWith('*')) {
      const ext = p.replace('*', '');
      return filePath.includes(ext);
    }
    return filePath.includes(p);
  });
}

/** Split a single file's lines into declaration-bounded chunks */
function chunkFile(lines: string[], filePath: string): CodeChunk[] {
  const chunks: CodeChunk[] = [];
  const boundaries: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (DECLARATION_RE.test(line.trimStart())) {
      boundaries.push(i);
    }
  }

  // If no declaration boundaries found, fall back to fixed windows
  if (boundaries.length === 0) {
    for (let start = 0; start < lines.length; start += FALLBACK_WINDOW) {
      const content = lines.slice(start, start + FALLBACK_WINDOW).join('\n').trim();
      if (content) {
        chunks.push({
          id: `${filePath}:${start + 1}`,
          filePath,
          startLine: start + 1,
          content,
        });
      }
    }
    return chunks;
  }

  for (let b = 0; b < boundaries.length; b++) {
    const start = boundaries[b]!;
    const end = boundaries[b + 1] ?? lines.length;
    const content = lines.slice(start, end).join('\n').trim();
    if (content) {
      chunks.push({
        id: `${filePath}:${start + 1}`,
        filePath,
        startLine: start + 1,
        content,
      });
    }
  }

  return chunks;
}

/**
 * Walk a directory recursively and return all code chunks.
 * @param dir  Absolute or relative path to the target codebase root
 */
export async function chunkCodebase(dir: string): Promise<CodeChunk[]> {
  const pattern = `${dir}/**/*{${INCLUDE_EXTS.join(',')}}`;
  const files = await glob(pattern, { absolute: true });

  const allChunks: CodeChunk[] = [];

  for (const absPath of files) {
    if (isExcluded(absPath)) continue;
    try {
      const source = await readFile(absPath, 'utf-8');
      const lines = source.split('\n');
      const relPath = relative(process.cwd(), absPath);
      const chunks = chunkFile(lines, relPath);
      allChunks.push(...chunks);
    } catch {
      // Skip files that can't be read (binary, permission errors)
    }
  }

  return allChunks;
}
