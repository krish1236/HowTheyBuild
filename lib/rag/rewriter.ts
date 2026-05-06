/**
 * Query rewriter. A small fast LLM (Haiku) reformulates a terse user query
 * into a search-optimized full sentence before embedding.
 *
 * Module 5 / "Query understanding": small LLM rewriting is the easiest 5–10%
 * retrieval improvement. Always-on, cheap, cached. ~50–200ms latency.
 *
 * Behavior:
 *   • If `ANTHROPIC_API_KEY` is missing, returns the original query unchanged
 *     (graceful degradation per Module 8).
 *   • Preserves technical terms exactly (acronyms, error codes, identifiers).
 *   • Returns the rewritten query AND the original; callers usually use the
 *     rewrite for retrieval and pass the original to the LLM at generation
 *     time so the user's intent isn't paraphrased away.
 */
import { getAnthropic, isAnthropicConfigured } from "@/lib/clients/anthropic";

const SYSTEM_PROMPT = `You rewrite developer questions into search-optimized full sentences for a semantic-search system over engineering blog posts and postmortems.

Rules:
- Output exactly ONE sentence, the rewritten query.
- Keep all technical terms verbatim (acronyms, product names, error codes, code identifiers, version numbers).
- Expand vague references ("it", "this", "the issue") only when context makes them obvious.
- Do NOT add new technical terms the user didn't imply.
- Do NOT explain. Do NOT prefix with "Search query:". Just the sentence.
- If the user's query is already a full, well-formed search question, return it unchanged.`;

export interface RewriteResult {
  /** The user's original query, unchanged. */
  original: string;
  /** The rewritten query, or the original if rewrite was skipped. */
  rewritten: string;
  /** Whether a rewrite actually happened. False = skipped (no key, error, or unchanged). */
  rewritten_by_llm: boolean;
  /** Wall-clock latency of the rewrite call. 0 if skipped. */
  latency_ms: number;
}

const REWRITER_MODEL = process.env.ANTHROPIC_MODEL_FAST || "claude-haiku-4-5-20251001";
const MAX_OUTPUT_TOKENS = 120;
const TIMEOUT_MS = 5_000;

export async function rewriteQuery(query: string): Promise<RewriteResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { original: query, rewritten: query, rewritten_by_llm: false, latency_ms: 0 };
  }

  if (!isAnthropicConfigured()) {
    return {
      original: trimmed,
      rewritten: trimmed,
      rewritten_by_llm: false,
      latency_ms: 0,
    };
  }

  const client = getAnthropic();
  const t0 = Date.now();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await client.messages.create(
      {
        model: REWRITER_MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: trimmed }],
      },
      { signal: controller.signal },
    );

    clearTimeout(timer);

    const textBlock = res.content.find((b) => b.type === "text");
    const rewritten = textBlock && "text" in textBlock ? textBlock.text.trim() : "";

    if (!rewritten || rewritten === trimmed) {
      return {
        original: trimmed,
        rewritten: trimmed,
        rewritten_by_llm: false,
        latency_ms: Date.now() - t0,
      };
    }

    return {
      original: trimmed,
      rewritten,
      rewritten_by_llm: true,
      latency_ms: Date.now() - t0,
    };
  } catch (err) {
    // Fail-open: if the rewriter errors, fall back to the original query.
    // This keeps retrieval working even if Anthropic is degraded.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`rewriter failed (using original): ${msg.slice(0, 120)}`);
    return {
      original: trimmed,
      rewritten: trimmed,
      rewritten_by_llm: false,
      latency_ms: Date.now() - t0,
    };
  }
}
