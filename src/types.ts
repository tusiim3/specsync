/** Shared domain types for SpecSync. */

/** How well a requirement is implemented by the code. */
export type Verdict = 'implemented' | 'partial' | 'missing' | 'not-verifiable' | 'error';

export const VERDICTS: readonly Verdict[] = [
  'implemented',
  'partial',
  'missing',
  'not-verifiable',
  'error',
];

/** A single requirement extracted from a spec document. */
export interface Requirement {
  /** Stable id: an explicit id from the spec (e.g. "REQ-12") or a slug of the heading. */
  id: string;
  /** Heading text of the section the requirement came from. */
  heading: string;
  /** Parent headings, outermost first (excludes the document title). */
  path: string[];
  /** Requirement prose (Markdown). */
  body: string;
  /** Where it came from, for links and SARIF locations. */
  source: { file: string; line: number };
}

export type ChunkKind = 'function' | 'method' | 'class' | 'type' | 'module' | 'window';

/** A contiguous slice of a source file. */
export interface CodeChunk {
  /** "<filePath>:<startLine>-<endLine>" */
  id: string;
  /** Repo-relative POSIX path. */
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  kind: ChunkKind;
  /** Qualified symbol name when the chunk is a declaration, e.g. "UserService.create". */
  symbol?: string;
  /** True when the declaration is part of the file's public surface. */
  exported: boolean;
  content: string;
  /** sha256 of content, used for caching. */
  hash: string;
}

export interface EmbeddedChunk extends CodeChunk {
  vector: number[];
}

export interface Evidence {
  chunkId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  reason: string;
}

export interface RequirementResult {
  requirementId: string;
  verdict: Verdict;
  /** 0..1, the model's confidence in its verdict. */
  confidence: number;
  evidence: Evidence[];
  notes: string;
  /** True when the verdict came from the local cache. */
  cached: boolean;
  /** Set when verdict is "error". */
  error?: string;
}

/** A public symbol that no requirement's evidence points at. */
export interface SurplusItem {
  chunkId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  kind: ChunkKind;
}

export interface VerdictCounts {
  implemented: number;
  partial: number;
  missing: number;
  notVerifiable: number;
  error: number;
}

export interface RunStats {
  files: number;
  chunks: number;
  llmCalls: number;
  cacheHits: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface DriftReport {
  schemaVersion: 1;
  runId: string;
  timestamp: string;
  specFiles: string[];
  repoDir: string;
  provider: string;
  model: string;
  /** 0..100 spec coverage, or null when nothing could be scored. */
  score: number | null;
  /** False when any requirement ended in an error, so the score is partial. */
  complete: boolean;
  counts: VerdictCounts;
  requirements: Requirement[];
  results: RequirementResult[];
  surplus: SurplusItem[];
  /** Total public symbols found, so surplus can be shown as "N of M". */
  publicSymbols: number;
  stats: RunStats;
}
