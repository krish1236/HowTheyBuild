/**
 * Streaming generator with citation validation and pre-LLM refusal.
 *
 * Module 6 — generation pipeline:
 *   1. Pre-LLM refusal: if no chunks retrieved OR top score < threshold, return
 *      a refusal without calling the LLM (cost = $0).
 *   2. Stream answer with system + user prompt assembled per Module 6.
 *   3. After stream completes, validate every cited chunk_id against the
 *      retrieved set.
 *   4. If any citation is hallucinated, retry ONCE with a stricter system
 *      prompt suffix. If retry also fails, return refusal.
 *
 * Streaming exposes per-token callbacks so the CLI / API can stream to stdout
 * or SSE. The generator buffers the full text internally for validation.
 */
import { getAnthropic } from "@/lib/clients/anthropic";
import {
  assemblePrompt,
  STRICT_RETRY_SUFFIX,
  type AssembledPrompt,
} from "@/lib/rag/prompt";
import { validateCitations } from "@/lib/rag/citations";
import type { Candidate } from "@/lib/rag/retrieval";

export interface GenerateOptions {
  query: string;
  candidates: Candidate[];
  /** Top-K to send to the LLM. Module 6 sweet spot: 8–10. Default 8. */
  topK?: number;
  /** Pre-LLM refusal threshold on top rerank score (or vector if no rerank). */
  refusalThreshold?: number;
  /** Streaming callback. Called with each text delta. */
  onToken?: (delta: string) => void;
  /** Hard timeout for the whole generation (incl. retry). Default 30s. */
  timeoutMs?: number;
}

export type GenerateResult =
  | {
      type: "answer";
      text: string;
      cited_chunk_ids: string[];
      retried: boolean;
      usage: Usage;
      ttft_ms: number | null;
      total_ms: number;
    }
  | {
      type: "refused";
      reason: "no_candidates" | "low_confidence" | "invalid_citations_after_retry";
      message: string;
      usage: Usage;
      total_ms: number;
    };

export interface Usage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

const ZERO_USAGE: Usage = {
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
  cost_usd: 0,
};

// Approximate early-2026 Anthropic pricing in USD per 1M tokens. Verify
// against the live pricing page before relying on absolute numbers.
const PRICING_PER_MTOK: Record<
  string,
  { input: number; cache_write: number; cache_read: number; output: number }
> = {
  "claude-sonnet-4-5-20250929": { input: 3, cache_write: 3.75, cache_read: 0.3, output: 15 },
  "claude-haiku-4-5-20251001": { input: 1, cache_write: 1.25, cache_read: 0.1, output: 5 },
};

function priceUsage(model: string, u: Omit<Usage, "cost_usd">): number {
  const p = PRICING_PER_MTOK[model] ?? PRICING_PER_MTOK["claude-sonnet-4-5-20250929"];
  return (
    (u.input_tokens * p.input +
      u.cache_creation_input_tokens * p.cache_write +
      u.cache_read_input_tokens * p.cache_read +
      u.output_tokens * p.output) /
    1_000_000
  );
}

function topScore(candidates: Candidate[]): number {
  let max = -Infinity;
  for (const c of candidates) {
    const s =
      (c as Candidate & { rerank_score?: number | null }).rerank_score ??
      c.vector_score ??
      0;
    if (s > max) max = s;
  }
  return max === -Infinity ? 0 : max;
}

