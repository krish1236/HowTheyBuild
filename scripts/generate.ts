/**
 * End-to-end RAG CLI.
 *
 *   pnpm generate "how does cloudflare prevent global outages?"
 *   pnpm generate --no-rerank --top 5 "..."
 *
 * Pipeline: rewrite → hybrid retrieval → rerank → generate (streamed) →
 * citation validation. Refuses without an LLM call when confidence is low.
 */
import { hybridRetrieve, rrfRank, type Candidate } from "@/lib/rag/retrieval";
import { rewriteQuery } from "@/lib/rag/rewriter";
import { rerank } from "@/lib/rag/rerank";
import { generate } from "@/lib/rag/generator";
import { sql } from "@/lib/db/client";

interface Args {
  query: string;
  top: number;
  rewrite: boolean;
  rerankFlag: boolean;
  refusalThreshold: number;
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {
    top: 8,
    rewrite: true,
    rerankFlag: true,
    refusalThreshold: 0.3,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--top") out.top = parseInt(argv[++i], 10);
    else if (a === "--no-rewrite") out.rewrite = false;
    else if (a === "--no-rerank") out.rerankFlag = false;
    else if (a === "--threshold") out.refusalThreshold = parseFloat(argv[++i]);
    else if (a === "-h" || a === "--help") {
      console.log(
        'Usage: pnpm generate [--top N] [--no-rewrite] [--no-rerank] [--threshold X] "<query>"',
      );
      process.exit(0);
    } else positional.push(a);
  }
  out.query = positional.join(" ").trim();
  if (!out.query) {
    console.error('Missing query. Usage: pnpm generate "<query>"');
    process.exit(1);
  }
  return out as Args;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  console.log(`query: ${JSON.stringify(args.query)}\n`);

  // 1. Rewrite
  let queryForRetrieval = args.query;
  if (args.rewrite) {
    const r = await rewriteQuery(args.query);
    queryForRetrieval = r.rewritten;
    if (r.rewritten_by_llm) {
      console.log(`rewritten: ${JSON.stringify(r.rewritten)}  (${r.latency_ms}ms)`);
    }
  }

  // 2. Hybrid retrieve
  const tHybrid = Date.now();
  const candidates = await hybridRetrieve(queryForRetrieval);
  const hybrid_ms = Date.now() - tHybrid;
  console.log(
    `retrieved ${candidates.length} candidates (vec/fts/both = ${candidates.filter((c) => c.source_layer === "vector").length}/${candidates.filter((c) => c.source_layer === "fts").length}/${candidates.filter((c) => c.source_layer === "both").length}) in ${hybrid_ms}ms`,
  );

  // 3. Rerank (or RRF fallback)
  let ranked: Candidate[];
  let rerank_ms = 0;
  if (args.rerankFlag) {
    const rr = await rerank(queryForRetrieval, candidates, { topK: args.top });
    rerank_ms = rr.latency_ms;
    if (rr.reranked) {
      console.log(`reranked → top ${rr.candidates.length} in ${rerank_ms}ms`);
      ranked = rr.candidates;
    } else {
      console.log("rerank skipped — using RRF fallback");
      ranked = rrfRank(candidates).slice(0, args.top);
    }
  } else {
    ranked = rrfRank(candidates).slice(0, args.top);
  }

  // 4. Generate (streamed). Pre-LLM refusal lives inside generate().
  console.log("\n─── answer ─────────────────────────────────────────────────\n");
  const result = await generate({
    query: args.query,
    candidates: ranked,
    topK: args.top,
    refusalThreshold: args.refusalThreshold,
    onToken: (t) => process.stdout.write(t),
  });

  console.log("\n\n─── result ─────────────────────────────────────────────────");

  if (result.type === "refused") {
    console.log(`STATUS: refused (${result.reason})`);
    console.log(`MESSAGE: ${result.message}`);
  } else {
    console.log(`STATUS: answer (retried=${result.retried})`);
    console.log(`CITED chunk_ids: [${result.cited_chunk_ids.join(", ")}]`);
    console.log("\nSOURCES:");
    for (const id of result.cited_chunk_ids) {
      const c = ranked.find((x) => x.chunk_id === id);
      if (!c) continue;
      console.log(`  c${id}  ${c.source_name} | ${c.document_title}`);
      console.log(`         ${c.document_url}`);
    }
    console.log(`\nTTFT: ${result.ttft_ms}ms   total: ${result.total_ms}ms`);
  }

  console.log("\nUSAGE:");
  console.log(
    `  input_tokens=${result.usage.input_tokens}  cache_read=${result.usage.cache_read_input_tokens}  cache_write=${result.usage.cache_creation_input_tokens}  output_tokens=${result.usage.output_tokens}`,
  );
  console.log(`  cost ≈ $${result.usage.cost_usd.toFixed(6)}`);

  await sql.end();
})().catch(async (err) => {
  console.error(err);
  try {
    await sql.end();
  } catch {}
  process.exit(1);
});
