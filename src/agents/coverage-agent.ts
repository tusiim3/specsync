import type { LLMProvider } from '../llm/provider.js';
import type { Requirement, EmbeddedChunk, CoverageResult } from '../types.js';

const CONFIDENCE_THRESHOLD = 0.7;
const MAX_CANDIDATE_CHARS = 200;

function buildPrompt(req: Requirement, candidates: EmbeddedChunk[]): string {
  const candidateText = candidates
    .map((c, i) => {
      const preview = c.content.slice(0, MAX_CANDIDATE_CHARS).replace(/\n/g, ' ');
      return `[${i + 1}] ${c.id}\n${preview}`;
    })
    .join('\n\n');

  return `You are a code-coverage analyst for a spec drift detection tool.

Given the following requirement and candidate code chunks, determine whether the requirement is implemented in the code.

REQUIREMENT ID: ${req.id}
REQUIREMENT HEADING: ${req.heading}
REQUIREMENT TEXT:
${req.body}

CANDIDATE CODE CHUNKS (top-${candidates.length} by semantic similarity):
${candidateText}

Respond with ONLY a valid JSON object — no markdown, no explanation, no code fences. Use exactly this schema:
{
  "requirementId": "${req.id}",
  "covered": true | false,
  "confidence": 0.0-1.0,
  "evidence": ["chunk-id-1", "chunk-id-2"],
  "notes": "brief human-readable explanation"
}

Rules:
- Set "covered": true only if the code clearly implements the requirement's intent.
- "confidence" reflects how certain you are (0.0 = no idea, 1.0 = certain).
- "evidence" lists the chunk IDs (from the [N] prefix) that support your verdict. Use empty array if none.
- Set "covered": false if the candidates only partially address or are tangentially related to the requirement.
- Confidence threshold for "covered": true is ${CONFIDENCE_THRESHOLD}.`;
}

function stripFences(raw: string): string {
  return raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

/**
 * Ask the LLM provider whether a single requirement is covered by the candidate code chunks.
 */
export async function checkCoverage(
  req: Requirement,
  candidates: EmbeddedChunk[],
  provider: LLMProvider,
): Promise<CoverageResult> {
  if (candidates.length === 0) {
    return {
      requirementId: req.id,
      covered: false,
      confidence: 0,
      evidence: [],
      notes: 'No candidate code chunks found via similarity search.',
    };
  }

  const prompt = buildPrompt(req, candidates);

  try {
    const raw = await provider.complete(prompt);
    const cleaned = stripFences(raw);
    const parsed = JSON.parse(cleaned) as Partial<CoverageResult>;

    return {
      requirementId: parsed.requirementId ?? req.id,
      covered: parsed.covered === true,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
      notes: typeof parsed.notes === 'string' ? parsed.notes : '',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      requirementId: req.id,
      covered: false,
      confidence: 0,
      evidence: [],
      notes: `provider error: ${msg}`,
    };
  }
}
