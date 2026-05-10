/**
 * POST /api/query — streaming RAG endpoint.
 *
 * Body:    { "query": "..." }
 * Response: text/event-stream with events:
 *   - meta:     { rewritten_query, retrieved, reranked, top_rerank_score }
 *   - token:    { text }
 *   - citation: { chunk_id, source_name, document_title, document_url, breadcrumb }
 *   - done:     { ttft_ms, total_ms, cost_usd, refused, refusal_reason }
 *   - error:    { code, message }
 *
 * Behavior:
 *   - One row appended to `queries` per request, whether answered or refused.
 *   - Client disconnect → AbortSignal cancels the LLM call (Module 6/8: don't
 *     pay for tokens nobody reads).
 *   - All errors return structured JSON via the error event; never leak stack
 *     traces, env values, or vendor responses to the client.
 *
 * Runs on the Node runtime (postgres + vendor SDKs need it). Force-dynamic so
 * Next.js never tries to cache this route.
 */
import { hybridRetrieve, rrfRank, type Candidate } from "@/lib/rag/retrieval";
import { rewriteQuery } from "@/lib/rag/rewriter";
import { rerank } from "@/lib/rag/rerank";
import { generate, type GenerateResult } from "@/lib/rag/generator";
import { getCachedAnswer, storeCachedAnswer, type CachedAnswer } from "@/lib/rag/answer_cache";
import { insertQueryLog } from "@/lib/db/queries";
import { clientIpFromHeaders, hashIp } from "@/lib/util/hash";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_QUERY_CHARS = 1000;
const TOP_K = 8;
const REFUSAL_THRESHOLD = 0.3;

interface RequestBody {
  query?: unknown;
}

