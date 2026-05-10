/**
 * Evaluation runner.
 *
 *   pnpm eval                       # run full golden set, write timestamped result + baseline
 *   pnpm eval --limit 10            # smaller smoke run
 *   pnpm eval --no-judge            # skip the LLM-judge stage (cheaper, citation/recall only)
 *   pnpm eval --concurrency 3       # parallel queries (default 2)
 *
 * Pipeline per entry:
 *   query → rewrite → hybrid retrieve → rerank → generate → citation validate
 *   then: programmatic metrics (recall@50, nDCG@10, citation_accuracy)
 *         + LLM judge (faithfulness, quality_score) unless --no-judge
 *
 * Output:
 *   eval/runs/<ISO>.jsonl    one line per entry — gitignored
 *   eval/baseline.json        rollup metrics only — committed
 *   stdout                    table + threshold pass/fail + regression deltas
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { sql } from "@/lib/db/client";
import { hybridRetrieve, type Candidate } from "@/lib/rag/retrieval";
import { rewriteQuery } from "@/lib/rag/rewriter";
import { rerank } from "@/lib/rag/rerank";
import { generate } from "@/lib/rag/generator";
import { judgeAnswer, type JudgeVerdict } from "@/eval/judge_prompts";

interface GoldenEntry {
  id: string;
  difficulty: "easy" | "medium" | "hard" | "adversarial" | "multi-turn";
  intent: string;
  query: string;
  must_cite_doc_ids: number[];
  expected_answer_summary: string;
  expect_refusal: boolean;
}

interface EntryResult {
  id: string;
  difficulty: string;
  query: string;
  expect_refusal: boolean;
  refused: boolean;
  refusal_reason: string | null;
  retrieved_doc_ids: number[];
  reranked_doc_ids: number[];
  cited_chunk_ids: string[];
  invalid_citations: string[];
  recall_at_50: number;
  ndcg_at_10: number;
  citation_accuracy: number;
  faithful: boolean | null;
  quality_score: number | null;
  unsupported_claims: string[];
  judge_rationale: string | null;
  ttft_ms: number | null;
  total_ms: number;
  cost_usd: number;
  answer: string;
}

interface Args {
  limit?: number;
  noJudge: boolean;
  concurrency: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { noJudge: false, concurrency: 2 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") out.limit = parseInt(argv[++i], 10);
    else if (a === "--no-judge") out.noJudge = true;
    else if (a === "--concurrency") out.concurrency = parseInt(argv[++i], 10);
    else if (a === "-h" || a === "--help") {
      console.log("Usage: pnpm eval [--limit N] [--no-judge] [--concurrency 2]");
      process.exit(0);
    }
  }
  return out;
}

function loadGoldenSet(): GoldenEntry[] {
  const path = join(process.cwd(), "eval", "golden_set.jsonl");
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  return lines.map((l) => JSON.parse(l) as GoldenEntry);
}

/** Map a list of chunk_id strings into unique document_ids in retrieval order. */
async function chunkIdsToDocIds(chunkIds: string[]): Promise<number[]> {
  if (chunkIds.length === 0) return [];
  // Pass ids as a text[] then cast inside the query — simplest cross-driver path.
  const rows = (await sql`
    SELECT id::text AS id, document_id::text AS document_id
    FROM chunks WHERE id = ANY(${chunkIds}::bigint[])
  `) as unknown as { id: string; document_id: string }[];
  const byChunk = new Map(rows.map((r) => [r.id, Number(r.document_id)]));
  const seen = new Set<number>();
  const out: number[] = [];
  for (const cid of chunkIds) {
    const did = byChunk.get(cid);
    if (did != null && !seen.has(did)) {
      seen.add(did);
      out.push(did);
    }
  }
  return out;
}

