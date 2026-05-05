/**
 * RSS connector. Fetches an RSS 2.0 feed and returns a normalized list of
 * items: url, title, source_published_at, author, and (when present) the full
 * article HTML embedded in <content:encoded>.
 *
 * Polite fetch: identifies as HowTheyBuild, 10s timeout, single GET per call.
 * Caller is responsible for any rate limiting / per-domain throttling.
 */
import { XMLParser } from "fast-xml-parser";

const USER_AGENT =
  "HowTheyBuild/0.1 (+contact@howtheybuild.dev; respectful crawler)";

export interface RSSItem {
  url: string;
  title: string;
  source_published_at: Date | null;
  author: string | null;
  /** Full article HTML if the feed embeds it via <content:encoded>; null otherwise. */
  content_html: string | null;
  /** Short description / excerpt. */
  description: string | null;
}

type RawField = string | { "#text": string } | Array<{ "#text": string }> | undefined;

interface ParsedItem {
  link?: RawField;
  title?: RawField;
  pubDate?: RawField;
  "dc:creator"?: RawField;
  author?: RawField;
  description?: RawField;
  "content:encoded"?: RawField;
}

/**
 * fast-xml-parser with `cdataPropName: "#text"` returns CDATA fields as either
 *   - a single object  { "#text": "..." }
 *   - an array         [{ "#text": "..." }]
 * and non-CDATA fields as plain strings. Normalize all of these to a string.
 */
function asString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    return value.length > 0 ? asString(value[0]) : null;
  }
  if (typeof value === "object" && value !== null && "#text" in value) {
    const inner = (value as { "#text": unknown })["#text"];
    return inner == null ? null : String(inner).trim() || null;
  }
  return null;
}

function parseDate(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

export async function fetchRSS(rssUrl: string): Promise<RSSItem[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  let xml: string;
  try {
    const res = await fetch(rssUrl, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml, application/xml, text/xml" },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`RSS ${rssUrl}: HTTP ${res.status}`);
    }
    xml = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    cdataPropName: "#text",
    trimValues: true,
  });
  const parsed = parser.parse(xml);

  const channel = parsed?.rss?.channel;
  if (!channel) {
    throw new Error(`RSS ${rssUrl}: no <channel> in feed`);
  }
  const rawItems: ParsedItem[] = Array.isArray(channel.item)
    ? channel.item
    : channel.item
    ? [channel.item]
    : [];

  return rawItems
    .map((it): RSSItem | null => {
      const url = asString(it.link);
      const title = asString(it.title);
      if (!url || !title) return null;
      return {
        url,
        title,
        source_published_at: parseDate(asString(it.pubDate)),
        author: asString(it["dc:creator"]) ?? asString(it.author),
        content_html: asString(it["content:encoded"]),
        description: asString(it.description),
      };
    })
    .filter((x): x is RSSItem => x !== null);
}
