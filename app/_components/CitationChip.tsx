"use client";

import type { Citation } from "@/app/_lib/useQueryStream";

interface CitationChipProps {
  id: string;
  citation: Citation | undefined;
}

/**
 * Inline citation badge.
 *
 *   - Resolved: small clickable pill linking to the source URL in a new tab.
 *     Hover reveals source name + document title via title attribute.
 *   - Unresolved: muted placeholder while citation metadata hasn't arrived
 *     yet (citation events fire after token events for the same id).
 */
export function CitationChip({ id, citation }: CitationChipProps) {
  if (!citation) {
    return (
      <span
        className="inline-flex items-center align-baseline mx-0.5 px-1.5 py-0.5 text-[0.7rem] font-mono rounded bg-neutral-200 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-500"
        aria-label={`Citation c${id} (loading source)`}
      >
        c{id}
      </span>
    );
  }
  return (
    <a
      href={citation.document_url}
      target="_blank"
      rel="noopener noreferrer"
      title={`${citation.source_name} — ${citation.document_title}`}
      className="inline-flex items-center align-baseline mx-0.5 px-1.5 py-0.5 text-[0.7rem] font-mono rounded bg-blue-100 text-blue-800 hover:bg-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:hover:bg-blue-900/70 transition-colors no-underline"
      aria-label={`Source c${id}: ${citation.source_name} — ${citation.document_title}. Opens in new tab.`}
    >
      c{id}
    </a>
  );
}
