import type { EmbeddedChunk } from '../types.js';

/** Cosine similarity between two equal-length vectors */
function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Return the top-K most similar chunks to a query vector.
 * Results are sorted descending by similarity score.
 */
export function topK(
  queryVec: number[],
  corpus: EmbeddedChunk[],
  k: number,
): EmbeddedChunk[] {
  return corpus
    .map((chunk) => ({ chunk, score: cosineSim(queryVec, chunk.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ chunk }) => chunk);
}