/** nDCG@K with binary relevance and a target set of relevant doc_ids. */
function ndcg(rankedDocIds: number[], relevant: Set<number>, k: number): number {
  if (relevant.size === 0) return 0; // undefined; we report 0 and the caller handles refusal cases separately
  const cap = Math.min(k, rankedDocIds.length);
  let dcg = 0;
  for (let i = 0; i < cap; i++) {
    if (relevant.has(rankedDocIds[i])) dcg += 1 / Math.log2(i + 2);
  }
  let idcg = 0;
  const idealCount = Math.min(relevant.size, k);
  for (let i = 0; i < idealCount; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

async function evalEntry(entry: GoldenEntry, useJudge: boolean): Promise<EntryResult> {
  const t0 = Date.now();

  // 1. Rewrite + hybrid retrieve
  const rw = await rewriteQuery(entry.query);
  const candidates: Candidate[] = await hybridRetrieve(rw.rewritten);

  // 2. Rerank → top 8
  const rr = await rerank(rw.rewritten, candidates, { topK: 8 });
  const ranked = rr.reranked
    ? rr.candidates
    : candidates.slice(0, 8); // fallback if rerank skipped

  // 3. Generate
  const gen = await generate({
    query: entry.query,
    candidates: ranked,
    topK: 8,
  });

  // 4. Map chunk ids → doc ids for retrieval / rerank metrics
  const retrieved_doc_ids = await chunkIdsToDocIds(candidates.map((c) => c.chunk_id));
  const reranked_doc_ids = await chunkIdsToDocIds(ranked.map((c) => c.chunk_id));
  const must = new Set(entry.must_cite_doc_ids);

  // 5. Programmatic metrics
  const recall_at_50 = entry.expect_refusal
    ? NaN // not meaningful for refusal cases
    : entry.must_cite_doc_ids.length === 0
    ? 1
    : entry.must_cite_doc_ids.filter((d) => retrieved_doc_ids.includes(d)).length /
      entry.must_cite_doc_ids.length;
  const ndcg_at_10 = entry.expect_refusal ? NaN : ndcg(reranked_doc_ids.slice(0, 10), must, 10);

  let cited_chunk_ids: string[] = [];
  let invalid_citations: string[] = [];
  let citation_accuracy = 1; // refusals get 1.0 by convention (no citations to be wrong)
  let answer = "";

  if (gen.type === "answer") {
    cited_chunk_ids = gen.cited_chunk_ids;
    answer = gen.text;
    const validSet = new Set(ranked.map((c) => c.chunk_id));
    invalid_citations = cited_chunk_ids.filter((id) => !validSet.has(id));
    citation_accuracy =
      cited_chunk_ids.length === 0
        ? 0 // answered without citations = bad
        : (cited_chunk_ids.length - invalid_citations.length) / cited_chunk_ids.length;
  }

  // 6. LLM judge (only on answered, non-refusal entries)
  let verdict: JudgeVerdict | null = null;
  if (useJudge && gen.type === "answer" && !entry.expect_refusal) {
    try {
      verdict = await judgeAnswer({
        query: entry.query,
        // Send the same content the generator received: parent_text when present.
        retrieved_chunks: ranked.map((c) => ({
          chunk_id: c.chunk_id,
          text: c.parent_text ?? c.text,
        })),
        answer: gen.text,
        expected_summary: entry.expected_answer_summary,
      });
    } catch (err) {
      verdict = {
        faithful: false,
        quality_score: 0,
        unsupported_claims: ["judge_error"],
        rationale: err instanceof Error ? err.message.slice(0, 200) : String(err),
      };
    }
  }

  return {
    id: entry.id,
    difficulty: entry.difficulty,
    query: entry.query,
    expect_refusal: entry.expect_refusal,
    refused: gen.type === "refused",
    refusal_reason: gen.type === "refused" ? gen.reason : null,
    retrieved_doc_ids,
    reranked_doc_ids,
    cited_chunk_ids,
    invalid_citations,
    recall_at_50,
    ndcg_at_10,
    citation_accuracy,
    faithful: verdict ? verdict.faithful : null,
    quality_score: verdict ? verdict.quality_score : null,
    unsupported_claims: verdict ? verdict.unsupported_claims : [],
    judge_rationale: verdict ? verdict.rationale : null,
    ttft_ms: gen.type === "answer" ? gen.ttft_ms : null,
    total_ms: Date.now() - t0,
    cost_usd: gen.usage.cost_usd,
    answer,
  };
}

interface Aggregate {
  count: number;
  recall_at_50: number;
  ndcg_at_10: number;
  citation_accuracy: number;
  faithfulness: number;
  refusal_rate: number;
  refusal_correct_rate: number; // expected_refusal AND refused / expected_refusal
  p50_latency_ms: number;
  p95_latency_ms: number;
  total_cost_usd: number;
  judged_count: number;
}

function aggregate(results: EntryResult[]): Aggregate {
  const validRecall = results.filter((r) => Number.isFinite(r.recall_at_50));
  const validNdcg = results.filter((r) => Number.isFinite(r.ndcg_at_10));
  const judged = results.filter((r) => r.faithful !== null);

  const expectedRefusals = results.filter((r) => r.expect_refusal);
  const correctRefusals = expectedRefusals.filter((r) => r.refused);

  const latencies = results.map((r) => r.total_ms).sort((a, b) => a - b);
  const p = (q: number) =>
    latencies.length === 0
      ? 0
      : latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))];

  return {
    count: results.length,
    recall_at_50:
      validRecall.length === 0
        ? 0
        : validRecall.reduce((a, r) => a + r.recall_at_50, 0) / validRecall.length,
    ndcg_at_10:
      validNdcg.length === 0
        ? 0
        : validNdcg.reduce((a, r) => a + r.ndcg_at_10, 0) / validNdcg.length,
    citation_accuracy:
      results.length === 0
        ? 0
        : results.reduce((a, r) => a + r.citation_accuracy, 0) / results.length,
    faithfulness:
      judged.length === 0
        ? 0
        : judged.filter((r) => r.faithful).length / judged.length,
    refusal_rate:
      results.length === 0 ? 0 : results.filter((r) => r.refused).length / results.length,
    refusal_correct_rate:
      expectedRefusals.length === 0
        ? 1
        : correctRefusals.length / expectedRefusals.length,
    p50_latency_ms: p(0.5),
    p95_latency_ms: p(0.95),
    total_cost_usd: results.reduce((a, r) => a + r.cost_usd, 0),
    judged_count: judged.length,
  };
}

