/**
 * Health endpoint.
 *
 * Shallow (default): verifies the DB is reachable and that each external
 * provider has an API key set. Free, fast, safe to hit often.
 *
 * Deep (?deep=1): additionally calls each provider's free list-models
 * endpoint to confirm the key is valid and the network path works. Use
 * this from the bring-up smoke test, not from a load balancer probe.
 *
 * Per-component status is one of:
 *   "ok"          — passed the requested level of check
 *   "missing_key" — env var is unset
 *   "error: ..."  — call attempted and failed
 */
import { sql } from "@/lib/db/client";
import {
  isOpenAIConfigured,
  pingOpenAI,
} from "@/lib/clients/openai";
import {
  isAnthropicConfigured,
  pingAnthropic,
} from "@/lib/clients/anthropic";
import {
  isCohereConfigured,
  pingCohere,
} from "@/lib/clients/cohere";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Status = "ok" | "missing_key" | `error: ${string}`;

async function safe(label: string, fn: () => Promise<void>): Promise<Status> {
  try {
    await fn();
    return "ok";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `error: ${msg.slice(0, 120)}`;
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const deep = url.searchParams.get("deep") === "1";

  const db = await safe("db", async () => {
    await sql`SELECT 1`;
  });

  let embedder: Status = isOpenAIConfigured() ? "ok" : "missing_key";
  let llm: Status = isAnthropicConfigured() ? "ok" : "missing_key";
  let reranker: Status = isCohereConfigured() ? "ok" : "missing_key";

  if (deep) {
    if (embedder === "ok") embedder = await safe("embedder", pingOpenAI);
    if (llm === "ok") llm = await safe("llm", pingAnthropic);
    if (reranker === "ok") reranker = await safe("reranker", pingCohere);
  }

  const allOk = [db, embedder, llm, reranker].every((s) => s === "ok");

  return Response.json(
    { db, embedder, llm, reranker },
    {
      status: allOk ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
