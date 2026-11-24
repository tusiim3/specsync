import { readFile, stat } from 'fs/promises';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { join } from 'path';
import type { Language, Node, Parser } from '@vscode/tree-sitter-wasm';
import type { ChunkKind, CodeChunk } from '../types.js';
import { languageFor } from './languages.js';

const require = createRequire(import.meta.url);

/** Declarations longer than this are split into their members, or into windows. */
const MAX_CHUNK_LINES = 150;
const WINDOW_LINES = 60;
const WINDOW_OVERLAP = 10;
const MAX_FILE_BYTES = 1_000_000;

type TreeSitter = typeof import('@vscode/tree-sitter-wasm');

let tsModule: Promise<{ ts: TreeSitter; dir: string }> | null = null;
const languageCache = new Map<string, Promise<Language>>();

function loadTreeSitter() {
  if (!tsModule) {
    tsModule = (async () => {
      const ts = require('@vscode/tree-sitter-wasm') as TreeSitter;
      const dir = require.resolve('@vscode/tree-sitter-wasm').replace(/tree-sitter\.js$/, '');
      await ts.Parser.init({ locateFile: (file: string) => dir + file });
      return { ts, dir };
    })();
  }
  return tsModule;
}

async function parserFor(grammar: string): Promise<Parser> {
  const { ts, dir } = await loadTreeSitter();
  let lang = languageCache.get(grammar);
  if (!lang) {
    lang = ts.Language.load(dir + grammar);
    languageCache.set(grammar, lang);
  }
  const parser = new ts.Parser();
  parser.setLanguage(await lang);
  return parser;
}

/** Node types that are declarations worth chunking, per language family. */
const DECLARATIONS: Record<string, Record<string, ChunkKind>> = {
  javascript: {
    function_declaration: 'function',
    generator_function_declaration: 'function',
    class_declaration: 'class',
    method_definition: 'method',
  },
  typescript: {
    function_declaration: 'function',
    generator_function_declaration: 'function',
    class_declaration: 'class',
    abstract_class_declaration: 'class',
    method_definition: 'method',
    interface_declaration: 'type',
    type_alias_declaration: 'type',
    enum_declaration: 'type',
    module: 'class',
  },
  python: { function_definition: 'function', class_definition: 'class', decorated_definition: 'function' },
  go: { function_declaration: 'function', method_declaration: 'method', type_declaration: 'type' },
  java: {
    class_declaration: 'class',
    interface_declaration: 'type',
    enum_declaration: 'type',
    record_declaration: 'class',
    method_declaration: 'method',
    constructor_declaration: 'method',
  },
  ruby: { method: 'method', singleton_method: 'method', class: 'class', module: 'class' },
  rust: {
    function_item: 'function',
    impl_item: 'class',
    struct_item: 'type',
    enum_item: 'type',
    trait_item: 'type',
    mod_item: 'class',
  },
  csharp: {
    class_declaration: 'class',
    struct_declaration: 'class',
    interface_declaration: 'type',
    record_declaration: 'class',
    enum_declaration: 'type',
    method_declaration: 'method',
    constructor_declaration: 'method',
    namespace_declaration: 'class',
    file_scoped_namespace_declaration: 'class',
  },
  php: {
    function_definition: 'function',
    class_declaration: 'class',
    interface_declaration: 'type',
    trait_declaration: 'class',
    method_declaration: 'method',
  },
  cpp: {
    function_definition: 'function',
    class_specifier: 'class',
    struct_specifier: 'class',
    namespace_definition: 'class',
  },
};
DECLARATIONS['tsx'] = DECLARATIONS['typescript']!;

const lineCount = (n: Node) => n.endPosition.row - n.startPosition.row + 1;

function firstNamed(node: Node, ...fields: string[]): Node | null {
  for (const f of fields) {
    const c = node.childForFieldName(f);
    if (c) return c;
  }
  return null;
}

