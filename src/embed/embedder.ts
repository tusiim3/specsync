import { pipeline } from '@huggingface/transformers';
import type { EmbeddedChunk, CodeChunk } from '../types.js';

const MODEL = 'Xenova/all-MiniLM-L6-v2';
const BATCH_SIZE = 32;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipelineInstance: any = null;

async function getPipeline() {
  if (!pipelineInstance) {
    process.stderr.write('  Loading embedding model (first run downloads ~80MB)...\n');
    pipelineInstance = await pipeline('feature-extraction', MODEL);
    process.stderr.write('  Embedding model ready.\n');
  }
  return pipelineInstance;
}

/**
 * Embed an array of text strings, returning one float32 vector per input.
 * Processes in batches to avoid OOM on large corpora.
 */
export async function embed(texts: string[]): Promise<number[][]> {
  const extractor = await getPipeline();
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output: any = await extractor(batch, { pooling: 'mean', normalize: true });
    // output.data is a flat Float32Array of shape [batchSize * hiddenDim]
    const data: Float32Array = output.data;
    const dim = data.length / batch.length;
    for (let b = 0; b < batch.length; b++) {
      results.push(Array.from(data.slice(b * dim, (b + 1) * dim)));
    }
  }

  return results;
}

/** Attach embedding vectors to an array of CodeChunks */
export async function embedChunks(chunks: CodeChunk[]): Promise<EmbeddedChunk[]> {
  const texts = chunks.map((c) => c.content.slice(0, 512)); // cap length for model
  const vectors = await embed(texts);
  return chunks.map((c, i) => ({ ...c, vector: vectors[i]! }));
}