function badRequest(code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request): Promise<Response> {
  // 1. Parse + validate body
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return badRequest("invalid_json", "Request body must be valid JSON.");
  }
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) {
    return badRequest("missing_query", 'Body must include a "query" string.');
  }
  if (query.length > MAX_QUERY_CHARS) {
    return badRequest(
      "query_too_long",
      `Query length is ${query.length}; max is ${MAX_QUERY_CHARS}.`,
    );
  }

  // 2. Identify client (privacy: only the hash is ever stored)
  let clientIpHash: string;
  try {
    clientIpHash = hashIp(clientIpFromHeaders(req.headers));
  } catch (err) {
    // IP_HASH_SECRET not set — refuse to serve. We MUST hash before logging.
    return Response.json(
      { error: { code: "server_misconfigured", message: "Service is not configured." } },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  // 3. Build SSE stream
  const encoder = new TextEncoder();
  const t0 = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      // State we accumulate across the pipeline so we can persist a single
      // queries-table row at the end.
      let rewritten: string | null = null;
      let retrievedIds: number[] = [];
      let rerankedIds: number[] = [];
      let topRerankScore: number | null = null;
      let model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";
      let result: GenerateResult | null = null;
      let errored: { code: string; message: string } | null = null;
      let cacheHit = false;

      try {
        // 3a. Rewrite (may pass through on out-of-scope or unchanged queries)
        const rw = await rewriteQuery(query);
        rewritten = rw.rewritten_by_llm ? rw.rewritten : null;

        // 3a.5 Answer-cache lookup keyed by the rewritten (canonical) query.
        // On hit, replay meta + token + citation + done events without
        // running retrieval, rerank, or generation. Cost = $0.
        const cached = await getCachedAnswer(rw.rewritten);
        if (cached) {
          cacheHit = true;
          retrievedIds = cached.retrieved_chunk_ids.map((s) => Number(s)).filter(Number.isFinite);
          rerankedIds = cached.reranked_chunk_ids.map((s) => Number(s)).filter(Number.isFinite);
          topRerankScore = cached.top_rerank_score;
          send("meta", {
            rewritten_query: rewritten,
            retrieved: retrievedIds.length,
            reranked: rerankedIds.length,
            top_rerank_score: topRerankScore,
            cache_hit: true,
          });
          // Stream the cached answer in a few chunks so the UI animates.
          const STEP = 200;
          for (let i = 0; i < cached.answer.length; i += STEP) {
            send("token", { text: cached.answer.slice(i, i + STEP) });
          }
          for (const c of cached.citations) send("citation", c);
          send("done", {
            status: "answer",
            refused: false,
            refusal_reason: null,
            ttft_ms: 0,
            total_ms: Date.now() - t0,
            cost_usd: 0,
            cache_hit: true,
          });
          // Synthesize a result-shaped object so the queries-table writer
          // below records the same fields as a fresh-generate path.
          result = {
            type: "answer",
            text: cached.answer,
            cited_chunk_ids: cached.cited_chunk_ids,
            retried: false,
            usage: {
              input_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: 0,
              cost_usd: 0,
            },
            ttft_ms: 0,
            total_ms: Date.now() - t0,
          };
          // jump to finally{} via early return-from-try
          return;
        }

        // 3b. Hybrid retrieval
        const candidates = await hybridRetrieve(rw.rewritten);
        retrievedIds = candidates.map((c) => Number(c.chunk_id)).filter((n) => Number.isFinite(n));

        // 3c. Rerank (or RRF fallback) → top-K
        let ranked: Candidate[];
        if (process.env.COHERE_API_KEY) {
          const rr = await rerank(rw.rewritten, candidates, { topK: TOP_K });
          if (rr.reranked) {
            ranked = rr.candidates;
            topRerankScore = rr.candidates[0]?.rerank_score ?? null;
          } else {
            ranked = rrfRank(candidates).slice(0, TOP_K);
          }
        } else {
          ranked = rrfRank(candidates).slice(0, TOP_K);
        }
        rerankedIds = ranked.map((c) => Number(c.chunk_id)).filter((n) => Number.isFinite(n));

        send("meta", {
          rewritten_query: rewritten,
          retrieved: retrievedIds.length,
          reranked: rerankedIds.length,
          top_rerank_score: topRerankScore,
        });

        // 3d. Generate (streamed). Pre-LLM refusal lives inside generate().
        result = await generate({
          query,
          candidates: ranked,
          topK: TOP_K,
          refusalThreshold: REFUSAL_THRESHOLD,
          abortSignal: req.signal,
          onToken: (text) => send("token", { text }),
        });

        // 3e. Citation events (only on answered)
        if (result.type === "answer") {
          for (const id of result.cited_chunk_ids) {
            const c = ranked.find((x) => x.chunk_id === id);
            if (!c) continue;
            send("citation", {
              chunk_id: id,
              source_name: c.source_name,
              document_title: c.document_title,
              document_url: c.document_url,
              breadcrumb: c.breadcrumb,
            });
          }
        }

        // 3f. Done
        send("done", {
          status: result.type,
          refused: result.type === "refused",
          refusal_reason: result.type === "refused" ? result.reason : null,
          ttft_ms: result.type === "answer" ? result.ttft_ms : null,
          total_ms: Date.now() - t0,
          cost_usd: result.usage.cost_usd,
          cache_hit: false,
        });

        // 3g. Populate the answer cache on a fresh successful answer. Only
        // cache non-retried, non-refused answers — retries are weak signal,
        // refusals shouldn't be served as "the answer" on a future call.
        if (result.type === "answer" && !result.retried) {
          const payload: CachedAnswer = {
            answer: result.text,
            cited_chunk_ids: result.cited_chunk_ids,
            citations: result.cited_chunk_ids
              .map((id) => ranked.find((x) => x.chunk_id === id))
              .filter((c): c is Candidate => Boolean(c))
              .map((c) => ({
                chunk_id: c.chunk_id,
                source_name: c.source_name,
                document_title: c.document_title,
                document_url: c.document_url,
                breadcrumb: c.breadcrumb,
              })),
            cost_usd: result.usage.cost_usd,
            reranked_chunk_ids: ranked.map((c) => c.chunk_id),
            retrieved_chunk_ids: candidates.map((c) => c.chunk_id),
            top_rerank_score: topRerankScore,
            generated_at: new Date().toISOString(),
          };
          // Fire-and-forget: don't block stream close on Redis write.
          void storeCachedAnswer(rw.rewritten, payload);
        }
      } catch (err) {
        // Distinguish client-cancellation (expected, common) from real errors.
        const isAbort =
          (err instanceof Error && err.name === "AbortError") ||
          (err as { name?: string })?.name === "APIUserAbortError" ||
          req.signal.aborted;
        if (isAbort) {
          errored = { code: "client_aborted", message: "Client closed the connection." };
          // Don't spam stderr with stack traces for normal disconnects.
        } else {
          const message = err instanceof Error ? err.message : "internal error";
          errored = { code: "internal_error", message: message.slice(0, 200) };
          console.error("query route error:", err);
        }
        // Best-effort send; if the connection is already gone the enqueue is a no-op.
        try { send("error", errored); } catch {}
      } finally {
        // Persist the audit row in all cases (answer / refused / error /
        // client-aborted). Don't let log failure block stream close.
        try {
          await insertQueryLog({
            client_ip_hash: clientIpHash,
            query_text: query,
            rewritten_query: rewritten,
            retrieved_chunk_ids: retrievedIds,
            reranked_chunk_ids: rerankedIds,
            top_rerank_score: topRerankScore,
            refused: errored !== null || (result?.type === "refused"),
            refusal_reason:
              errored?.code ??
              (result?.type === "refused" ? result.reason : null),
            llm_model: model,
            llm_input_tokens: result?.usage.input_tokens ?? 0,
            llm_input_tokens_cached: result?.usage.cache_read_input_tokens ?? 0,
            llm_output_tokens: result?.usage.output_tokens ?? 0,
            total_cost_usd: result?.usage.cost_usd ?? 0,
            total_latency_ms: Date.now() - t0,
            ttft_ms:
              result?.type === "answer" ? result.ttft_ms ?? null : null,
            cache_hit: cacheHit,
          });
        } catch (logErr) {
          console.error("insertQueryLog failed:", logErr);
        }
        controller.close();
      }
    },
    cancel() {
      // Client disconnected mid-stream. The req.signal AbortSignal we passed
      // to generate() has already fired; nothing else to do here.
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