/** JS/TS: `const f = () => {}`, `res.send = function () {}`, `exports.x = ...`. */
function jsFunctionBinding(node: Node): { name: string; kind: ChunkKind; memberAssign: boolean } | null {
  const isFn = (n: Node | null) =>
    !!n && ['arrow_function', 'function_expression', 'function', 'generator_function', 'class'].includes(n.type);
  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    const decls = node.namedChildren.filter((c): c is Node => !!c && c.type === 'variable_declarator');
    if (decls.length === 1 && isFn(decls[0]!.childForFieldName('value'))) {
      const value = decls[0]!.childForFieldName('value')!;
      return {
        name: decls[0]!.childForFieldName('name')?.text ?? '',
        kind: value.type === 'class' ? 'class' : 'function',
        memberAssign: false,
      };
    }
  }
  if (node.type === 'expression_statement') {
    const expr = node.namedChildren[0];
    if (expr?.type === 'assignment_expression') {
      // Follow chains like `res.set = res.header = function header() {}`.
      let right = expr.childForFieldName('right');
      while (right?.type === 'assignment_expression') right = right.childForFieldName('right');
      if (isFn(right)) {
        const left = expr.childForFieldName('left');
        return {
          name: left?.text ?? '',
          kind: right!.type === 'class' ? 'class' : 'function',
          memberAssign: left?.type === 'member_expression',
        };
      }
    }
  }
  return null;
}

function hasModifier(node: Node, word: string): boolean {
  for (const c of node.children) {
    if (!c) continue;
    if (c.type === 'modifiers' || c.type === 'modifier' || c.type === 'visibility_modifier' || c.type === 'accessibility_modifier') {
      if (new RegExp(`\\b${word}\\b`).test(c.text)) return true;
    }
  }
  return false;
}

interface Decl {
  node: Node;
  kind: ChunkKind;
  name: string;
  exported: boolean;
}

/** Recognize a declaration node, returning its kind, name and visibility. */
function asDeclaration(lang: string, node: Node, parentPublic: boolean): Decl | null {
  const table = DECLARATIONS[lang] ?? {};
  const target = node;
  let exported = false;

  if ((lang === 'javascript' || lang === 'typescript' || lang === 'tsx') && node.type === 'export_statement') {
    const inner = node.childForFieldName('declaration') ?? node.namedChildren.find((c) => !!c && c.type !== 'comment') ?? null;
    if (!inner) return null;
    const d = asDeclaration(lang, inner, parentPublic);
    if (d) return { ...d, node, exported: true };
    return null;
  }

  if (lang === 'javascript' || lang === 'typescript' || lang === 'tsx') {
    const binding = jsFunctionBinding(node);
    if (binding) {
      return { node, kind: binding.kind, name: binding.name, exported: binding.memberAssign };
    }
  }

  const kind = table[target.type];
  if (!kind) return null;

  if (lang === 'python' && target.type === 'decorated_definition') {
    const def = target.childForFieldName('definition');
    if (!def) return null;
    const d = asDeclaration(lang, def, parentPublic);
    return d ? { ...d, node } : null;
  }

  let name =
    firstNamed(target, 'name', 'declarator', 'type')?.text.split('(')[0]?.trim() ??
    target.namedChildren.find((c) => !!c && /identifier|name|constant/.test(c.type))?.text ??
    '';
  if (lang === 'go' && target.type === 'type_declaration') {
    name = target.namedChildren[0]?.childForFieldName('name')?.text ?? name;
  }
  name = name.slice(0, 80);

  switch (lang) {
    case 'python':
      exported = parentPublic && !name.startsWith('_');
      break;
    case 'go':
      exported = /^[A-Z]/.test(name);
      break;
    case 'java':
    case 'csharp':
      exported = parentPublic && hasModifier(target, 'public');
      break;
    case 'rust':
      exported = target.children.some((c) => c?.type === 'visibility_modifier');
      break;
    case 'php':
      exported = parentPublic && !hasModifier(target, 'private') && !hasModifier(target, 'protected');
      break;
    case 'ruby':
      exported = parentPublic && !name.startsWith('_');
      break;
    case 'javascript':
    case 'typescript':
    case 'tsx':
      // Methods of an exported class are public unless private/#/_ prefixed.
      exported =
        target.type === 'method_definition'
          ? parentPublic && !name.startsWith('#') && !name.startsWith('_') && !hasModifier(target, 'private')
          : false;
      break;
    default:
      exported = parentPublic;
  }
  return { node: target, kind, name, exported };
}

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function makeChunk(
  filePath: string,
  lines: string[],
  start: number,
  end: number,
  language: string,
  kind: ChunkKind,
  symbol: string | undefined,
  exported: boolean,
): CodeChunk | null {
  const content = lines.slice(start - 1, end).join('\n').trimEnd();
  if (!content.trim()) return null;
  return {
    id: `${filePath}:${start}-${end}`,
    filePath,
    startLine: start,
    endLine: end,
    language,
    kind,
    symbol: symbol || undefined,
    exported,
    content,
    hash: hashOf(content),
  };
}

