/**
 * `queries` table writer. One row per /api/query request.
 *
 * This is the audit + cost + abuse-detection log. Every served request
 * produces exactly one row, whether it answered or refused. Errors that
 * abort the pipeline ALSO produce a row (refused=true, reason="error: ...").
 *
 * Privacy: we store `client_ip_hash` (HMAC), never raw IP. Module 9.
 */
import { sql } from "@/lib/db/client";

export interface QueryLogRow {
  client_ip_hash: string;
  query_text: string;
  rewritten_query: string | null;
  retrieved_chunk_ids: number[];
  reranked_chunk_ids: number[];
  top_rerank_score: number | null;
  refused: boolean;
  refusal_reason: string | null;
  llm_model: string;
  llm_input_tokens: number;
  llm_input_tokens_cached: number;
  llm_output_tokens: number;
  total_cost_usd: number;
  total_latency_ms: number;
  ttft_ms: number | null;
  cache_hit: boolean;
}

export async function insertQueryLog(row: QueryLogRow): Promise<void> {
  await sql`
    INSERT INTO queries (
      client_ip_hash,
      query_text,
      rewritten_query,
      retrieved_chunk_ids,
      reranked_chunk_ids,
      top_rerank_score,
      refused,
      refusal_reason,
      llm_model,
      llm_input_tokens,
      llm_input_tokens_cached,
      llm_output_tokens,
      total_cost_usd,
      total_latency_ms,
      ttft_ms,
      cache_hit
    ) VALUES (
      ${row.client_ip_hash},
      ${row.query_text},
      ${row.rewritten_query},
      ${row.retrieved_chunk_ids},
      ${row.reranked_chunk_ids},
      ${row.top_rerank_score},
      ${row.refused},
      ${row.refusal_reason},
      ${row.llm_model},
      ${row.llm_input_tokens},
      ${row.llm_input_tokens_cached},
      ${row.llm_output_tokens},
      ${row.total_cost_usd},
      ${row.total_latency_ms},
      ${row.ttft_ms},
      ${row.cache_hit}
    )
  `;
}
