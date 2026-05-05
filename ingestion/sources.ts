import { readFileSync } from "node:fs";
import { join } from "node:path";

export type SourceType = "blog" | "paper" | "postmortem" | "book";

export interface SourceConfig {
  name: string;
  base_url: string;
  source_type: SourceType;
  rss_url?: string;
  license_tag: string | null;
  contact_email: string | null;
  /** If true, the RSS feed embeds full article HTML in <content:encoded> and we
   *  can skip a separate HTML fetch. Cloudflare and Stripe both do this. */
  use_rss_content: boolean;
}

let cache: Record<string, SourceConfig> | null = null;

export function loadSources(): Record<string, SourceConfig> {
  if (cache) return cache;
  const path = join(process.cwd(), "ingestion", "sources.json");
  cache = JSON.parse(readFileSync(path, "utf8")) as Record<string, SourceConfig>;
  return cache;
}

export function getSource(slug: string): SourceConfig {
  const sources = loadSources();
  const s = sources[slug];
  if (!s) {
    throw new Error(
      `Unknown source: ${slug}. Available: ${Object.keys(sources).join(", ")}`,
    );
  }
  return s;
}
