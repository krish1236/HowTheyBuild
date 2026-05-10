/**
 * Answer-level cache.
 *
 * Key: `ans:v1:{model}:{prompt_hash}:{normalized_query_hash}`
 *   - model: pinned ANTHROPIC_MODEL (so model swaps invalidate)
 *   - prompt_hash: sha256 of SYSTEM_PROMPT (so prompt changes invalidate)
 *   - normalized_query: lowercase + collapsed whitespace + stripped trailing
 *     punctuation; small variations of the same question hit the same key
 *
 * V1 deliberately does NOT include retrieved-chunks_hash in the key. Module 8
 * notes the trade-off: with chunks_hash in the key, cache hits guarantee
 * answer freshness but require running retrieval first (no latency win).
 * Without it, hits skip retrieval+generation entirely; staleness is bounded
 * by the 1h TTL. We accept the staleness for the throughput win and revisit
 * in Phase 10 with the semantic-cache layer.
 */
import { createHash } from "node:crypto";
import { getJSON, setJSON } from "@/lib/cache/redis";
import { SYSTEM_PROMPT } from "@/lib/rag/prompt";

const ANSWER_TTL_S = 60 * 60; // 1h

const PROMPT_HASH = createHash("sha256")
  .update(SYSTEM_PROMPT)
  .digest("hex")
  .slice(0, 12);

export interface CachedAnswer {
  answer: string;
  cited_chunk_ids: string[];
  /** Citation metadata so the SSE stream can replay citation events on hit. */
  citations: {
    chunk_id: string;
    source_name: string;
    document_title: string;
    document_url: string;
    breadcrumb: string;
  }[];
  cost_usd: number; // cost of the ORIGINAL generation; we record 0 on hit
  reranked_chunk_ids: string[];
  retrieved_chunk_ids: string[];
  top_rerank_score: number | null;
  generated_at: string;
}

function normalize(query: string): string {
  return query
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[?!.,;:]+\s*$/, "")
    .trim();
}

export function answerCacheKey(query: string): string {
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";
  const qHash = createHash("sha256").update(normalize(query)).digest("hex").slice(0, 24);
  return `ans:v1:${model}:${PROMPT_HASH}:${qHash}`;
}

export async function getCachedAnswer(query: string): Promise<CachedAnswer | null> {
  return getJSON<CachedAnswer>(answerCacheKey(query));
}

export async function storeCachedAnswer(
  query: string,
  value: CachedAnswer,
): Promise<void> {
  await setJSON(answerCacheKey(query), value, ANSWER_TTL_S);
}
