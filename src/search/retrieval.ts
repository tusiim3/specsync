import type { EmbeddedChunk } from '../types.js';

const STOPWORDS = new Set(
  (
    'a an and are as at be by can for from has have if in into is it its may must not of on or ' +
    'shall should such that the their then there these this to was were will with when which who ' +
    'all any each every than also only other our we you your they them do does did so per via ' +
    'function return const let var new true false null undefined self this def class import export'
  ).split(' '),
);

/** Split identifiers (camelCase, snake_case, paths) and prose into lowercase terms. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t))
    .map(stem);
}

/** A light suffix stemmer so "parsing", "parses" and "parse" match. */
export function stem(t: string): string {
  if (t.length <= 4) return t;
  let s = t;
  if (s.endsWith('ies') && s.length > 5) s = `${s.slice(0, -3)}y`;
  else if (/(ss|x|z|ch|sh)es$/.test(s)) s = s.slice(0, -2);
  else {
    for (const suf of ['ations', 'ation', 'ings', 'ing', 'ers', 'er', 'ed', 's']) {
      if (s.endsWith(suf) && s.length - suf.length >= 3 && !(suf === 's' && /(ss|us|is)$/.test(s))) {
        s = s.slice(0, -suf.length);
        break;
      }
    }
  }
  // "parse"/"parsing"/"parsed" and "route"/"routes"/"routing" meet at the same stem.
  if (s.endsWith('e') && s.length > 3) s = s.slice(0, -1);
  return s;
}

/** Okapi BM25 over a fixed document set. */
export class Bm25Index {
  private readonly docs: Map<string, number>[] = [];
  private readonly lengths: number[] = [];
  private readonly df = new Map<string, number>();
  private avgLen = 0;

  constructor(texts: string[], private readonly k1 = 1.2, private readonly b = 0.75) {
    for (const text of texts) {
      const tf = new Map<string, number>();
      const toks = tokenize(text);
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push(tf);
      this.lengths.push(toks.length);
    }
    this.avgLen = this.lengths.reduce((a, b) => a + b, 0) / Math.max(1, this.lengths.length);
  }

  scores(query: string): number[] {
    const n = this.docs.length;
    const terms = [...new Set(tokenize(query))];
    return this.docs.map((tf, i) => {
      let s = 0;
      for (const t of terms) {
        const f = tf.get(t);
        if (!f) continue;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        s += (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * this.lengths[i]!) / (this.avgLen || 1)));
      }
      return s;
    });
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function rankOf(scores: number[]): Map<number, number> {
  const order = scores
    .map((s, i) => [s, i] as const)
    .filter(([s]) => s > 0)
    .sort((x, y) => y[0] - x[0]);
  return new Map(order.map(([, i], r) => [i, r]));
}

export interface Query {
  text: string;
  vector: number[];
  /** Relative weight in fusion; the full requirement defaults to 1. */
  weight?: number;
}

/**
 * Hybrid retrieval: semantic (embedding cosine) and lexical (BM25) rankings,
 * for one or more queries, combined with reciprocal-rank fusion (no score
 * calibration needed between the two signals).
 */
export class HybridRetriever {
  private readonly bm25: Bm25Index;

  constructor(
    private readonly chunks: EmbeddedChunk[],
    searchTexts: string[],
    private readonly rrfK = 60,
  ) {
    this.bm25 = new Bm25Index(searchTexts);
  }

  search(queries: Query[], k: number): EmbeddedChunk[] {
    if (this.chunks.length === 0 || queries.length === 0) return [];
    const fused = new Array<number>(this.chunks.length).fill(0);
    for (const q of queries) {
      const w = q.weight ?? 1;
      const semantic = rankOf(this.chunks.map((c) => cosine(q.vector, c.vector)));
      const lexical = rankOf(this.bm25.scores(q.text));
      for (let i = 0; i < this.chunks.length; i++) {
        const s = semantic.get(i);
        const l = lexical.get(i);
        if (s !== undefined) fused[i]! += w / (this.rrfK + s);
        if (l !== undefined) fused[i]! += w / (this.rrfK + l);
      }
    }
    return fused
      .map((score, i) => [score, i] as const)
      .filter(([score]) => score > 0)
      .sort((x, y) => y[0] - x[0])
      .slice(0, k)
      .map(([, i]) => this.chunks[i]!);
  }
}
