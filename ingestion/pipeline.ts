/**
 * Single-source ingestion pipeline.
 *
 *   RSS → parse → chunk → embed → index
 *
 * For every item: if content_hash matches what's already in the DB the
 * document is skipped (no parse, no embed, no DB write beyond bumping
 * last_seen_at). Re-running on unchanged content is a no-op.
 */
import { fetchRSS, type RSSItem } from "@/ingestion/connectors/rss";
import { parseHTML } from "@/ingestion/parser";
import { chunkDocument } from "@/ingestion/chunker";
import { embedTexts, getEmbedModel } from "@/lib/embeddings";
import {
  bumpLastSeen,
  ensureSource,
  findDocumentByUrl,
  indexDocument,
  type IndexResult,
} from "@/ingestion/indexer";
import { getSource } from "@/ingestion/sources";

export interface IngestOptions {
  sourceSlug: string;
  limit?: number;
  onItemDone?: (info: { url: string; result: IndexResult; chunks: number }) => void;
}

export interface IngestSummary {
  source: string;
  fetched: number;
  inserted: number;
  updated: number;
  skipped_unchanged: number;
  skipped_no_content: number;
  failed: number;
  total_chunks_indexed: number;
  total_embed_tokens: number;
  embed_cost_usd_est: number;
}

const COST_PER_MTOK_USD: Record<string, number> = {
  "text-embedding-3-small": 0.02,
  "text-embedding-3-large": 0.13,
};

export async function ingestSource(opts: IngestOptions): Promise<IngestSummary> {
  const source = getSource(opts.sourceSlug);
  if (!source.rss_url) {
    throw new Error(`Source ${opts.sourceSlug} has no rss_url`);
  }

  const summary: IngestSummary = {
    source: opts.sourceSlug,
    fetched: 0,
    inserted: 0,
    updated: 0,
    skipped_unchanged: 0,
    skipped_no_content: 0,
    failed: 0,
    total_chunks_indexed: 0,
    total_embed_tokens: 0,
    embed_cost_usd_est: 0,
  };

  console.log(`[${opts.sourceSlug}] fetching RSS...`);
  const items = await fetchRSS(source.rss_url);
  summary.fetched = items.length;
  console.log(`[${opts.sourceSlug}] feed has ${items.length} items`);

  const cap = opts.limit ?? items.length;
  const sourceId = await ensureSource(opts.sourceSlug, source);
  const embedModel = getEmbedModel();
  const embeddingModelId = `openai:${embedModel}:v1`;
  const costPerMTok = COST_PER_MTOK_USD[embedModel] ?? 0.02;

  for (let i = 0; i < Math.min(items.length, cap); i++) {
    const item: RSSItem = items[i];
    try {
      if (source.use_rss_content) {
        if (!item.content_html) {
          summary.skipped_no_content++;
          console.log(`[${i + 1}/${cap}] skip (no content): ${item.url}`);
          continue;
        }
      } else {
        // Phase 1 supports use_rss_content=true sources only; full HTML
        // fetcher arrives in Phase 6.
        throw new Error(
          `Source ${opts.sourceSlug}: use_rss_content=false not yet supported`,
        );
      }

      const parsed = parseHTML(item.content_html, item.url, {
        fallbackTitle: item.title,
        fallbackAuthor: item.author ?? undefined,
      });

      // Idempotency check BEFORE embedding. If we already have this doc with
      // the same content_hash, skip — no chunking, no API call, no DB write
      // beyond bumping last_seen_at. This is what makes re-runs free.
      const existing = await findDocumentByUrl(item.url);
      if (existing && existing.content_hash === parsed.content_hash) {
        await bumpLastSeen(existing.id);
        summary.skipped_unchanged++;
        console.log(
          `[${i + 1}/${cap}] ${"skipped_unchanged".padEnd(18)} chunks=-- ${item.url}`,
        );
        opts.onItemDone?.({ url: item.url, result: "skipped_unchanged", chunks: 0 });
        continue;
      }

      const chunks = chunkDocument({
        source_name: source.name,
        doc_title: parsed.title,
        cleaned_html: parsed.cleaned_html,
      });

      const inputs = chunks.map((c) => `${c.breadcrumb}\n\n${c.text}`);
      const embeddings = chunks.length > 0 ? await embedTexts(inputs) : [];
      const approxTokens = inputs.reduce(
        (acc, s) => acc + Math.ceil(s.length / 4),
        0,
      );

      const result = await indexDocument(
        {
          source_slug: opts.sourceSlug,
          source,
          url: item.url,
          title: parsed.title,
          author: parsed.author,
          source_published_at: item.source_published_at,
          content_hash: parsed.content_hash,
          raw_text: parsed.plain_text,
          embedding_model_id: embeddingModelId,
          chunks: chunks.map((c, idx) => ({
            chunk_position: c.position,
            breadcrumb: c.breadcrumb,
            text: c.text,
            parent_text: c.parent_text,
            token_count: c.token_count,
            embedding: embeddings[idx],
          })),
        },
        sourceId,
      );

      if (result === "inserted") summary.inserted++;
      else summary.updated++;
      summary.total_chunks_indexed += chunks.length;
      summary.total_embed_tokens += approxTokens;

      console.log(
        `[${i + 1}/${cap}] ${result.padEnd(18)} chunks=${chunks.length.toString().padStart(2)} ${item.url}`,
      );

      opts.onItemDone?.({ url: item.url, result, chunks: chunks.length });
    } catch (err) {
      summary.failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${i + 1}/${cap}] FAILED ${item.url}: ${msg.slice(0, 200)}`);
    }
  }

  summary.embed_cost_usd_est =
    (summary.total_embed_tokens / 1_000_000) * costPerMTok;

  return summary;
}
