/** Source languages SpecSync understands, and how to parse each. */

export interface LanguageSpec {
  id: string;
  /** Tree-sitter grammar file in @vscode/tree-sitter-wasm, if structural parsing is supported. */
  grammar?: string;
}

const LANGS: Record<string, LanguageSpec> = {
  '.js': { id: 'javascript', grammar: 'tree-sitter-javascript.wasm' },
  '.mjs': { id: 'javascript', grammar: 'tree-sitter-javascript.wasm' },
  '.cjs': { id: 'javascript', grammar: 'tree-sitter-javascript.wasm' },
  '.jsx': { id: 'javascript', grammar: 'tree-sitter-javascript.wasm' },
  '.ts': { id: 'typescript', grammar: 'tree-sitter-typescript.wasm' },
  '.mts': { id: 'typescript', grammar: 'tree-sitter-typescript.wasm' },
  '.cts': { id: 'typescript', grammar: 'tree-sitter-typescript.wasm' },
  '.tsx': { id: 'tsx', grammar: 'tree-sitter-tsx.wasm' },
  '.py': { id: 'python', grammar: 'tree-sitter-python.wasm' },
  '.go': { id: 'go', grammar: 'tree-sitter-go.wasm' },
  '.java': { id: 'java', grammar: 'tree-sitter-java.wasm' },
  '.rb': { id: 'ruby', grammar: 'tree-sitter-ruby.wasm' },
  '.rs': { id: 'rust', grammar: 'tree-sitter-rust.wasm' },
  '.cs': { id: 'csharp', grammar: 'tree-sitter-c-sharp.wasm' },
  '.php': { id: 'php', grammar: 'tree-sitter-php.wasm' },
  '.cpp': { id: 'cpp', grammar: 'tree-sitter-cpp.wasm' },
  '.cc': { id: 'cpp', grammar: 'tree-sitter-cpp.wasm' },
  '.cxx': { id: 'cpp', grammar: 'tree-sitter-cpp.wasm' },
  '.hpp': { id: 'cpp', grammar: 'tree-sitter-cpp.wasm' },
  '.h': { id: 'cpp', grammar: 'tree-sitter-cpp.wasm' },
  '.c': { id: 'cpp', grammar: 'tree-sitter-cpp.wasm' },
  // Line-window fallback (no structural parser bundled).
  '.kt': { id: 'kotlin' },
  '.kts': { id: 'kotlin' },
  '.swift': { id: 'swift' },
  '.scala': { id: 'scala' },
  '.vue': { id: 'vue' },
  '.svelte': { id: 'svelte' },
  '.dart': { id: 'dart' },
  '.ex': { id: 'elixir' },
  '.exs': { id: 'elixir' },
  '.lua': { id: 'lua' },
  '.sh': { id: 'shell' },
  '.sql': { id: 'sql' },
};

export const SOURCE_EXTENSIONS = Object.keys(LANGS);

export function languageFor(filePath: string): LanguageSpec | undefined {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return undefined;
  return LANGS[filePath.slice(dot).toLowerCase()];
}
