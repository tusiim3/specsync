import { normalizeToMarkdown } from './ingest/normalize.js';
import { splitSections } from './ingest/section-split.js';
import { chunkCodebase } from './ingest/code-chunker.js';
import { embed, embedChunks } from './embed/embedder.js';
import { runMapping } from './agents/orchestrator.js';
import type { LLMProvider } from './llm/provider.js';
import type { Requirement, EmbeddedChunk, DriftReport } from './types.js';
import { generateReport } from './report/generator.js';

export interface PipelineOptions {
  specFile: string;
  repoDir: string;
  provider: LLMProvider;
}

/**
 * End-to-end SpecSync pipeline.
 * Returns a fully populated DriftReport.
 */
export async function runPipeline(opts: PipelineOptions): Promise<DriftReport> {
  const { specFile, repoDir, provider } = opts;

  // ── 1. Ingest spec ─────────────────────────────────────────────────────────
  console.error('\n[1/5] Ingesting spec document...');
  const markdown = await normalizeToMarkdown(specFile);
  const requirements = splitSections(markdown);
  console.error(`      Found ${requirements.length} requirement sections.`);

  // ── 2. Embed requirements ──────────────────────────────────────────────────
  console.error('\n[2/5] Embedding spec requirements...');
  const reqTexts = requirements.map((r: Requirement) => `${r.heading}: ${r.body}`);
  const reqVectors = await embed(reqTexts);
  // Attach vectors to requirements for orchestrator use
  const reqsWithVectors = requirements.map((r: Requirement, i: number) => ({
    ...r,
    vector: reqVectors[i]!,
  })) as Array<Requirement & { vector: number[] }>;
  console.error(`      Embedded ${reqsWithVectors.length} requirements.`);

  // ── 3. Chunk + embed codebase ──────────────────────────────────────────────
  console.error('\n[3/5] Chunking and embedding codebase...');
  const rawChunks = await chunkCodebase(repoDir);
  console.error(`      Found ${rawChunks.length} code chunks.`);
  const embeddedChunks: EmbeddedChunk[] = await embedChunks(rawChunks);
  console.error(`      Embedded ${embeddedChunks.length} code chunks.`);

  // ── 4. Run parallel coverage agents ───────────────────────────────────────
  console.error('\n[4/5] Running parallel coverage agents...');
  console.error(`      Provider: ${provider.name}`);
  const { coverageResults, surplusChunks } = await runMapping(
    reqsWithVectors,
    embeddedChunks,
    provider,
  );

  // ── 5. Generate report ─────────────────────────────────────────────────────
  console.error('\n[5/5] Generating drift report...');
  const report = generateReport({
    specFile,
    repoDir,
    requirements,
    coverageResults,
    surplusChunks,
  });

  return report;
}
