/**
 * Cross-encoder reranker using Cohere Rerank.
 *
 * Module 5: this is the single biggest quality lever after chunking. A cheap
 * bi-encoder (vector search) gets ~80 candidates with high recall but mediocre
 * precision; the cross-encoder re-scores each (query, chunk) jointly and picks
 * the best top-K. ~15–30% nDCG@10 lift on real datasets.
 *
 * Behavior:
 *   • If `COHERE_API_KEY` is missing, returns the input candidates unchanged
 *     (graceful degradation per Module 8). The CLI / pipeline can fall back
 *     to RRF or vector-score ranking.
 *   • Up to 100 candidates per call (Cohere limit; we cap conservatively).
 *   • Each candidate's `text` is what the reranker sees (NOT parent_text).
 *     Rerank scores reflect chunk-level relevance.
 */
import { getCohere, isCohereConfigured } from "@/lib/clients/cohere";
import type { Candidate } from "@/lib/rag/retrieval";

const RERANK_MODEL = process.env.COHERE_RERANK_MODEL || "rerank-v3.5";
const MAX_CANDIDATES = 100;
const TIMEOUT_MS = 5_000;

export interface RerankResult {
  /** Candidates sorted by relevance, with `rerank_score` populated. */
  candidates: (Candidate & { rerank_score: number | null })[];
  /** Whether Cohere actually scored. False = passthrough (no key, error, empty input). */
  reranked: boolean;
  /** Wall-clock latency. 0 if skipped. */
  latency_ms: number;
}

export async function rerank(
  query: string,
  candidates: Candidate[],
  opts: { topK?: number } = {},
): Promise<RerankResult> {
  const topK = opts.topK ?? 10;

  if (candidates.length === 0) {
    return { candidates: [], reranked: false, latency_ms: 0 };
  }

  if (!isCohereConfigured()) {
    return {
      candidates: candidates.map((c) => ({ ...c, rerank_score: null })),
      reranked: false,
      latency_ms: 0,
    };
  }

  const truncated = candidates.slice(0, MAX_CANDIDATES);
  const documents = truncated.map((c) => c.text);

  const t0 = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const client = getCohere();
    // Cohere SDK v8 surface: `client.v2.rerank({ model, query, documents, topN })`.
    // We use top_n equal to the input length so we get a score for every
    // candidate; the caller can slice to topK after sorting.
    const res = await client.v2.rerank(
      {
        model: RERANK_MODEL,
        query,
        documents,
        topN: truncated.length,
      },
      { abortSignal: controller.signal },
    );

    clearTimeout(timer);

    // res.results: [{ index, relevanceScore }], sorted by relevance descending.
    const scored: (Candidate & { rerank_score: number | null })[] = truncated.map(
      (c) => ({ ...c, rerank_score: null }),
    );
    for (const r of res.results) {
      scored[r.index].rerank_score = r.relevanceScore;
    }

    scored.sort((a, b) => (b.rerank_score ?? -Infinity) - (a.rerank_score ?? -Infinity));

    return {
      candidates: scored.slice(0, topK),
      reranked: true,
      latency_ms: Date.now() - t0,
    };
  } catch (err) {
    // Fail-open: rerank failure should not take down retrieval.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`rerank failed (passthrough): ${msg.slice(0, 200)}`);
    return {
      candidates: candidates.map((c) => ({ ...c, rerank_score: null })),
      reranked: false,
      latency_ms: Date.now() - t0,
    };
  }
}
