/**
 * Retrieval CLI for hand-testing the pipeline.
 *
 *   pnpm retrieve "how does cloudflare handle outages"
 *   pnpm retrieve --top 5 "durable workflows"
 *   pnpm retrieve --no-rerank "<query>"
 *
 * Phase 2: hybrid retrieval (vector + FTS) → optional rewrite → optional rerank.
 * Each stage gracefully degrades if its provider key is missing.
 */
import { hybridRetrieve, rrfRank, type Candidate } from "@/lib/rag/retrieval";
import { rewriteQuery } from "@/lib/rag/rewriter";
import { rerank } from "@/lib/rag/rerank";
import { sql } from "@/lib/db/client";

interface Args {
  query: string;
  top: number;
  rerank: boolean;
  rewrite: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = { top: 10, rerank: true, rewrite: true };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--top") out.top = parseInt(argv[++i], 10);
    else if (arg === "--no-rerank") out.rerank = false;
    else if (arg === "--no-rewrite") out.rewrite = false;
    else if (arg === "-h" || arg === "--help") {
      console.log(
        'Usage: pnpm retrieve [--top N] [--no-rerank] [--no-rewrite] "<query>"',
      );
      process.exit(0);
    } else positional.push(arg);
  }
  out.query = positional.join(" ").trim();
  if (!out.query) {
    console.error('Missing query. Usage: pnpm retrieve "<query>"');
    process.exit(1);
  }
  return out as Args;
}

function fmtScore(s: number | null, width = 5): string {
  return s === null ? "  -  " : s.toFixed(3).padStart(width);
}

function printCandidates(
  candidates: Candidate[],
  rerankScores: Map<string, number> | null,
  top: number,
) {
  const shown = candidates.slice(0, top);
  console.log(
    `\n${"#".padStart(3)}  ${"vector".padStart(6)}  ${"fts".padStart(5)}  ${rerankScores ? "rerank " : "       "}${"src".padEnd(6)}  source / breadcrumb`,
  );
  console.log("─".repeat(110));
  for (let i = 0; i < shown.length; i++) {
    const c = shown[i];
    const r = rerankScores?.get(c.chunk_id);
    console.log(
      `${(i + 1).toString().padStart(3)}  ${fmtScore(c.vector_score, 6)}  ${fmtScore(c.fts_score, 5)}  ` +
        `${rerankScores ? (r !== undefined ? r.toFixed(3).padStart(7) : "      -") : "       "}` +
        `${c.source_layer.padEnd(6)}  ${c.source_name} | ${c.document_title.slice(0, 50)} | ${c.breadcrumb.split("Section: ")[1]?.replace("]", "").slice(0, 40) ?? "(no section)"}`,
    );
    console.log(`     ${c.text.slice(0, 140).replace(/\n/g, " ")}${c.text.length > 140 ? "…" : ""}`);
  }
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  console.log(`query: ${JSON.stringify(args.query)}`);

  // Step 1: rewrite (optional; gracefully skipped if key missing or --no-rewrite)
  let queryForRetrieval = args.query;
  if (args.rewrite) {
    const rewrite = await rewriteQuery(args.query);
    queryForRetrieval = rewrite.rewritten;
    if (rewrite.rewritten_by_llm) {
      console.log(`rewritten: ${JSON.stringify(rewrite.rewritten)}  (${rewrite.latency_ms}ms)`);
    } else if (rewrite.latency_ms > 0) {
      console.log(`rewriter ran but returned identical / failed (${rewrite.latency_ms}ms)`);
    } else {
      console.log("rewriter skipped (no anthropic key or empty input)");
    }
  }

  // Step 2: hybrid retrieval
  const t0 = Date.now();
  const timings: { embed_ms: number; vector_ms: number; fts_ms: number } = {
    embed_ms: 0,
    vector_ms: 0,
    fts_ms: 0,
  };
  const candidates = await hybridRetrieve(queryForRetrieval, {
    onTiming: (t) => Object.assign(timings, t),
  });
  const total_ms = Date.now() - t0;

  const vectorOnly = candidates.filter((c) => c.source_layer === "vector").length;
  const ftsOnly = candidates.filter((c) => c.source_layer === "fts").length;
  const both = candidates.filter((c) => c.source_layer === "both").length;

  console.log(
    `retrieved ${candidates.length} candidates (vector-only=${vectorOnly} fts-only=${ftsOnly} both=${both})`,
  );
  console.log(
    `  timings: embed=${timings.embed_ms}ms  vector=${timings.vector_ms}ms  fts=${timings.fts_ms}ms  hybrid_total=${total_ms}ms`,
  );

  // Step 3: rerank (gracefully passes through if Cohere key missing)
  let finalRanked: Candidate[];
  let rerankScores: Map<string, number> | null = null;
  if (args.rerank) {
    const result = await rerank(queryForRetrieval, candidates, { topK: args.top });
    if (result.reranked) {
      console.log(`reranked ${candidates.length} → ${result.candidates.length} (${result.latency_ms}ms)`);
      rerankScores = new Map(
        result.candidates
          .filter((c) => c.rerank_score !== null)
          .map((c) => [c.chunk_id, c.rerank_score as number]),
      );
      finalRanked = result.candidates;
    } else {
      console.log("rerank skipped (no cohere key or failure) — falling back to RRF");
      finalRanked = rrfRank(candidates);
    }
  } else {
    finalRanked = rrfRank(candidates);
  }

  printCandidates(finalRanked, rerankScores, args.top);

  await sql.end();
})().catch(async (err) => {
  console.error(err);
  try {
    await sql.end();
  } catch {}
  process.exit(1);
});