const THRESHOLDS = {
  recall_at_50: 0.9,
  ndcg_at_10: 0.7,
  citation_accuracy: 0.95,
  faithfulness: 0.85,
  refusal_rate_min: 0.05,
  refusal_rate_max: 0.15,
  p95_latency_ms: 30_000, // generous due to streaming + Sonnet TTFT
} as const;

function checkThresholds(agg: Aggregate): { name: string; pass: boolean; actual: string; required: string }[] {
  return [
    { name: "recall@50", pass: agg.recall_at_50 >= THRESHOLDS.recall_at_50, actual: agg.recall_at_50.toFixed(3), required: `≥ ${THRESHOLDS.recall_at_50}` },
    { name: "nDCG@10", pass: agg.ndcg_at_10 >= THRESHOLDS.ndcg_at_10, actual: agg.ndcg_at_10.toFixed(3), required: `≥ ${THRESHOLDS.ndcg_at_10}` },
    { name: "citation_accuracy", pass: agg.citation_accuracy >= THRESHOLDS.citation_accuracy, actual: agg.citation_accuracy.toFixed(3), required: `≥ ${THRESHOLDS.citation_accuracy}` },
    { name: "faithfulness", pass: agg.faithfulness >= THRESHOLDS.faithfulness, actual: agg.faithfulness.toFixed(3), required: `≥ ${THRESHOLDS.faithfulness}` },
    { name: "refusal_rate", pass: agg.refusal_rate >= THRESHOLDS.refusal_rate_min && agg.refusal_rate <= THRESHOLDS.refusal_rate_max, actual: agg.refusal_rate.toFixed(3), required: `${THRESHOLDS.refusal_rate_min}–${THRESHOLDS.refusal_rate_max}` },
    { name: "p95_latency_ms", pass: agg.p95_latency_ms <= THRESHOLDS.p95_latency_ms, actual: `${agg.p95_latency_ms}`, required: `≤ ${THRESHOLDS.p95_latency_ms}` },
  ];
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const golden = loadGoldenSet();
  const subset = args.limit ? golden.slice(0, args.limit) : golden;
  console.log(`golden set: ${golden.length} entries · running ${subset.length}`);
  console.log(`judge: ${args.noJudge ? "DISABLED" : process.env.ANTHROPIC_JUDGE_MODEL || "claude-opus-4-5-20251101"}\n`);

  const t0 = Date.now();
  const results: EntryResult[] = new Array(subset.length);

  // Limited concurrency (queries hit the same Cohere/Anthropic rate limits).
  let cursor = 0;
  async function worker(workerId: number) {
    while (true) {
      const i = cursor++;
      if (i >= subset.length) return;
      const e = subset[i];
      const tag = `[${i + 1}/${subset.length} w${workerId} ${e.id} ${e.difficulty}]`;
      try {
        results[i] = await evalEntry(e, !args.noJudge);
        const r = results[i];
        const flag = r.refused ? (e.expect_refusal ? "✓R" : "✗R") : (r.faithful === false ? "✗F" : r.invalid_citations.length ? "✗C" : "✓");
        console.log(`${tag} ${flag} recall=${Number.isFinite(r.recall_at_50) ? r.recall_at_50.toFixed(2) : "-"} nDCG=${Number.isFinite(r.ndcg_at_10) ? r.ndcg_at_10.toFixed(2) : "-"} cite=${r.citation_accuracy.toFixed(2)} faithful=${r.faithful ?? "-"} ${r.total_ms}ms $${r.cost_usd.toFixed(4)}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`${tag} FAILED: ${msg.slice(0, 160)}`);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(args.concurrency, subset.length) }, (_, i) => worker(i + 1)),
  );

  const valid = results.filter((r) => r);
  const agg = aggregate(valid);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log("\n─── aggregate ──────────────────────────────");
  console.log(`recall@50         ${agg.recall_at_50.toFixed(3)}`);
  console.log(`nDCG@10           ${agg.ndcg_at_10.toFixed(3)}`);
  console.log(`citation_accuracy ${agg.citation_accuracy.toFixed(3)}`);
  console.log(`faithfulness      ${agg.faithfulness.toFixed(3)} (judged ${agg.judged_count})`);
  console.log(`refusal_rate      ${agg.refusal_rate.toFixed(3)} (correct on expected: ${agg.refusal_correct_rate.toFixed(2)})`);
  console.log(`p50 / p95 latency ${agg.p50_latency_ms} / ${agg.p95_latency_ms} ms`);
  console.log(`total cost        $${agg.total_cost_usd.toFixed(4)}`);
  console.log(`elapsed           ${elapsed}s`);

  console.log("\n─── thresholds ─────────────────────────────");
  const checks = checkThresholds(agg);
  for (const c of checks) {
    console.log(`${c.pass ? "✓" : "✗"} ${pad(c.name, 18)} actual=${pad(c.actual, 8)} required=${c.required}`);
  }
  const allPass = checks.every((c) => c.pass);

  // Persist run + update baseline
  mkdirSync(join(process.cwd(), "eval", "runs"), { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const runPath = join(process.cwd(), "eval", "runs", `${ts}.jsonl`);
  writeFileSync(runPath, valid.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`\nwrote per-entry results to ${runPath}`);

  // Baseline summary (overwrites; tracked in git)
  const baselinePath = join(process.cwd(), "eval", "baseline.json");
  let prev: { aggregate?: Aggregate } | null = null;
  if (existsSync(baselinePath)) {
    try {
      prev = JSON.parse(readFileSync(baselinePath, "utf8"));
    } catch { /* ignore */ }
  }
  const baseline = {
    timestamp: new Date().toISOString(),
    golden_set_size: golden.length,
    ran: subset.length,
    judge_model: args.noJudge ? null : process.env.ANTHROPIC_JUDGE_MODEL || "claude-opus-4-5-20251101",
    aggregate: agg,
    thresholds_passed: allPass,
  };
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n");
  console.log(`updated baseline at ${baselinePath}`);

  // Regression check vs. previous baseline
  if (prev?.aggregate) {
    const deltas: { name: string; old: number; new: number; delta: number }[] = [
      { name: "recall@50", old: prev.aggregate.recall_at_50, new: agg.recall_at_50, delta: agg.recall_at_50 - prev.aggregate.recall_at_50 },
      { name: "nDCG@10", old: prev.aggregate.ndcg_at_10, new: agg.ndcg_at_10, delta: agg.ndcg_at_10 - prev.aggregate.ndcg_at_10 },
      { name: "citation_accuracy", old: prev.aggregate.citation_accuracy, new: agg.citation_accuracy, delta: agg.citation_accuracy - prev.aggregate.citation_accuracy },
      { name: "faithfulness", old: prev.aggregate.faithfulness, new: agg.faithfulness, delta: agg.faithfulness - prev.aggregate.faithfulness },
    ];
    const REGRESSION_DELTA = -0.03;
    const regressions = deltas.filter((d) => d.delta <= REGRESSION_DELTA);
    if (regressions.length > 0) {
      console.log("\n⚠️ REGRESSIONS (≥ 3% drop vs. last baseline):");
      for (const r of regressions) {
        console.log(`  ${pad(r.name, 18)} ${r.old.toFixed(3)} → ${r.new.toFixed(3)}  Δ${r.delta.toFixed(3)}`);
      }
    } else {
      console.log("\nno regressions vs. previous baseline.");
    }
  }

  await sql.end();
  process.exit(allPass ? 0 : 1);
})().catch(async (err) => {
  console.error(err);
  try { await sql.end(); } catch {}
  process.exit(1);
});