/** Fixed-size overlapping line windows over [start, end]. */
export function windowChunks(
  filePath: string,
  lines: string[],
  language: string,
  start = 1,
  end = lines.length,
  kind: ChunkKind = 'window',
  symbol?: string,
  exported = false,
): CodeChunk[] {
  const out: CodeChunk[] = [];
  for (let s = start; s <= end; s += WINDOW_LINES - WINDOW_OVERLAP) {
    const e = Math.min(end, s + WINDOW_LINES - 1);
    const c = makeChunk(filePath, lines, s, e, language, kind, symbol, exported);
    if (c) out.push(c);
    if (e >= end) break;
  }
  return out;
}

/** Lines that carry no behavior on their own (imports, blank lines, comments, braces). */
function isTrivial(line: string): boolean {
  const t = line.trim();
  return (
    t === '' ||
    /^(\/\/|#(?!\[)|\*|\/\*|\*\/|--)/.test(t) ||
    /^(import|from|using|package|require|use|include|#include)\b/.test(t) ||
    /^(const|let|var)\s+\w+\s*=\s*require\(/.test(t) ||
    /^['"]use strict['"];?$/.test(t) ||
    /^[{}()[\];,]+$/.test(t)
  );
}

function collect(
  lang: string,
  node: Node,
  parentName: string | undefined,
  parentPublic: boolean,
  filePath: string,
  lines: string[],
  out: CodeChunk[],
): void {
  // Track which lines are covered by declarations so the rest can become "module" chunks.
  const covered: Array<[number, number]> = [];

  for (const child of node.namedChildren) {
    if (!child) continue;
    const decl = asDeclaration(lang, child, parentPublic);
    if (!decl) continue;
    // Pull directly preceding doc comments into the chunk: they describe its behavior.
    let startRow = child.startPosition.row;
    for (let prev = child.previousNamedSibling; prev && prev.type === 'comment'; prev = prev.previousNamedSibling) {
      if (prev.endPosition.row < startRow - 2) break; // allow one blank line
      startRow = prev.startPosition.row;
    }
    const start = startRow + 1;
    const end = child.endPosition.row + 1;
    covered.push([start, end]);
    const symbol = parentName && decl.name ? `${parentName}.${decl.name}` : decl.name || parentName;

    if (lineCount(child) <= MAX_CHUNK_LINES) {
      const c = makeChunk(filePath, lines, start, end, lang, decl.kind, symbol, decl.exported);
      if (c) out.push(c);
      continue;
    }

    // Too big: descend into the body to chunk members, keeping the remainder as windows.
    const body = findBody(decl.node);
    if (body && body.namedChildren.some((c) => c && asDeclaration(lang, c, decl.exported))) {
      collect(lang, body, symbol, decl.exported || decl.kind !== 'class', filePath, lines, out);
    } else {
      out.push(...windowChunks(filePath, lines, lang, start, end, decl.kind, symbol, decl.exported));
    }
  }

  // Code between declarations (route registrations, config, top-level logic, class fields).
  {
    const isCovered = (ln: number) => covered.some(([s, e]) => ln >= s && ln <= e);
    let runStart = -1;
    const flush = (endLine: number) => {
      if (runStart < 0) return;
      const slice = lines.slice(runStart - 1, endLine);
      if (slice.filter((l) => !isTrivial(l)).length >= 2) {
        out.push(
          ...windowChunks(filePath, lines, lang, runStart, endLine, parentName ? 'class' : 'module', parentName),
        );
      }
      runStart = -1;
    };
    const first = node.startPosition.row + 1;
    const last = node.endPosition.row + 1;
    for (let ln = first; ln <= Math.min(last, lines.length); ln++) {
      if (isCovered(ln)) flush(ln - 1);
      else if (runStart < 0) runStart = ln;
    }
    flush(Math.min(last, lines.length));
  }
}

function findBody(node: Node): Node | null {
  const direct = firstNamed(node, 'body', 'declaration_list', 'members');
  if (direct) return direct;
  // export_statement / decorated_definition wrap the real declaration.
  for (const c of node.namedChildren) {
    if (!c) continue;
    const b = firstNamed(c, 'body', 'declaration_list');
    if (b) return b;
  }
  return node.namedChildren.find((c) => !!c && /body|block|declaration_list|class_body/.test(c.type)) ?? null;
}

/** JS/TS: names exported via `module.exports = {a, b}` or `module.exports = name`. */
function commonJsExports(source: string): Set<string> {
  const names = new Set<string>();
  const obj = /module\.exports\s*=\s*\{([^}]*)\}/g;
  for (const m of source.matchAll(obj)) {
    for (const part of m[1]!.split(',')) {
      const name = part.split(':').pop()!.trim();
      if (/^\w+$/.test(name)) names.add(name);
    }
  }
  const single = /module\.exports\s*=\s*(\w+)\s*;?\s*$/gm;
  for (const m of source.matchAll(single)) names.add(m[1]!);
  return names;
}

/** Chunk one file's source text. Exposed for tests. */
export async function chunkSource(filePath: string, source: string): Promise<CodeChunk[]> {
  const lang = languageFor(filePath);
  const lines = source.split(/\r?\n/);
  if (!lang) return [];
  if (!lang.grammar) return windowChunks(filePath, lines, lang.id);

  const parser = await parserFor(lang.grammar);
  try {
    const tree = parser.parse(source);
    if (!tree) return windowChunks(filePath, lines, lang.id);
    const out: CodeChunk[] = [];
    try {
      collect(lang.id, tree.rootNode, undefined, true, filePath, lines, out);
    } finally {
      tree.delete();
    }
    if (lang.id === 'javascript' || lang.id === 'typescript' || lang.id === 'tsx') {
      const cjs = commonJsExports(source);
      for (const c of out) {
        if (c.symbol && cjs.has(c.symbol.split('.')[0]!)) c.exported = true;
      }
    }
    return out.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  } finally {
    parser.delete();
  }
}

function looksMinified(source: string): boolean {
  const lines = source.split('\n');
  return lines.length > 0 && source.length / lines.length > 300;
}

/**
 * Chunk files (repo-relative paths) under `repoDir` into declaration-level chunks.
 * Unparseable, huge or minified files are skipped.
 */
export async function chunkFiles(repoDir: string, files: string[]): Promise<CodeChunk[]> {
  const all: CodeChunk[] = [];
  for (const rel of files) {
    const abs = join(repoDir, rel);
    try {
      const st = await stat(abs);
      if (st.size > MAX_FILE_BYTES) continue;
      const source = await readFile(abs, 'utf-8');
      if (source.includes('\u0000') || looksMinified(source)) continue;
      all.push(...(await chunkSource(rel, source)));
    } catch {
      // Unreadable file: skip.
    }
  }
  return all;
}

/** The text embedded and indexed for retrieval: path and symbol give useful lexical signal. */
export function chunkSearchText(c: CodeChunk): string {
  return `${c.filePath}${c.symbol ? ` ${c.symbol}` : ''}\n${c.content}`;
}
