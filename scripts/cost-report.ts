/**
 * Daily cost report from the queries audit table.
 *
 *   pnpm cost-report                    # last 7 days
 *   pnpm cost-report --days 30
 *   pnpm cost-report --json             # machine-readable output
 *
 * Sources of cost in `queries.total_cost_usd`:
 *   - LLM input + output (Sonnet by default; Anthropic billing)
 * Cohere rerank and OpenAI embedding spend are NOT in this column. They
 * are roughly $0.001/query combined and are tracked at the provider
 * dashboard. Phase 9 adds them to the audit row directly.
 *
 * Alert threshold: stderr warning if any single day > DAILY_BUDGET_USD.
 */
import { sql } from "@/lib/db/client";

interface Args {
  days: number;
  json: boolean;
}

const DAILY_BUDGET_USD = 20;

function parseArgs(argv: string[]): Args {
  const out: Args = { days: 7, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--days") out.days = parseInt(argv[++i], 10);
    else if (a === "--json") out.json = true;
    else if (a === "-h" || a === "--help") {
      console.log("Usage: pnpm cost-report [--days N] [--json]");
      process.exit(0);
    }
  }
  return out;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));

  const rows = (await sql`
    SELECT
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
      llm_model,
      count(*)::int AS queries,
      count(*) FILTER (WHERE refused) ::int AS refused,
      count(*) FILTER (WHERE cache_hit) ::int AS cache_hits,
      sum(llm_input_tokens)::bigint AS input_tok,
      sum(llm_input_tokens_cached)::bigint AS cached_tok,
      sum(llm_output_tokens)::bigint AS output_tok,
      round(sum(total_cost_usd)::numeric, 4) AS cost_usd,
      round(avg(total_latency_ms)::numeric, 0) AS avg_ms,
      round((percentile_disc(0.95) WITHIN GROUP (ORDER BY total_latency_ms))::numeric, 0) AS p95_ms
    FROM queries
    WHERE created_at >= now() - (${args.days} || ' days')::interval
    GROUP BY 1, 2
    ORDER BY 1 DESC, 2
  `) as unknown as Array<{
    day: string;
    llm_model: string;
    queries: number;
    refused: number;
    cache_hits: number;
    input_tok: string;
    cached_tok: string;
    output_tok: string;
    cost_usd: string;
    avg_ms: string;
    p95_ms: string;
  }>;

  if (args.json) {
    console.log(JSON.stringify(rows, null, 2));
    await sql.end();
    return;
  }

  if (rows.length === 0) {
    console.log(`no rows in queries within last ${args.days} days.`);
    await sql.end();
    return;
  }

  console.log(
    `cost report — last ${args.days} day(s)  ·  daily-budget alert at $${DAILY_BUDGET_USD}\n`,
  );
  console.log(
    "day        model                                 q   ref cache   in_tok  cached  out_tok    cost  avg_ms  p95_ms",
  );
  console.log("─".repeat(110));

  // Aggregate per day for budget check
  const byDay: Record<string, number> = {};
  for (const r of rows) {
    byDay[r.day] = (byDay[r.day] ?? 0) + Number(r.cost_usd);
    console.log(
      `${r.day} ${(r.llm_model ?? "-").padEnd(38)} ${String(r.queries).padStart(3)} ${String(r.refused).padStart(3)} ${String(r.cache_hits).padStart(5)} ${String(r.input_tok).padStart(8)} ${String(r.cached_tok).padStart(7)} ${String(r.output_tok).padStart(8)}  $${r.cost_usd.padStart(6)}  ${String(r.avg_ms).padStart(5)}  ${String(r.p95_ms).padStart(5)}`,
    );
  }

  const grandTotal = Object.values(byDay).reduce((a, b) => a + b, 0);
  console.log("");
  console.log(`grand total over ${args.days} day(s): $${grandTotal.toFixed(4)}`);

  const breaches = Object.entries(byDay).filter(([, v]) => v > DAILY_BUDGET_USD);
  if (breaches.length > 0) {
    console.error(`\n⚠️  daily budget breach (> $${DAILY_BUDGET_USD}):`);
    for (const [d, v] of breaches) console.error(`  ${d}  $${v.toFixed(2)}`);
    await sql.end();
    process.exit(2);
  }

  await sql.end();
})().catch(async (err) => {
  console.error(err);
  try { await sql.end(); } catch {}
  process.exit(1);
});
