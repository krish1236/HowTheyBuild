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
  /** Per-source: how many items to parse/embed/index in parallel. Default 3.
   * Embedding API rate limits + politeness toward source servers cap this low. */
  concurrency?: number;
  onItemDone?: (info: { url: string; result: IndexResult; chunks: number }) => void;
}

export interface IngestFailure {
  source: string;
  url: string;
  reason: string;
  at: string;
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
  failures: IngestFailure[];
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
    failures: [],
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

  const queue = items.slice(0, cap);
  const concurrency = Math.max(1, opts.concurrency ?? 3);

  // Shared mutable counters; we update them inside workers under the
  // single-threaded JS event loop, so no locking is needed.
  let completed = 0;

  async function processItem(item: RSSItem, indexInQueue: number) {
    const tag = `[${opts.sourceSlug} ${indexInQueue + 1}/${queue.length}]`;
    try {
      if (!source.use_rss_content) {
        throw new Error(`use_rss_content=false not yet supported in this connector`);
      }
      if (!item.content_html) {
        summary.skipped_no_content++;
        console.log(`${tag} skip (no content) ${item.url}`);
        return;
      }

      const parsed = parseHTML(item.content_html, item.url, {
        fallbackTitle: item.title,
        fallbackAuthor: item.author ?? undefined,
      });

      // Idempotency check BEFORE embedding. Re-running on unchanged content
      // costs zero API tokens.
      const existing = await findDocumentByUrl(item.url);
      if (existing && existing.content_hash === parsed.content_hash) {
        await bumpLastSeen(existing.id);
        summary.skipped_unchanged++;
        console.log(`${tag} skipped_unchanged ${item.url}`);
        opts.onItemDone?.({ url: item.url, result: "skipped_unchanged", chunks: 0 });
        return;
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

      console.log(`${tag} ${result.padEnd(10)} chunks=${chunks.length} ${item.url}`);
      opts.onItemDone?.({ url: item.url, result, chunks: chunks.length });
    } catch (err) {
      summary.failed++;
      const msg = err instanceof Error ? err.message : String(err);
      summary.failures.push({
        source: opts.sourceSlug,
        url: item.url,
        reason: msg.slice(0, 300),
        at: new Date().toISOString(),
      });
      console.error(`${tag} FAILED ${item.url}: ${msg.slice(0, 160)}`);
    } finally {
      completed++;
    }
  }

  // Simple cursor-based parallel workers — no extra dep needed.
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= queue.length) return;
      await processItem(queue[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, worker),
  );
  void completed; // keep variable for future progress hooks

  summary.embed_cost_usd_est =
    (summary.total_embed_tokens / 1_000_000) * costPerMTok;

  return summary;
}
