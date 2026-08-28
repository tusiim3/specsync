/** Shared domain types for SpecSync */

/** A single requirement extracted from the spec document */
export interface Requirement {
  id: string;        // stable slug, e.g. "trust-proxy-configuration"
  heading: string;   // original heading text
  body: string;      // full requirement prose
}

/** A chunk of code extracted from the target codebase */
export interface CodeChunk {
  id: string;         // "<filePath>:<startLine>"
  filePath: string;
  startLine: number;
  content: string;
}

/** A code chunk with its embedding vector attached */
export interface EmbeddedChunk extends CodeChunk {
  vector: number[];
}

/** Result of a single coverage-agent evaluation */
export interface CoverageResult {
  requirementId: string;
  covered: boolean;
  confidence: number;       // 0.0 – 1.0
  evidence: string[];       // chunk IDs cited (e.g. "lib/router/index.js:42")
  notes: string;
}

/** A code chunk with no matching requirement */
export interface SurplusChunk {
  chunkId: string;
  filePath: string;
  startLine: number;
  preview: string;   // first 120 chars of content
}

/** Aggregated drift report */
export interface DriftReport {
  runId: string;
  timestamp: string;
  specFile: string;
  repoDir: string;
  score: number;               // 0–100 (% covered)
  totalRequirements: number;
  coveredCount: number;
  gapList: Requirement[];      // requirements with no coverage
  surplusList: SurplusChunk[]; // code with no spec counterpart
  details: CoverageResult[];
}
