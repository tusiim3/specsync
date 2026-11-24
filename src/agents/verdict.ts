import { z } from 'zod';
import type { CodeChunk, Evidence, Requirement, RequirementResult } from '../types.js';
import type { JsonSchemaSpec } from '../llm/provider.js';
import { requirementText } from '../ingest/section-split.js';

/** Bump when the prompt or schema changes so cached verdicts are not reused. */
export const PROMPT_VERSION = '3';

export const VerdictResponse = z.object({
  verdict: z.enum(['implemented', 'partial', 'missing', 'not-verifiable']),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.object({ chunk: z.string(), reason: z.string() })),
  notes: z.string(),
});
export type VerdictResponse = z.infer<typeof VerdictResponse>;

/** JSON schema sent to providers (strict-mode compatible: all fields required, no extras). */
export const VERDICT_SCHEMA: JsonSchemaSpec = {
  name: 'requirement_verdict',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'confidence', 'evidence', 'notes'],
    properties: {
      verdict: { type: 'string', enum: ['implemented', 'partial', 'missing', 'not-verifiable'] },
      confidence: { type: 'number', description: '0.0 to 1.0' },
      evidence: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['chunk', 'reason'],
          properties: {
            chunk: { type: 'string', description: 'Label of a shown code chunk, e.g. "C3"' },
            reason: { type: 'string', description: 'What this code does for the requirement' },
          },
        },
      },
      notes: { type: 'string', description: 'One or two sentences explaining the verdict' },
    },
  },
};

export const SYSTEM_PROMPT = `You audit whether a codebase implements a requirement from its specification.

You get one requirement and a set of code chunks retrieved from the repository. Decide:
- "implemented": the shown code clearly does what the requirement asks, including its specific conditions, limits and error behaviour.
- "partial": some of the requirement is implemented but something it explicitly asks for is missing or different. Say what is missing in notes.
- "missing": the shown code does not implement it. Related but different behaviour is "missing", not "partial".
- "not-verifiable": the requirement cannot be judged from source code at all (team process, documentation, legal, uptime SLAs, visual design).

Rules:
- Judge only from the code shown. Do not assume code that is not shown exists. If the retrieved chunks are unrelated, the answer is "missing".
- Cite evidence by chunk label (e.g. "C2"). Cite only chunks that actually implement part of the requirement; cite nothing for "missing" or "not-verifiable".
- confidence is how sure you are of the verdict (not how complete the implementation is).
- notes: one or two plain sentences a developer can act on. Name the specific gap for "partial" and "missing".`;

/** Characters per token, roughly, for budgeting. */
const CHARS_PER_TOKEN = 4;

export interface Candidate {
  label: string;
  chunk: CodeChunk;
}

/**
 * Render candidate chunks under a token budget. Long chunks keep their head
 * and tail with an explicit marker for the omitted middle, never silently cut.
 */
export function renderCandidates(chunks: CodeChunk[], maxTokens: number): { text: string; candidates: Candidate[] } {
  const budget = maxTokens * CHARS_PER_TOKEN;
  const perChunk = Math.max(1200, Math.floor(budget / Math.max(1, chunks.length)));
  const parts: string[] = [];
  const candidates: Candidate[] = [];
  let used = 0;
  chunks.forEach((chunk, i) => {
    if (used >= budget) return;
    const label = `C${i + 1}`;
    let body = chunk.content;
    if (body.length > perChunk) {
      const lines = body.split('\n');
      const head: string[] = [];
      const tail: string[] = [];
      let size = 0;
      let h = 0;
      let t = lines.length - 1;
      while (h <= t && size < perChunk * 0.7) size += (head.push(lines[h++]!), lines[h - 1]!.length + 1);
      while (t >= h && size < perChunk) size += (tail.unshift(lines[t--]!), lines[t + 1]!.length + 1);
      const omitted = t - h + 1;
      body = omitted > 0 ? `${head.join('\n')}\n    … (${omitted} lines omitted) …\n${tail.join('\n')}` : body;
    }
    const header = `[${label}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine}${chunk.symbol ? ` (${chunk.symbol})` : ''}`;
    const block = `${header}\n\`\`\`${chunk.language}\n${body}\n\`\`\``;
    used += block.length;
    parts.push(block);
    candidates.push({ label, chunk });
  });
  return { text: parts.join('\n\n'), candidates };
}

export function buildPrompt(req: Requirement, candidatesText: string): string {
  return `REQUIREMENT ${req.id}
${requirementText(req)}

CODE CHUNKS (retrieved by search; may be unrelated)
${candidatesText || '(no code matched this requirement)'}

Return the verdict as JSON.`;
}

/** Pull the first JSON object out of a model reply (tolerates code fences or prose around it). */
export function extractJson(raw: string): unknown {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error('response is not JSON');
  }
}

/**
 * Validate a model reply and map chunk labels back to real code locations.
 * Labels that were not shown are dropped. A coverage claim with no valid
 * evidence is downgraded to low-confidence "partial", since it is unsupported.
 */
export function interpretResponse(
  req: Requirement,
  raw: string,
  candidates: Candidate[],
): Omit<RequirementResult, 'cached'> {
  const parsed = VerdictResponse.parse(extractJson(raw));
  const byLabel = new Map(candidates.map((c) => [c.label.toUpperCase(), c.chunk]));
  const evidence: Evidence[] = [];
  const seen = new Set<string>();
  for (const e of parsed.evidence) {
    const label = e.chunk.trim().replace(/^\[|\]$/g, '').toUpperCase();
    const chunk = byLabel.get(label) ?? candidates.find((c) => c.chunk.id === e.chunk.trim())?.chunk;
    if (!chunk || seen.has(chunk.id)) continue;
    seen.add(chunk.id);
    evidence.push({
      chunkId: chunk.id,
      filePath: chunk.filePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      symbol: chunk.symbol,
      reason: e.reason.trim(),
    });
  }

  let verdict: RequirementResult['verdict'] = parsed.verdict;
  let confidence = parsed.confidence;
  let notes = parsed.notes.trim();
  if ((verdict === 'implemented' || verdict === 'partial') && evidence.length === 0) {
    verdict = 'partial';
    confidence = Math.min(confidence, 0.3);
    notes = `${notes} (The model claimed coverage but cited no shown code, so this is unconfirmed.)`.trim();
  }
  if (verdict === 'missing' || verdict === 'not-verifiable') evidence.length = 0;
  return { requirementId: req.id, verdict, confidence, evidence, notes };
}
