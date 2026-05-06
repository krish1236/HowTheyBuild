/**
 * Hybrid retrieval: vector search (pgvector cosine) + Postgres full-text search,
 * run in parallel, deduped by chunk_id.
 *
 *  - Vector retrieves the top N most semantically similar chunks.
 *  - FTS retrieves the top N most lexically relevant chunks (BM25-equivalent).
 *  - Both are joined to documents + sources for metadata.
 *  - Output is the merged candidate set; ranking and pruning happen downstream
 *    (reranker in production; vector-score sort as a fallback if rerank is off).
 *
 * Module 5: hybrid > vector-only by 10–25% on real benchmarks. The fusion
 * step here is intentionally absent — we let the reranker fuse, per "best
 * fusion is no fusion."
 */
import { sql } from "@/lib/db/client";
import { embedTexts } from "@/lib/embeddings";

export interface Candidate {
  chunk_id: string;
  document_id: string;
  document_url: string;
  document_title: string;
  source_name: string;
  breadcrumb: string;
  text: string;
  parent_text: string | null;
  /** Cosine similarity in [-1, 1]. Null if this candidate came only from FTS. */
  vector_score: number | null;
  /** ts_rank score. Null if this candidate came only from vector search. */
  fts_score: number | null;
  /** Where the candidate came from (debug aid). */
  source_layer: "vector" | "fts" | "both";
}

export interface HybridRetrieveOptions {
  vector_limit?: number; // default 50
  fts_limit?: number; // default 50
  /** Optional debug hook to capture per-stage timings. */
  onTiming?: (timings: { embed_ms: number; vector_ms: number; fts_ms: number }) => void;
}

interface VectorRow {
  chunk_id: string;
  document_id: string;
  document_url: string;
  document_title: string;
  source_name: string;
  breadcrumb: string;
  text: string;
  parent_text: string | null;
  vector_score: number;
}

interface FTSRow {
  chunk_id: string;
  document_id: string;
  document_url: string;
  document_title: string;
  source_name: string;
  breadcrumb: string;
  text: string;
  parent_text: string | null;
  fts_score: number;
}

function vectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

export async function hybridRetrieve(
  query: string,
  opts: HybridRetrieveOptions = {},
): Promise<Candidate[]> {
  const vectorLimit = opts.vector_limit ?? 50;
  const ftsLimit = opts.fts_limit ?? 50;

  // 1. Embed the query (one short call; not batched).
  const t0 = Date.now();
  const [queryEmbedding] = await embedTexts([query]);
  const embed_ms = Date.now() - t0;
  const qvec = vectorLiteral(queryEmbedding);

  // 2. Run vector + FTS in parallel.
  const tVec = Date.now();
  const tFts = tVec;

  const [vectorRows, ftsRows] = await Promise.all([
    sql<VectorRow[]>`
      SELECT
        c.id::text                        AS chunk_id,
        c.document_id::text               AS document_id,
        d.url                             AS document_url,
        d.title                           AS document_title,
        s.name                            AS source_name,
        c.breadcrumb,
        c.text,
        c.parent_text,
        (1 - (c.embedding <=> ${qvec}::vector))::float8  AS vector_score
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      JOIN sources   s ON s.id = d.source_id
      WHERE d.status = 'active'
      ORDER BY c.embedding <=> ${qvec}::vector
      LIMIT ${vectorLimit}
    `,
    sql<FTSRow[]>`
      SELECT
        c.id::text                        AS chunk_id,
        c.document_id::text               AS document_id,
        d.url                             AS document_url,
        d.title                           AS document_title,
        s.name                            AS source_name,
        c.breadcrumb,
        c.text,
        c.parent_text,
        ts_rank(c.text_fts, plainto_tsquery('english', ${query}))::float8 AS fts_score
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      JOIN sources   s ON s.id = d.source_id
      WHERE d.status = 'active'
        AND c.text_fts @@ plainto_tsquery('english', ${query})
      ORDER BY fts_score DESC
      LIMIT ${ftsLimit}
    `,
  ]);

  const vector_ms = Date.now() - tVec;
  const fts_ms = Date.now() - tFts;
  opts.onTiming?.({ embed_ms, vector_ms, fts_ms });

  // 3. Dedupe by chunk_id, preserve both scores when a chunk appears in both.
  const merged = new Map<string, Candidate>();

  for (const r of vectorRows) {
    merged.set(r.chunk_id, {
      chunk_id: r.chunk_id,
      document_id: r.document_id,
      document_url: r.document_url,
      document_title: r.document_title,
      source_name: r.source_name,
      breadcrumb: r.breadcrumb,
      text: r.text,
      parent_text: r.parent_text,
      vector_score: r.vector_score,
      fts_score: null,
      source_layer: "vector",
    });
  }
  for (const r of ftsRows) {
    const existing = merged.get(r.chunk_id);
    if (existing) {
      existing.fts_score = r.fts_score;
      existing.source_layer = "both";
    } else {
      merged.set(r.chunk_id, {
        chunk_id: r.chunk_id,
        document_id: r.document_id,
        document_url: r.document_url,
        document_title: r.document_title,
        source_name: r.source_name,
        breadcrumb: r.breadcrumb,
        text: r.text,
        parent_text: r.parent_text,
        vector_score: null,
        fts_score: r.fts_score,
        source_layer: "fts",
      });
    }
  }

  return Array.from(merged.values());
}

/**
 * Reciprocal Rank Fusion. Used as a fallback ranking when no reranker is
 * available. Higher is better. k=60 is the standard published default.
 *
 * Module 5: RRF is the boring-and-correct hybrid baseline. Tune later.
 */
export function rrfRank(candidates: Candidate[], k = 60): Candidate[] {
  // Compute per-source ranks
  const byVector = candidates
    .filter((c) => c.vector_score !== null)
    .slice()
    .sort((a, b) => (b.vector_score ?? 0) - (a.vector_score ?? 0));
  const byFts = candidates
    .filter((c) => c.fts_score !== null)
    .slice()
    .sort((a, b) => (b.fts_score ?? 0) - (a.fts_score ?? 0));

  const vectorRank = new Map(byVector.map((c, i) => [c.chunk_id, i + 1]));
  const ftsRank = new Map(byFts.map((c, i) => [c.chunk_id, i + 1]));

  const scored = candidates.map((c) => {
    const vr = vectorRank.get(c.chunk_id);
    const fr = ftsRank.get(c.chunk_id);
    const score =
      (vr !== undefined ? 1 / (k + vr) : 0) + (fr !== undefined ? 1 / (k + fr) : 0);
    return { c, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.c);
}
