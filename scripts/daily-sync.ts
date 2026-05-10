/**
 * Daily ingestion sync.
 *
 *   pnpm daily-sync
 *
 * Thin wrapper over `ingestSource(--all)` intended to run as a cron job
 * (Vercel Cron / GitHub Actions / launchd). Idempotent: re-running on the
 * same day adds no chunks because the content_hash check skips unchanged
 * documents BEFORE any embedding API call.
 *
 * Exit code is non-zero only on full-source failures (so cron alerts fire
 * on real outages but not on per-doc parse errors that the DLQ already
 * captured).
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

(async () => {
  const t0 = Date.now();
  const slugs = Object.keys(loadSources());
  console.log(`daily-sync: ${slugs.length} source(s) at ${new Date().toISOString()}`);

  const summaries: IngestSummary[] = [];
  const failures: IngestFailure[] = [];
  let sourceLevelFailures = 0;

  for (const slug of slugs) {
    try {
      const s = await ingestSource({ sourceSlug: slug, concurrency: 3 });
      summaries.push(s);
      failures.push(...s.failures);
      console.log(
        `  ${slug.padEnd(22)} fetched=${s.fetched.toString().padStart(3)} new=${s.inserted.toString().padStart(3)} updated=${s.updated.toString().padStart(2)} unchanged=${s.skipped_unchanged.toString().padStart(3)} failed=${s.failed.toString().padStart(2)} chunks=${s.total_chunks_indexed.toString().padStart(4)} cost=$${s.embed_cost_usd_est.toFixed(4)}`,
      );
    } catch (err) {
      sourceLevelFailures++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`✗ ${slug} threw: ${msg.slice(0, 200)}`);
      failures.push({
        source: slug,
        url: "(source-level failure)",
        reason: msg.slice(0, 300),
        at: new Date().toISOString(),
      });
    }
  }

  const totals = summaries.reduce(
    (acc, s) => ({
      fetched: acc.fetched + s.fetched,
      new_docs: acc.new_docs + s.inserted,
      updated: acc.updated + s.updated,
      unchanged: acc.unchanged + s.skipped_unchanged,
      failed: acc.failed + s.failed,
      chunks: acc.chunks + s.total_chunks_indexed,
      cost_usd: acc.cost_usd + s.embed_cost_usd_est,
    }),
    { fetched: 0, new_docs: 0, updated: 0, unchanged: 0, failed: 0, chunks: 0, cost_usd: 0 },
  );

  const elapsed_s = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("\n─── totals ──────────────────────────────");
  console.log(JSON.stringify({ ...totals, source_level_failures: sourceLevelFailures, elapsed_s }, null, 2));

  if (failures.length > 0) {
    const dir = join(process.cwd(), "data");
    await mkdir(dir, { recursive: true });
    const path = join(
      dir,
      `dlq-daily-sync-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
    );
    await writeFile(path, failures.map((f) => JSON.stringify(f)).join("\n") + "\n");
    console.log(`wrote ${failures.length} failure(s) to ${path}`);
  }

  await sql.end();
  process.exit(sourceLevelFailures > 0 ? 1 : 0);
})().catch(async (err) => {
  console.error(err);
  try { await sql.end(); } catch {}
  process.exit(2);
});
