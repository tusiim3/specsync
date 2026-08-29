import pLimit from 'p-limit';
import { checkCoverage } from './coverage-agent.js';
import { topK } from '../search/similarity.js';
import type { LLMProvider } from '../llm/provider.js';
import type {
  Requirement,
  EmbeddedChunk,
  CoverageResult,
  SurplusChunk,
} from '../types.js';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _RequirementWithVector = Requirement & { vector?: number[] };

const TOP_K = 8;
const CONCURRENCY_LIMIT = 8;
const CONFIDENCE_THRESHOLD = 0.7;

export interface MappingResult {
  coverageResults: CoverageResult[];
  surplusChunks: SurplusChunk[];
}

/**
 * Fan out coverage checks across all requirements in parallel.
 * Logs progress to stderr so parallelism is visible in the terminal.
 */
export async function runMapping(
  requirements: Requirement[],
  embeddedChunks: EmbeddedChunk[],
  provider: LLMProvider,
): Promise<MappingResult> {
  const limit = pLimit(CONCURRENCY_LIMIT);

  console.error(
    `\n  Spawning ${requirements.length} coverage agents (max ${CONCURRENCY_LIMIT} parallel)...\n`,
  );

  const coverageResults = await Promise.all(
    requirements.map((req, idx) =>
      limit(async () => {
        const agentTag = `[agent-${String(idx + 1).padStart(2, '0')}]`;
        process.stderr.write(`  ${agentTag} checking: "${req.heading}"\n`);

        // Use the pre-embedded requirement vector passed in from the pipeline
        const reqVec = (req as Requirement & { vector?: number[] }).vector ?? [];
        const candidates = topK(reqVec, embeddedChunks, TOP_K);

        const result = await checkCoverage(req, candidates, provider);

        const status = result.covered
          ? `✓ covered (${result.confidence.toFixed(2)})`
          : `✗ gap     (${result.confidence.toFixed(2)})`;
        process.stderr.write(`  ${agentTag} done:    ${status} — ${req.heading}\n`);

        return result;
      }),
    ),
  );

  // Surplus detection: chunks not cited by any high-confidence result
  const citedIds = new Set<string>(
    coverageResults
      .filter((r) => r.covered && r.confidence >= CONFIDENCE_THRESHOLD)
      .flatMap((r) => r.evidence),
  );

  // We compare against chunk IDs loosely (evidence may be partial paths)
  const surplusChunks: SurplusChunk[] = embeddedChunks
    .filter((chunk) => {
      const cited = [...citedIds].some(
        (id) => chunk.id.includes(id) || id.includes(chunk.filePath),
      );
      return !cited;
    })
    .slice(0, 20) // cap surplus list at 20 for readability
    .map((chunk) => ({
      chunkId: chunk.id,
      filePath: chunk.filePath,
      startLine: chunk.startLine,
      preview: chunk.content.slice(0, 120).replace(/\n/g, ' '),
    }));

  console.error(
    `\n  All agents complete. ${coverageResults.filter((r) => r.covered).length}/${requirements.length} requirements covered.\n`,
  );

  return { coverageResults, surplusChunks };
}
