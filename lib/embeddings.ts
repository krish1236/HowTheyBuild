/**
 * Embedding helper. Wraps the OpenAI SDK with:
 *   - batched calls (default 32 per request)
 *   - exponential-backoff retry on transient failures
 *   - explicit model_id sourcing from env, used by the chunk metadata tag
 *
 * Used at ingest time (many chunks) and at query time (one query). Same surface.
 */
import { createHash } from "node:crypto";
import { getOpenAI } from "@/lib/clients/openai";
import { getJSON, setJSON } from "@/lib/cache/redis";

const DEFAULT_BATCH_SIZE = 32;
const MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 500;
const QUERY_EMBED_TTL_S = 24 * 60 * 60; // 24h — Module 8

function normalizeForCacheKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function queryEmbedKey(text: string, model: string): string {
  const h = createHash("sha256").update(normalizeForCacheKey(text)).digest("hex").slice(0, 32);
  return `embed:v1:${model}:${h}`;
}

export function getEmbedModel(): string {
  return process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";
}

export interface EmbedOptions {
  model?: string;
  batchSize?: number;
  /** Enable query-embedding cache (single-text only). Default off. The
   *  ingestion path bypasses this; only query-time embeds opt in. */
  cache?: boolean;
}

/**
 * Embed a single query string with optional Redis-backed cache (24h TTL).
 * Returns `{ vector, hit }` so callers can log cache_hit metrics.
 */
export async function embedQueryWithCache(
  text: string,
  opts: { model?: string } = {},
): Promise<{ vector: number[]; hit: boolean; latency_ms: number }> {
  const t0 = Date.now();
  const model = opts.model ?? getEmbedModel();
  if (process.env.MOCK_EMBED === "1") {
    const [v] = await embedTexts([text], opts);
    return { vector: v, hit: false, latency_ms: Date.now() - t0 };
  }
  const key = queryEmbedKey(text, model);
  const cached = await getJSON<number[]>(key);
  if (cached) return { vector: cached, hit: true, latency_ms: Date.now() - t0 };

  const [v] = await embedTexts([text], opts);
  // Fire-and-forget store; don't make the caller wait on Redis write.
  void setJSON(key, v, QUERY_EMBED_TTL_S);
  return { vector: v, hit: false, latency_ms: Date.now() - t0 };
}

/**
 * Embed an array of texts. Preserves input order. Empty input returns [].
 *
 * Setting `MOCK_EMBED=1` returns deterministic fake 1536-dim vectors derived
 * from the input string (hash-seeded). Used for offline tests and CI runs
 * that should not depend on a live OpenAI API key. Real production runs
 * leave this unset.
 */
export async function embedTexts(
  texts: string[],
  opts: EmbedOptions = {},
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (process.env.MOCK_EMBED === "1") {
    return texts.map(mockEmbedding);
  }
  const model = opts.model ?? getEmbedModel();
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const client = getOpenAI();

  const results: number[][] = new Array(texts.length);
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const embeddings = await embedBatchWithRetry(client, model, batch);
    for (let j = 0; j < embeddings.length; j++) {
      results[i + j] = embeddings[j];
    }
  }
  return results;
}

/** Deterministic fake 1536-dim embedding for testing. NOT for production. */
function mockEmbedding(text: string): number[] {
  let seed = 2166136261; // FNV-1a offset basis
  for (let i = 0; i < text.length; i++) {
    seed ^= text.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }
  const out = new Array<number>(1536);
  let x = seed >>> 0;
  for (let i = 0; i < 1536; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = ((x / 0xffffffff) * 2 - 1) * 0.05;
  }
  return out;
}

async function embedBatchWithRetry(
  client: ReturnType<typeof getOpenAI>,
  model: string,
  batch: string[],
): Promise<number[][]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await client.embeddings.create({ input: batch, model });
      // OpenAI returns embeddings indexed; sort defensively in case order isn't preserved.
      return res.data
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_RETRIES) break;
      const delay = BASE_BACKOFF_MS * 2 ** attempt + Math.floor(Math.random() * 200);
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `embed retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms: ${msg.slice(0, 120)}`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
