/**
 * Ingestion CLI.
 *
 *   pnpm ingest --source cloudflare-blog --limit 10
 *   pnpm ingest --all                       # backfill every source in sources.json
 *   pnpm ingest --all --concurrency 3
 *
 * Required env: DATABASE_URL, OPENAI_API_KEY.
 *
 * On --all: sources run sequentially (one at a time); within each source,
 * `concurrency` items are processed in parallel. Failures land in
 * `data/dlq-<timestamp>.jsonl` and don't halt the run.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ingestSource,
  type IngestFailure,
  type IngestSummary,
} from "@/ingestion/pipeline";
import { loadSources } from "@/ingestion/sources";
import { sql } from "@/lib/db/client";

interface Args {
  source?: string;
  all: boolean;
  limit?: number;
  concurrency: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { all: false, concurrency: 3 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--source") out.source = argv[++i];
    else if (arg === "--all") out.all = true;
    else if (arg === "--limit") out.limit = parseInt(argv[++i], 10);
    else if (arg === "--concurrency") out.concurrency = parseInt(argv[++i], 10);
    else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: pnpm ingest --source <slug> [--limit N] [--concurrency 3]\n" +
          "       pnpm ingest --all [--limit N] [--concurrency 3]",
      );
      process.exit(0);
    }
  }
  if (!out.source && !out.all) {
    console.error("Missing --source or --all");
    process.exit(1);
  }
  return out;
}

function fmt(s: IngestSummary): string {
  return (
    `${s.source.padEnd(24)} ` +
    `fetched=${String(s.fetched).padStart(3)} ` +
    `inserted=${String(s.inserted).padStart(3)} ` +
    `updated=${String(s.updated).padStart(2)} ` +
    `skipped=${String(s.skipped_unchanged + s.skipped_no_content).padStart(3)} ` +
    `failed=${String(s.failed).padStart(2)} ` +
    `chunks=${String(s.total_chunks_indexed).padStart(4)} ` +
    `cost=$${s.embed_cost_usd_est.toFixed(4)}`
  );
}

async function writeDlq(failures: IngestFailure[]): Promise<string | null> {
  if (failures.length === 0) return null;
  const dir = join(process.cwd(), "data");
  await mkdir(dir, { recursive: true });
  const path = join(
    dir,
    `dlq-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
  );
  await writeFile(path, failures.map((f) => JSON.stringify(f)).join("\n") + "\n");
  return path;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const t0 = Date.now();

  const slugs = args.all ? Object.keys(loadSources()) : [args.source!];
  const summaries: IngestSummary[] = [];
  const allFailures: IngestFailure[] = [];

  console.log(`ingesting ${slugs.length} source(s): ${slugs.join(", ")}`);
  console.log("");

  for (const slug of slugs) {
    try {
      const s = await ingestSource({
        sourceSlug: slug,
        limit: args.limit,
        concurrency: args.concurrency,
      });
      summaries.push(s);
      allFailures.push(...s.failures);
      console.log(`\n→ ${fmt(s)}\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`✗ ${slug} threw: ${msg.slice(0, 200)}\n`);
      allFailures.push({
        source: slug,
        url: "(source-level failure)",
        reason: msg.slice(0, 300),
        at: new Date().toISOString(),
      });
    }
  }

  const dur = ((Date.now() - t0) / 1000).toFixed(1);

  console.log("─── totals ──────────────────────────────");
  const totals = summaries.reduce(
    (acc, s) => ({
      fetched: acc.fetched + s.fetched,
      inserted: acc.inserted + s.inserted,
      updated: acc.updated + s.updated,
      skipped: acc.skipped + s.skipped_unchanged + s.skipped_no_content,
      failed: acc.failed + s.failed,
      chunks: acc.chunks + s.total_chunks_indexed,
      tokens: acc.tokens + s.total_embed_tokens,
      cost: acc.cost + s.embed_cost_usd_est,
    }),
    { fetched: 0, inserted: 0, updated: 0, skipped: 0, failed: 0, chunks: 0, tokens: 0, cost: 0 },
  );
  console.log(JSON.stringify(totals, null, 2));

  if (allFailures.length > 0) {
    const path = await writeDlq(allFailures);
    console.log(`\nwrote ${allFailures.length} failure(s) to ${path}`);
  }

  console.log(`\nelapsed: ${dur}s`);
  await sql.end();
})().catch(async (err) => {
  console.error(err);
  try {
    await sql.end();
  } catch {}
  process.exit(1);
});
