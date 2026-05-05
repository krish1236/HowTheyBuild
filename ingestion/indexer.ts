/**
 * Transactional indexer.
 *
 * Atomically:
 *   1. Upserts the source row (by unique name).
 *   2. Inserts or updates the document row by url; if content_hash matches the
 *      existing row, the document is skipped entirely (chunks untouched).
 *   3. When content has changed: deletes all existing chunks for the doc and
 *      inserts the new chunks in a single statement (UNNEST'd values).
 *
 * The whole thing runs inside one transaction. A crash mid-way leaves the DB
 * unchanged; partial writes are not possible.
 */
import { sql as db } from "@/lib/db/client";
import type { SourceConfig } from "@/ingestion/sources";

export interface IndexableChunk {
  chunk_position: number;
  breadcrumb: string;
  text: string;
  parent_text: string;
  token_count: number;
  embedding: number[];
}

export interface IndexableDocument {
  source_slug: string;
  source: SourceConfig;
  url: string;
  title: string;
  author: string | null;
  source_published_at: Date | null;
  content_hash: string;
  raw_text: string;
  embedding_model_id: string;
  chunks: IndexableChunk[];
}

export type IndexResult = "inserted" | "updated" | "skipped_unchanged";

function vectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

/**
 * Look up an existing document by URL. Returns null if absent. Used by the
 * pipeline to skip parsing/chunking/embedding when content is unchanged.
 */
export async function findDocumentByUrl(
  url: string,
): Promise<{ id: string; content_hash: string } | null> {
  const rows = await db<{ id: string; content_hash: string }[]>`
    SELECT id::text AS id, content_hash FROM documents WHERE url = ${url}
  `;
  return rows[0] ?? null;
}

export async function bumpLastSeen(docId: string): Promise<void> {
  await db`UPDATE documents SET last_seen_at = now() WHERE id = ${docId}::bigint`;
}

export async function ensureSource(slug: string, source: SourceConfig): Promise<number> {
  const [row] = await db<{ id: number }[]>`
    INSERT INTO sources (name, base_url, source_type, rss_url, license_tag, contact_email)
    VALUES (
      ${source.name}, ${source.base_url}, ${source.source_type},
      ${source.rss_url ?? null}, ${source.license_tag}, ${source.contact_email}
    )
    ON CONFLICT (name) DO UPDATE SET
      base_url = EXCLUDED.base_url,
      source_type = EXCLUDED.source_type,
      rss_url = EXCLUDED.rss_url,
      license_tag = EXCLUDED.license_tag,
      contact_email = EXCLUDED.contact_email,
      last_synced_at = now()
    RETURNING id
  `;
  return row.id;
}

export async function indexDocument(
  doc: IndexableDocument,
  sourceId: number,
): Promise<IndexResult> {
  return await db.begin(async (tx) => {
    const existing = await tx<{ id: string; content_hash: string }[]>`
      SELECT id::text AS id, content_hash FROM documents WHERE url = ${doc.url}
    `;

    let docId: string;
    let result: IndexResult;

    if (existing.length > 0 && existing[0].content_hash === doc.content_hash) {
      // Unchanged — bump last_seen_at and stop.
      await tx`UPDATE documents SET last_seen_at = now() WHERE id = ${existing[0].id}::bigint`;
      return "skipped_unchanged" as IndexResult;
    }

    if (existing.length > 0) {
      docId = existing[0].id;
      await tx`
        UPDATE documents SET
          source_id = ${sourceId},
          title = ${doc.title},
          author = ${doc.author},
          source_published_at = ${doc.source_published_at},
          content_hash = ${doc.content_hash},
          raw_text = ${doc.raw_text},
          status = 'active',
          last_seen_at = now()
        WHERE id = ${docId}::bigint
      `;
      await tx`DELETE FROM chunks WHERE document_id = ${docId}::bigint`;
      result = "updated";
    } else {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO documents (
          source_id, url, title, author, source_published_at, content_hash, raw_text
        )
        VALUES (
          ${sourceId}, ${doc.url}, ${doc.title}, ${doc.author},
          ${doc.source_published_at}, ${doc.content_hash}, ${doc.raw_text}
        )
        RETURNING id::text AS id
      `;
      docId = row.id;
      result = "inserted";
    }

    if (doc.chunks.length > 0) {
      const positions = doc.chunks.map((c) => c.chunk_position);
      const breadcrumbs = doc.chunks.map((c) => c.breadcrumb);
      const texts = doc.chunks.map((c) => c.text);
      const parentTexts = doc.chunks.map((c) => c.parent_text);
      const tokenCounts = doc.chunks.map((c) => c.token_count);
      const embeddings = doc.chunks.map((c) => vectorLiteral(c.embedding));

      await tx`
        INSERT INTO chunks (
          document_id, chunk_position, breadcrumb, text, parent_text,
          token_count, embedding, embedding_model_id
        )
        SELECT
          ${docId}::bigint,
          p, b, t, pt, tc, e::vector, ${doc.embedding_model_id}
        FROM unnest(
          ${positions}::int[],
          ${breadcrumbs}::text[],
          ${texts}::text[],
          ${parentTexts}::text[],
          ${tokenCounts}::int[],
          ${embeddings}::text[]
        ) AS x(p, b, t, pt, tc, e)
      `;
    }

    return result;
  });
}
