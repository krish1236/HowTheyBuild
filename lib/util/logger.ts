/**
 * Append-only structured request logger.
 *
 * Writes one JSON line per request to `logs/queries.jsonl`. Phase 9 will pipe
 * this to Axiom; for now it's a local file we can `tail -f` for debugging.
 *
 * Failures here are swallowed — logging must NEVER break the user-facing
 * request, only ever degrade observability.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const LOG_DIR = join(process.cwd(), "logs");
const LOG_FILE = join(LOG_DIR, "queries.jsonl");

let dirReady = false;

async function ensureDir(): Promise<void> {
  if (dirReady) return;
  try {
    await mkdir(LOG_DIR, { recursive: true });
    dirReady = true;
  } catch {
    /* ignore */
  }
}

export interface RequestLogLine {
  ts: string;
  client_ip_hash: string;
  query: string;
  rewritten_query: string | null;
  retrieved: number;
  reranked: number;
  top_rerank_score: number | null;
  cache_hit: boolean;
  refused: boolean;
  refusal_reason: string | null;
  llm_model: string;
  input_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  cost_usd: number;
  total_ms: number;
  ttft_ms: number | null;
  error_code?: string | null;
}

export async function logRequest(line: RequestLogLine): Promise<void> {
  try {
    await ensureDir();
    await appendFile(LOG_FILE, JSON.stringify(line) + "\n");
  } catch {
    /* logging failures must never propagate */
  }
}
