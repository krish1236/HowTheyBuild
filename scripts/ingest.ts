/**
 * Ingestion CLI.
 *
 *   pnpm ingest --source cloudflare-blog --limit 10
 *
 * Required env: DATABASE_URL, OPENAI_API_KEY.
 */
import { ingestSource } from "@/ingestion/pipeline";
import { sql } from "@/lib/db/client";

interface Args {
  source: string;
  limit?: number;
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--source") out.source = argv[++i];
    else if (arg === "--limit") out.limit = parseInt(argv[++i], 10);
    else if (arg === "-h" || arg === "--help") {
      console.log("Usage: pnpm ingest --source <slug> [--limit N]");
      process.exit(0);
    }
  }
  if (!out.source) {
    console.error("Missing --source");
    process.exit(1);
  }
  return out as Args;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  const summary = await ingestSource({
    sourceSlug: args.source,
    limit: args.limit,
  });
  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("\n─── summary ─────────────────────────────");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`elapsed: ${dur}s`);
  await sql.end();
})().catch(async (err) => {
  console.error(err);
  try {
    await sql.end();
  } catch {}
  process.exit(1);
});
