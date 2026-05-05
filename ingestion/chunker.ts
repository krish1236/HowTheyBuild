/**
 * Structural + hierarchical chunker.
 *
 *  - Walks the cleaned HTML body and splits at H2/H3 boundaries into "sections".
 *  - For each section, packs constituent blocks (paragraphs, code, lists, tables)
 *    into child chunks targeting ~300–400 tokens, hard-capped at ~600.
 *  - Each child chunk gets:
 *      • a breadcrumb (`[Source: X | Title: Y | Section: Z]`) prepended at embed time
 *      • a `parent_text`, the full section text, for small-to-big retrieval
 *
 * Token counting is char-based (≈ 4 chars/token for English). Good enough for
 * sizing decisions; the embedder handles the actual tokenization downstream.
 */
import { JSDOM } from "jsdom";

const TARGET_CHILD_CHARS = 1500; // ~375 tokens
const MAX_CHILD_CHARS = 2400; //   ~600 tokens hard cap (safe under embedder context)
const MIN_CHILD_CHARS = 200; //    drop chunks shorter than this

const BLOCK_TAGS = new Set([
  "p",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "table",
  "figure",
  "div",
]);

export interface Chunk {
  position: number;
  breadcrumb: string;
  text: string;
  parent_text: string;
  token_count: number;
}

export interface ChunkInput {
  source_name: string;
  doc_title: string;
  cleaned_html: string;
}

function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function elementToText(el: Element): string {
  // Simple: textContent with whitespace normalization. Preserve newlines inside <pre>.
  const tag = el.tagName.toLowerCase();
  if (tag === "pre") {
    return (el.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
  }
  if (tag === "ul" || tag === "ol") {
    return Array.from(el.querySelectorAll("li"))
      .map((li) => "- " + (li.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter((s) => s.length > 2)
      .join("\n");
  }
  if (tag === "table") {
    return Array.from(el.querySelectorAll("tr"))
      .map((tr) =>
        Array.from(tr.children)
          .map((c) => (c.textContent ?? "").replace(/\s+/g, " ").trim())
          .join(" | "),
      )
      .join("\n");
  }
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

interface Section {
  heading: string | null;
  blocks: string[];
}

function splitIntoSections(body: Element): Section[] {
  const sections: Section[] = [];
  let currentHeading: string | null = null;
  let currentBlocks: string[] = [];

  const flush = () => {
    if (currentBlocks.length > 0) {
      sections.push({ heading: currentHeading, blocks: currentBlocks });
    }
  };

  for (const child of Array.from(body.children)) {
    const tag = child.tagName.toLowerCase();
    if (tag === "h1" || tag === "h2" || tag === "h3") {
      flush();
      currentHeading = (child.textContent ?? "").replace(/\s+/g, " ").trim() || null;
      currentBlocks = [];
      continue;
    }
    if (BLOCK_TAGS.has(tag) || /^h[4-6]$/.test(tag)) {
      const text = elementToText(child);
      if (text.length > 0) currentBlocks.push(text);
    }
  }
  flush();

  // Edge case: doc with no H2/H3 — sections will have a single entry with heading=null
  if (sections.length === 0) {
    return [{ heading: null, blocks: [] }];
  }
  return sections;
}

/**
 * Greedy-pack blocks into chunks, respecting both target and hard-cap sizes.
 * Blocks larger than MAX_CHILD_CHARS are split at sentence boundaries.
 */
function packBlocksIntoChunks(blocks: string[]): string[] {
  if (blocks.length === 0) return [];

  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed.length >= MIN_CHILD_CHARS) chunks.push(trimmed);
    current = "";
  };

  for (const block of blocks) {
    if (block.length > MAX_CHILD_CHARS) {
      // Block on its own exceeds the cap — flush, then sentence-split it.
      flush();
      for (const piece of splitLongBlock(block)) {
        chunks.push(piece);
      }
      continue;
    }

    const projected = current.length === 0 ? block.length : current.length + 2 + block.length;
    if (projected > MAX_CHILD_CHARS) {
      flush();
      current = block;
    } else {
      current = current.length === 0 ? block : current + "\n\n" + block;
    }

    if (current.length >= TARGET_CHILD_CHARS) flush();
  }

  flush();
  return chunks;
}

function splitLongBlock(text: string): string[] {
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z(\["])/);
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed.length >= MIN_CHILD_CHARS) chunks.push(trimmed);
    current = "";
  };

  for (const s of sentences) {
    if (s.length > MAX_CHILD_CHARS) {
      // Sentence itself is huge (e.g. one giant code line). Hard-cut.
      flush();
      for (let i = 0; i < s.length; i += MAX_CHILD_CHARS) {
        chunks.push(s.slice(i, i + MAX_CHILD_CHARS));
      }
      continue;
    }
    const projected = current.length === 0 ? s.length : current.length + 1 + s.length;
    if (projected > MAX_CHILD_CHARS) {
      flush();
      current = s;
    } else {
      current = current.length === 0 ? s : current + " " + s;
    }
    if (current.length >= TARGET_CHILD_CHARS) flush();
  }
  flush();
  return chunks;
}

export function chunkDocument(input: ChunkInput): Chunk[] {
  const { source_name, doc_title, cleaned_html } = input;

  const dom = new JSDOM(`<!doctype html><body>${cleaned_html}</body>`);
  const sections = splitIntoSections(dom.window.document.body);

  const chunks: Chunk[] = [];
  let position = 0;

  for (const section of sections) {
    if (section.blocks.length === 0) continue;

    const breadcrumb = section.heading
      ? `[Source: ${source_name} | Title: ${doc_title} | Section: ${section.heading}]`
      : `[Source: ${source_name} | Title: ${doc_title}]`;

    const parent_text = section.blocks.join("\n\n");
    const childTexts = packBlocksIntoChunks(section.blocks);

    for (const text of childTexts) {
      chunks.push({
        position: position++,
        breadcrumb,
        text,
        parent_text,
        token_count: approxTokens(text),
      });
    }
  }

  return chunks;
}
