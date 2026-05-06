/**
 * Prompt assembly for the generation step.
 *
 * Module 6 — five-part prompt structure:
 *   1. SYSTEM INSTRUCTIONS — role, grounding, citation format, refusal policy
 *   2. CONTEXT METADATA    — current_date, query intent (V1: just date)
 *   3. KNOWLEDGE_BASE      — retrieved chunks with parent_text (small-to-big)
 *   4. CONVERSATION HISTORY — empty in V1 (single-shot Q&A)
 *   5. USER QUESTION
 *
 * Small-to-big at generation time: each KNOWLEDGE_BASE entry uses parent_text
 * (the full section, ~1–2K tokens) when available, falling back to chunk text
 * for short docs. Chunks from the same parent section are deduplicated and
 * cited under one chunk_id (the first seen).
 *
 * Citation format is `[c<chunk_id>]`. The `c` prefix avoids collisions with
 * footnote / list markers if the model hallucinates one.
 */
import type { Candidate } from "@/lib/rag/retrieval";

export interface PromptInputs {
  query: string;
  candidates: Candidate[];
  /** Caller has already trimmed to top-K. We just format. */
}

export interface AssembledPrompt {
  system: string;
  user_message: string;
  /** Set of valid chunk_id strings the LLM is allowed to cite. */
  cited_chunk_ids: Set<string>;
  /** Maps each citable chunk_id to the candidate it belongs to (for the citation list at the end). */
  citation_index: Map<string, Candidate>;
  /** Approximate input token count (chars/4). Sanity check, not exact. */
  approx_input_tokens: number;
}

export const SYSTEM_PROMPT = `You are a research assistant for software engineers. You answer questions using ONLY the provided KNOWLEDGE_BASE.

GROUNDING (strict):
- Use ONLY information present in the KNOWLEDGE_BASE entries below.
- Do NOT use prior knowledge. Do NOT invent facts, names, version numbers, or quotes.
- If the KNOWLEDGE_BASE does not contain a confident answer, respond exactly: "I don't have a confident answer in the provided sources." Then briefly state what is missing.

CITATIONS (mandatory):
- Every factual claim ends with an inline citation in the form [c<id>], where <id> is the chunk id from the KNOWLEDGE_BASE.
- Multiple citations on one claim are fine: "X works this way [c12][c45]."
- Cite the specific entry that supports the claim, not a general reference.
- Do NOT invent chunk ids. If you cannot support a claim with a chunk, drop the claim.

STYLE:
- Concise. 2–4 short paragraphs maximum. Use bullets only for sequential steps or comparisons.
- Match the user's language.
- Do not narrate ("In this answer I will..."). Just answer.

OUT OF SCOPE:
- If the question is unrelated to software engineering, infrastructure, or systems, refuse politely and stop.`;

export const STRICT_RETRY_SUFFIX = `

CITATION RETRY: Your previous answer included a chunk id that does not exist in the KNOWLEDGE_BASE. Re-answer using ONLY chunk ids actually present below. Drop any claim you cannot support.`;

const KB_HEADER =
  "KNOWLEDGE_BASE — answer using ONLY these entries. Each entry is preceded by [c<id> | source | title | section].";

/**
 * Group candidates by parent_text so the same section isn't sent multiple
 * times when adjacent chunks are retrieved. Preserves rerank order: the
 * first occurrence of a parent is kept; later duplicates are dropped.
 *
 * Trade-off: collapsing chunks under one chunk_id means the LLM only
 * cites the first chunk per section. That's fine — the section is the
 * unit of provenance the user can verify.
 */
function dedupeByParent(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of candidates) {
    const key = c.parent_text ?? c.text;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function extractSection(breadcrumb: string): string {
  const m = /Section: ([^\]]+)\]?/.exec(breadcrumb);
  return m ? m[1].trim() : "(no section)";
}

export function assemblePrompt(inputs: PromptInputs): AssembledPrompt {
  const today = new Date().toISOString().slice(0, 10);

  const deduped = dedupeByParent(inputs.candidates);
  const cited_chunk_ids = new Set<string>();
  const citation_index = new Map<string, Candidate>();

  const kbEntries = deduped.map((c) => {
    cited_chunk_ids.add(c.chunk_id);
    citation_index.set(c.chunk_id, c);
    const section = extractSection(c.breadcrumb);
    const body = c.parent_text ?? c.text;
    return `[c${c.chunk_id} | ${c.source_name} | ${c.document_title} | ${section}]
${body}`;
  });

  const knowledgeBase = kbEntries.join("\n\n---\n\n");

  const user_message =
    `Today is ${today}.\n\n` +
    `${KB_HEADER}\n\n` +
    `${knowledgeBase}\n\n` +
    `QUESTION: ${inputs.query.trim()}`;

  const approx_input_tokens =
    approxTokens(SYSTEM_PROMPT) + approxTokens(user_message);

  return {
    system: SYSTEM_PROMPT,
    user_message,
    cited_chunk_ids,
    citation_index,
    approx_input_tokens,
  };
}