export async function generate(opts: GenerateOptions): Promise<GenerateResult> {
  const {
    query,
    candidates,
    topK = 8,
    refusalThreshold = 0.3,
    onToken,
    timeoutMs = 30_000,
  } = opts;
  const t0 = Date.now();

  // Pre-LLM refusal: no chunks
  if (candidates.length === 0) {
    return {
      type: "refused",
      reason: "no_candidates",
      message:
        "I don't have a confident answer in the provided sources. Try rephrasing the question.",
      usage: { ...ZERO_USAGE },
      total_ms: Date.now() - t0,
    };
  }

  // Pre-LLM refusal: confidence floor
  const top = topScore(candidates);
  if (top < refusalThreshold) {
    return {
      type: "refused",
      reason: "low_confidence",
      message: `I don't have a confident answer in the provided sources (top score ${top.toFixed(2)} < threshold ${refusalThreshold}).`,
      usage: { ...ZERO_USAGE },
      total_ms: Date.now() - t0,
    };
  }

  const trimmed = candidates.slice(0, topK);
  const prompt = assemblePrompt({ query, candidates: trimmed });

  // First attempt
  const first = await callLLM(prompt, query, false, onToken, timeoutMs);
  let validation = validateCitations(first.text, prompt.cited_chunk_ids);

  if (validation.invalid.length === 0) {
    return {
      type: "answer",
      text: first.text,
      cited_chunk_ids: validation.valid,
      retried: false,
      usage: first.usage,
      ttft_ms: first.ttft_ms,
      total_ms: Date.now() - t0,
    };
  }

  // Retry once with stricter citation rules. Stream is replaced; consumer is
  // notified via onToken with a marker so the CLI can show a "retrying" hint.
  onToken?.("\n\n[invalid citation detected — retrying]\n\n");
  const retry = await callLLM(prompt, query, true, onToken, timeoutMs);
  validation = validateCitations(retry.text, prompt.cited_chunk_ids);

  const combinedUsage: Usage = {
    input_tokens: first.usage.input_tokens + retry.usage.input_tokens,
    cache_creation_input_tokens:
      first.usage.cache_creation_input_tokens + retry.usage.cache_creation_input_tokens,
    cache_read_input_tokens:
      first.usage.cache_read_input_tokens + retry.usage.cache_read_input_tokens,
    output_tokens: first.usage.output_tokens + retry.usage.output_tokens,
    cost_usd: first.usage.cost_usd + retry.usage.cost_usd,
  };

  if (validation.invalid.length === 0) {
    return {
      type: "answer",
      text: retry.text,
      cited_chunk_ids: validation.valid,
      retried: true,
      usage: combinedUsage,
      ttft_ms: retry.ttft_ms,
      total_ms: Date.now() - t0,
    };
  }

  return {
    type: "refused",
    reason: "invalid_citations_after_retry",
    message:
      "I drafted an answer but couldn't ground it in the provided sources cleanly. Try rephrasing the question.",
    usage: combinedUsage,
    total_ms: Date.now() - t0,
  };
}

interface LLMCallResult {
  text: string;
  usage: Usage;
  ttft_ms: number | null;
}

async function callLLM(
  prompt: AssembledPrompt,
  _query: string,
  strict: boolean,
  onToken: ((delta: string) => void) | undefined,
  timeoutMs: number,
): Promise<LLMCallResult> {
  const client = getAnthropic();
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const tStart = Date.now();
  let ttft_ms: number | null = null;
  let buffer = "";

  try {
    const stream = client.messages.stream(
      {
        model,
        max_tokens: 800,
        temperature: 0.2,
        system: strict ? prompt.system + STRICT_RETRY_SUFFIX : prompt.system,
        messages: [{ role: "user", content: prompt.user_message }],
      },
      { signal: controller.signal },
    );

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        if (ttft_ms === null) ttft_ms = Date.now() - tStart;
        buffer += event.delta.text;
        onToken?.(event.delta.text);
      }
    }

    const final = await stream.finalMessage();
    const u: Omit<Usage, "cost_usd"> = {
      input_tokens: final.usage.input_tokens ?? 0,
      cache_creation_input_tokens: final.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: final.usage.cache_read_input_tokens ?? 0,
      output_tokens: final.usage.output_tokens ?? 0,
    };
    const cost_usd = priceUsage(model, u);

    return {
      text: buffer.trim(),
      usage: { ...u, cost_usd },
      ttft_ms,
    };
  } finally {
    clearTimeout(timer);
  }
}
