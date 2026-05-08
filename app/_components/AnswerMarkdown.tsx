"use client";

import { Fragment, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CitationChip } from "@/app/_components/CitationChip";
import type { Citation } from "@/app/_lib/useQueryStream";

const CITATION_RE = /\[c(\d+)\]/g;

/**
 * Walk a children tree from react-markdown's text containers and replace
 * `[c<id>]` patterns inside string nodes with <CitationChip>. Non-string
 * children pass through untouched (so nested <strong>, <em>, <code> render
 * normally — citations only appear in plain text).
 */
function processText(node: ReactNode, citations: Map<string, Citation>): ReactNode {
  if (typeof node === "string") {
    if (!CITATION_RE.test(node)) return node;
    CITATION_RE.lastIndex = 0;
    const parts: ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CITATION_RE.exec(node)) !== null) {
      if (match.index > lastIndex) {
        parts.push(node.slice(lastIndex, match.index));
      }
      const id = match[1];
      parts.push(
        <CitationChip key={`${match.index}-${id}`} id={id} citation={citations.get(id)} />,
      );
      lastIndex = CITATION_RE.lastIndex;
    }
    if (lastIndex < node.length) parts.push(node.slice(lastIndex));
    return <>{parts.map((p, i) => (typeof p === "string" ? <Fragment key={i}>{p}</Fragment> : p))}</>;
  }

  if (Array.isArray(node)) {
    return node.map((child, i) => (
      <Fragment key={i}>{processText(child, citations)}</Fragment>
    ));
  }

  return node;
}

interface AnswerMarkdownProps {
  text: string;
  citations: Map<string, Citation>;
}

export function AnswerMarkdown({ text, citations }: AnswerMarkdownProps) {
  // We override the leaf containers (p, li, td, blockquote) where citations
  // live. Headings, code blocks, and tables don't typically host citations,
  // so we leave their default rendering alone.
  const components: Components = {
    p: ({ children, ...rest }) => (
      <p {...rest}>{processText(children, citations)}</p>
    ),
    li: ({ children, ...rest }) => (
      <li {...rest}>{processText(children, citations)}</li>
    ),
    td: ({ children, ...rest }) => (
      <td {...rest}>{processText(children, citations)}</td>
    ),
    blockquote: ({ children, ...rest }) => (
      <blockquote {...rest}>{processText(children, citations)}</blockquote>
    ),
    a: ({ children, ...rest }) => (
      <a {...rest} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ),
  };

  return (
    <div className="prose-answer">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
