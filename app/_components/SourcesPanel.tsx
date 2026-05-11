"use client";

/**
 * Bibliography panel shown below a streamed answer. Each entry mirrors
 * what we cite inline as `src · NN`, with the full doc title, URL,
 * chunk id, and rerank score.
 */
import type { Citation } from "@/app/_lib/useQueryStream";
import { sourceShortCode } from "@/app/_lib/sources";

export interface SourceEntry {
  /** 1-indexed bibliography number; matches the `n` on inline chips. */
  n: number;
  citation: Citation;
  /** Rerank score in [0,1]; null when not available. */
  score: number | null;
}

interface SourcesPanelProps {
  entries: SourceEntry[];
  /** Optional rerank floor used to decide what was kept; default 0.40. */
  floor?: number;
}

export function SourcesPanel({ entries, floor = 0.4 }: SourcesPanelProps) {
  if (entries.length === 0) return null;
  return (
    <section className="sources">
      <div className="sources__hd">
        <span className="title">SOURCES · BIBLIOGRAPHY</span>
        <span className="meta">
          <span>
            <b>{entries.length}</b> entries
          </span>
          <span>
            floor <b>{floor.toFixed(2)}</b>
          </span>
          <span>
            sort: <b>rerank desc</b>
          </span>
        </span>
      </div>
      {entries.map((entry) => {
        const c = entry.citation;
        const score = entry.score ?? 0;
        const pipCount = Math.max(0, Math.min(10, Math.round(score * 10)));
        const orgShort = sourceShortCode(c.source_name);
        const hostPath = c.document_url
          .replace(/^https?:\/\//, "")
          .replace(/\/$/, "");
        return (
          <div key={entry.n} className="src">
            <div className="src__no">
              [{String(entry.n).padStart(2, "0")}]
              <span className="chunk">{orgShort}-{c.chunk_id}</span>
            </div>
            <div className="src__body">
              <span className="org">{c.source_name.toUpperCase()}</span>
              <span className="doc">{c.document_title}</span>
              <a
                className="url"
                href={c.document_url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {hostPath}
              </a>
            </div>
            <div className="src__tags">
              {/* No tags yet — placeholder slots reserved for Phase 6b metadata. */}
            </div>
            <div className="src__score">
              <span>{entry.score != null ? entry.score.toFixed(2) : "—"}</span>
              <span className="pips">
                {Array.from({ length: 10 }).map((_, j) => (
                  <span key={j} className={"pip " + (j < pipCount ? "on" : "")} />
                ))}
              </span>
              <span className="label">RERANK</span>
            </div>
          </div>
        );
      })}
    </section>
  );
}
