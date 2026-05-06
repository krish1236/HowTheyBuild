/**
 * Citation extraction + validation.
 *
 * Module 6: ~2–5% of LLM answers cite hallucinated chunk ids even with good
 * prompts. Validation is non-negotiable. Any cited id that isn't in the
 * retrieved set is treated as a hallucination.
 *
 * Citation format: `[c<digits>]`. Examples: `[c42]`, `[c107]`. Multiple on
 * one claim are fine: `[c12][c45]`. We tolerate whitespace inside brackets
 * and inside multi-citation runs (`[c12] [c45]`).
 */

const CITATION_RE = /\[c(\d+)\]/g;

export interface CitationCheck {
  /** Distinct chunk_ids the LLM cited, in the order they first appeared. */
  cited: string[];
  /** Cited ids that exist in the retrieved set. */
  valid: string[];
  /** Cited ids that DO NOT exist in the retrieved set — hallucinated. */
  invalid: string[];
  /** Count of citation tokens in the text (not distinct). */
  total_citation_tokens: number;
}

export function extractCitations(text: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const m of text.matchAll(CITATION_RE)) {
    const id = m[1];
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered;
}

export function validateCitations(
  text: string,
  validIds: Set<string>,
): CitationCheck {
  const cited = extractCitations(text);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const id of cited) {
    if (validIds.has(id)) valid.push(id);
    else invalid.push(id);
  }
  let total = 0;
  for (const _ of text.matchAll(CITATION_RE)) total++;
  return { cited, valid, invalid, total_citation_tokens: total };
}
