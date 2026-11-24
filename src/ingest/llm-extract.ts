import { z } from 'zod';
import pLimit from 'p-limit';
import type { Cache } from '../cache/cache.js';
import type { LLMProvider, JsonSchemaSpec } from '../llm/provider.js';
import { withRetry } from '../llm/retry.js';
import type { Requirement } from '../types.js';
import { extractJson } from '../agents/verdict.js';
import { requirementText } from './section-split.js';

const EXTRACT_VERSION = '1';

const ExtractResponse = z.object({
  requirements: z.array(z.object({ text: z.string() })),
});

const EXTRACT_SCHEMA: JsonSchemaSpec = {
  name: 'requirement_list',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['requirements'],
    properties: {
      requirements: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['text'],
          properties: { text: { type: 'string' } },
        },
      },
    },
  },
};

const SYSTEM = `You split a section of a product specification into atomic, testable requirements.
Each requirement states one behaviour the software must have, in one or two sentences, keeping concrete values (limits, status codes, field names).
Skip background, rationale and examples that do not add a requirement. If the section contains no requirements, return an empty list.`;

/**
 * Split each heading section into atomic requirements with an LLM.
 * Ids are "<section-id>.<n>", so they stay stable while the section text is unchanged.
 */
export async function extractAtomicRequirements(
  sections: Requirement[],
  provider: LLMProvider,
  cache: Cache,
  opts: { concurrency: number; maxRetries: number; log?: (m: string) => void },
): Promise<Requirement[]> {
  const limit = pLimit(opts.concurrency);
  const lists = await Promise.all(
    sections.map((section) =>
      limit(async () => {
        const key = cache.key('extract', EXTRACT_VERSION, provider.model, requirementText(section));
        const hit = cache.getVerdict(key);
        let texts: string[];
        if (hit) {
          texts = JSON.parse(hit.notes) as string[];
        } else {
          const res = await withRetry(
            () =>
              provider.complete({
                system: SYSTEM,
                prompt: `SECTION\n${requirementText(section)}\n\nReturn the requirements as JSON.`,
                schema: EXTRACT_SCHEMA,
                maxOutputTokens: 8000,
              }),
            { maxRetries: opts.maxRetries },
          );
          texts = ExtractResponse.parse(extractJson(res.text)).requirements.map((r) => r.text.trim()).filter(Boolean);
          // Stored in the verdict table to keep one cache file; notes carries the list.
          cache.setVerdict(key, { requirementId: section.id, verdict: 'not-verifiable', confidence: 1, evidence: [], notes: JSON.stringify(texts) });
        }
        if (texts.length <= 1) return [section];
        return texts.map((text, i) => ({
          ...section,
          id: `${section.id}.${i + 1}`,
          heading: `${section.heading} (${i + 1})`,
          body: text,
        }));
      }),
    ),
  );
  const out = lists.flat();
  opts.log?.(`Extracted ${out.length} atomic requirements from ${sections.length} sections.`);
  return out;
}
