/**
 * Reconcile: detect drift between live RSS feeds and our `documents` table.
 *
 *   pnpm reconcile           # report mode (no writes)
 *   pnpm reconcile --apply   # mark URLs missing from feeds for >7d as removed
 *
 * RSS feeds typically expose only the most recent ~10–20 posts, so a URL
 * being absent from the current feed does NOT mean it was deleted. We use
 * `last_seen_at` as the truth: if a doc hasn't been re-confirmed in the
 * feed for more than the threshold, mark `status='removed'`.
 *
 * The daily-sync job updates `last_seen_at` on every doc that re-appears
 * in the feed (whether changed or unchanged), so this works.
 */
import { fetchRSS } from "@/ingestion/connectors/rss";
import { loadSources } from "@/ingestion/sources";
import { sql } from "@/lib/db/client";

interface Args {
  apply: boolean;
  staleDays: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { apply: false, staleDays: 7 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--stale-days") out.staleDays = parseInt(argv[++i], 10);
    else if (a === "-h" || a === "--help") {
      console.log("Usage: pnpm reconcile [--apply] [--stale-days 7]");
      process.exit(0);
    }
  }
  return out;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const sources = loadSources();
  console.log(`reconcile: ${args.apply ? "APPLY" : "REPORT"} mode  (stale-days=${args.staleDays})`);
  console.log("");

  // 1. For each source, refresh last_seen_at on docs whose URL appears in
  //    the current feed. (daily-sync does this too; reconcile is the
  //    safety net that runs even if daily-sync is skipped.)
  let totalRefreshed = 0;
  for (const [slug, source] of Object.entries(sources)) {
    if (!source.rss_url) continue;
    try {
      const items = await fetchRSS(source.rss_url);
      const urls = items.map((i) => i.url);
      if (urls.length === 0) continue;
      const res = await sql<{ id: string }[]>`
        UPDATE documents SET last_seen_at = now()
        WHERE url = ANY(${urls}::text[]) AND status = 'active'
        RETURNING id::text AS id
      `;
      console.log(`  ${slug.padEnd(22)} feed=${urls.length} refreshed=${res.length}`);
      totalRefreshed += res.length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ${slug.padEnd(22)} FAILED ${msg.slice(0, 120)}`);
    }
  }

  // 2. Find docs that are still active but haven't been seen in any feed
  //    for > stale_days.
  const stale = await sql<{ id: string; url: string; last_seen_at: Date; source: string }[]>`
    SELECT d.id::text AS id, d.url, d.last_seen_at, s.name AS source
    FROM documents d JOIN sources s ON s.id = d.source_id
    WHERE d.status = 'active'
      AND d.last_seen_at < now() - (${args.staleDays} || ' days')::interval
    ORDER BY d.last_seen_at ASC
  `;

  console.log("");
  console.log(`docs refreshed this run: ${totalRefreshed}`);
  console.log(`docs stale (> ${args.staleDays}d): ${stale.length}`);

  if (stale.length > 0) {
    console.log("\nstale docs:");
    for (const d of stale.slice(0, 30)) {
      const lastSeen = new Date(d.last_seen_at).toISOString().slice(0, 10);
      console.log(`  [${d.source}] ${lastSeen}  ${d.url}`);
    }
    if (stale.length > 30) console.log(`  ... ${stale.length - 30} more`);

    if (args.apply) {
      const ids = stale.map((d) => d.id);
      await sql`UPDATE documents SET status = 'removed' WHERE id = ANY(${ids}::bigint[])`;
      console.log(`\nMARKED ${stale.length} doc(s) as removed.`);
    } else {
      console.log("\n(report mode — nothing changed. Re-run with --apply to mark these as removed.)");
    }
  }

  await sql.end();
})().catch(async (err) => {
  console.error(err);
  try { await sql.end(); } catch {}
  process.exit(1);
});
