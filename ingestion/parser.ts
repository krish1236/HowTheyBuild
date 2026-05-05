/**
 * HTML parser. Takes raw HTML (full page or article fragment) and returns a
 * cleaned, structure-preserving representation suitable for the chunker.
 *
 * Pipeline:
 *   1. Wrap fragments in a minimal HTML document so Readability can run.
 *   2. Run @mozilla/readability to strip nav/ads/footer; keep article body.
 *   3. Extract title + byline + cleaned HTML + plain text.
 *   4. Compute content_hash over the plain text for idempotency.
 */
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { createHash } from "node:crypto";

export interface ParsedDocument {
  title: string;
  author: string | null;
  /** Article body as cleaned HTML; the chunker walks this for headings/blocks. */
  cleaned_html: string;
  /** Article body as plain text; used for content_hash and as the raw_text store. */
  plain_text: string;
  /** sha256 hex over plain_text. Drives idempotent skip when content unchanged. */
  content_hash: string;
}

function looksLikeFragment(html: string): boolean {
  const head = html.slice(0, 300).toLowerCase();
  return !head.includes("<html") && !head.includes("<!doctype");
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Extract plain text from cleaned HTML. We preserve paragraph breaks as
 * double newlines so the chunker can still see structure.
 */
function htmlToPlainText(cleanedHtml: string): string {
  const dom = new JSDOM(`<!doctype html><body>${cleanedHtml}</body>`);
  const body = dom.window.document.body;

  // Replace block-level closes with double newlines before reading textContent.
  const blockTags = [
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "li",
    "pre",
    "blockquote",
    "tr",
    "div",
    "section",
    "article",
  ];
  for (const tag of blockTags) {
    for (const el of Array.from(body.querySelectorAll(tag))) {
      el.append(dom.window.document.createTextNode("\n\n"));
    }
  }

  const text = body.textContent ?? "";
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n\n")
    .trim();
}

export function parseHTML(
  html: string,
  sourceUrl: string,
  opts: { fallbackTitle?: string; fallbackAuthor?: string } = {},
): ParsedDocument {
  const wrapped = looksLikeFragment(html)
    ? `<!doctype html><html><head><title>${opts.fallbackTitle ?? ""}</title></head><body><article>${html}</article></body></html>`
    : html;

  const dom = new JSDOM(wrapped, { url: sourceUrl });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article || !article.content) {
    throw new Error(`Readability failed to extract content for ${sourceUrl}`);
  }

  const cleaned_html = article.content;
  const plain_text = htmlToPlainText(cleaned_html);
  const content_hash = createHash("sha256").update(plain_text).digest("hex");

  // Prefer the caller-supplied title (RSS metadata is curated) over Readability's
  // extracted title, which sometimes picks a subheading from the article body.
  const title = normalizeWhitespace(opts.fallbackTitle || article.title || "Untitled");
  const author = opts.fallbackAuthor
    ? normalizeWhitespace(opts.fallbackAuthor)
    : article.byline
    ? normalizeWhitespace(article.byline)
    : null;

  return {
    title,
    author,
    cleaned_html,
    plain_text,
    content_hash,
  };
}
