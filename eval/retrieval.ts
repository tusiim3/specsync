/**
 * Retrieval benchmark: for each labelled requirement, is a file that implements it
 * among the top-K chunks SpecSync would show the model? Compares embedding models.
 *
 *   npm run eval:retrieval -- --embeddings local --embeddings-model Xenova/bge-small-en-v1.5
 *   npm run eval:retrieval -- --embeddings none     # BM25 only
 */
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { parseArgs } from 'util';
import { loadDotenv } from '../src/env.js';
import { parseConfig } from '../src/config.js';
import { Cache } from '../src/cache/cache.js';
import { CachedEmbedder, createEmbedder, type Embedder } from '../src/embed/embedder.js';
import { listSourceFiles } from '../src/ingest/files.js';
import { chunkFiles, chunkSearchText } from '../src/ingest/code-chunker.js';
import { loadRequirements } from '../src/pipeline.js';
import { requirementText, subQueries } from '../src/ingest/section-split.js';
import { HybridRetriever } from '../src/search/retrieval.js';

const { values } = parseArgs({
  options: {
    embeddings: { type: 'string', default: 'local' },
    'embeddings-model': { type: 'string' },
    k: { type: 'string', default: '8' },
    cache: { type: 'string' },
  },
});

loadDotenv(process.cwd());
const root = resolve(import.meta.dirname, '..');
const k = Number(values.k);
const { cases } = JSON.parse(await readFile(resolve(root, 'eval/retrieval.json'), 'utf-8')) as {
  cases: Array<{ name: string; spec: string; repo: string; evidence: Record<string, string[]> }>;
};

/** Zero vectors: semantic ranking contributes nothing, leaving BM25 alone. */
const none: Embedder = { id: 'none', embed: async (t) => t.map(() => [0]) };
const config = parseConfig({
  embeddings: values.embeddings === 'none' ? {} : { provider: values.embeddings, model: values['embeddings-model'] },
});
const inner = values.embeddings === 'none' ? none : createEmbedder(config, (m) => console.error(m));
const cache = values.cache ? new Cache(values.cache) : Cache.disabled();
await cache.load();
const embedder = new CachedEmbedder(inner, cache);
await embedder.prepare();

let hits = 0;
let total = 0;
let rr = 0;
const started = Date.now();
for (const c of cases) {
  const repo = resolve(root, c.repo);
  if (!existsSync(repo)) {
    console.error(`skip ${c.name}: ${c.repo} missing`);
    continue;
  }
  const reqs = await loadRequirements([resolve(root, c.spec)], config);
  const chunks = await chunkFiles(repo, await listSourceFiles(repo));
  const texts = chunks.map(chunkSearchText);
  const vectors = await embedder.embed(texts);
  const retriever = new HybridRetriever(chunks.map((ch, i) => ({ ...ch, vector: vectors[i]! })), texts);
  let caseHits = 0;
  for (const [id, files] of Object.entries(c.evidence)) {
    const req = reqs.find((r) => r.id === id);
    if (!req) throw new Error(`${c.name}: no requirement ${id}`);
    const qs = [requirementText(req), ...subQueries(req)];
    const qv = await embedder.embed(qs);
    const queries = qs.map((text, j) => ({ text, vector: qv[j]!, weight: j === 0 ? 1 : 1 / Math.max(1, Math.sqrt(qs.length - 1)) }));
    const kk = Math.min(k + Math.max(0, queries.length - 1), k * 2);
    const got = retriever.search(queries, kk);
    const rank = got.findIndex((ch) => files.includes(ch.filePath));
    total++;
    if (rank >= 0) {
      hits++;
      caseHits++;
      rr += 1 / (rank + 1);
    } else console.error(`  miss ${c.name}/${id}: top files ${[...new Set(got.map((g) => g.filePath))].slice(0, 4).join(', ')}`);
  }
  console.error(`${c.name}: ${caseHits}/${Object.keys(c.evidence).length}`);
}
await cache.save();
console.log(
  `${embedder.id.padEnd(48)} recall@${k}: ${hits}/${total} (${Math.round((hits / total) * 100)}%)  MRR: ${(rr / total).toFixed(2)}  ${((Date.now() - started) / 1000).toFixed(1)}s`,
);
