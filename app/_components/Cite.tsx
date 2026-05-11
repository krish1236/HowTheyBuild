"use client";

/**
 * Inline citation chip used inside the streamed answer prose.
 *
 * Renders as `src · NN` where `src` is the source's short code
 * (e.g. "cf" for Cloudflare) and `NN` is the source's position in
 * the bibliography (1-indexed, zero-padded).
 *
 * On hover, a tooltip ribbon shows the document title and chunk id.
 */
import { useEffect, useState } from "react";

export interface CitationData {
  /** Display number in the bibliography (1-indexed). */
  n: number;
  /** Short source code, e.g. "cf", "stripe". */
  src: string;
  /** Full chunk identifier (e.g. our DB chunk id as a string). */
  chunk: string;
  /** Human-readable document title for the tooltip. */
  doc: string;
  /** URL to open when the chip is clicked. */
  url?: string;
}

interface CiteProps {
  c: CitationData;
  /** Stream-in delay in ms; 0 disables the entrance animation. */
  delay?: number;
  /** When false, render without animation (post-stream / SSR). */
  animate?: boolean;
}

export function Cite({ c, delay = 0, animate = true }: CiteProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const animating = animate && mounted;
  const style = animating
    ? {
        opacity: 0,
        animation: `tokIn 240ms var(--ease) forwards`,
        animationDelay: `${delay}ms`,
      }
    : undefined;
  const onClick = (e: React.MouseEvent) => {
    if (!c.url) {
      e.preventDefault();
    }
  };
  return (
    <a
      className="cite"
      href={c.url ?? "#"}
      target={c.url ? "_blank" : undefined}
      rel={c.url ? "noopener noreferrer" : undefined}
      onClick={onClick}
      style={style}
      aria-label={`source ${c.n}: ${c.src}, ${c.doc}`}
    >
      <span className="src">{c.src}</span>
      <span className="sep">·</span>
      <span className="n">{String(c.n).padStart(2, "0")}</span>
      <span className="cite__tip">
        <span className="doc">{c.doc}</span>
        <span className="ck">chunk {c.chunk}</span>
      </span>
    </a>
  );
}
