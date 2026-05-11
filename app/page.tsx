"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useQueryStream, type Citation } from "@/app/_lib/useQueryStream";
import { sourceShortCode } from "@/app/_lib/sources";
import { BgArt } from "@/app/_components/BgArt";
import { TopBar } from "@/app/_components/TopBar";
import { Footer } from "@/app/_components/Footer";
import { Cite, type CitationData } from "@/app/_components/Cite";
import { SourcesPanel, type SourceEntry } from "@/app/_components/SourcesPanel";
import { FlowGraph, Spark, Prompt } from "@/app/_components/illustrations";

// ── Static placeholder data ──────────────────────────────────
// All numbers below mirror the actual ingested corpus as of Phase 6.
// Phase 6b wires these to live /api/corpus and /api/queries/recent
// endpoints; today they refresh by editing this file.

interface SuggestedQuery {
  ts: string;
  tag: string;
  q: string;
  org: string;
  conf: number;
}

const SUGGESTED_QUERIES: SuggestedQuery[] = [
  { ts: "26·05·09 18:42", tag: "#networking",     q: "How does Cloudflare prevent global outages with safer config rollouts?", org: "Cloudflare", conf: 0.91 },
  { ts: "26·05·09 18:11", tag: "#infrastructure", q: "How is Dropbox reducing its monorepo size to improve developer velocity?", org: "Dropbox",    conf: 0.84 },
  { ts: "26·05·09 17:36", tag: "#realtime",       q: "How did Slack rebuild its notifications system?",                           org: "Slack",      conf: 0.87 },
  { ts: "26·05·09 16:58", tag: "#ml",             q: "How do companies reduce LLM and ML inference costs?",                        org: "Meta",       conf: 0.78 },
  { ts: "26·05·09 16:22", tag: "#deploy",         q: "How does GitHub use eBPF to improve deployment safety?",                    org: "GitHub",     conf: 0.82 },
];

interface CorpusOrg {
  id: string;
  name: string;
  count: number;
  freshness: string;
}

const CORPUS: CorpusOrg[] = [
  { id: "01", name: "Cloudflare", count: 197, freshness: "+1 wk" },
  { id: "02", name: "AWS Arch",   count: 195, freshness: "+1 wk" },
  { id: "03", name: "AWS Blog",   count: 93,  freshness: "+1 wk" },
  { id: "04", name: "Pinterest",  count: 89,  freshness: "+2 wk" },
  { id: "05", name: "Dropbox",    count: 89,  freshness: "+2 wk" },
  { id: "06", name: "Airbnb",     count: 84,  freshness: "+2 wk" },
  { id: "07", name: "Slack",      count: 78,  freshness: "+1 wk" },
  { id: "08", name: "GitHub",     count: 76,  freshness: "+1 wk" },
  { id: "09", name: "Meta",       count: 67,  freshness: "+2 wk" },
];
const TOTAL_CHUNKS = CORPUS.reduce((a, c) => a + c.count, 0);

// ── Root ─────────────────────────────────────────────────────

type Screen = "home" | "answer";

export default function Home() {
  const [screen, setScreen] = useState<Screen>("home");
  const [query, setQuery] = useState<string>("");
  const { state, submit, cancel } = useQueryStream();

  const goHome = () => {
    cancel();
    setScreen("home");
  };

  const ask = (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    setQuery(trimmed);
    setScreen("answer");
    submit(trimmed);
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "instant" });
    }
  };

  return (
    <div className="page">
      <BgArt />
      <div className="shell">
        <TopBar onHome={goHome} screen={screen} corpusCount={TOTAL_CHUNKS} />
      </div>
      {screen === "home" ? (
        <HomeScreen onAsk={ask} />
      ) : (
        <AnswerScreen
          query={query}
          state={state}
          onBack={goHome}
          onCancel={cancel}
        />
      )}
      <Footer />
    </div>
  );
}

// ── Home ─────────────────────────────────────────────────────

interface HomeScreenProps {
  onAsk: (q: string) => void;
}

function HomeScreen({ onAsk }: HomeScreenProps) {
  const [val, setVal] = useState("");
  const [scope, setScope] = useState<string[]>(["all"]);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-grow textarea
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  }, [val]);

  // ⌘↵ / ctrl+↵ submit shortcut
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        if (val.trim()) onAsk(val.trim());
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [val, onAsk]);

  const onTextareaKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (val.trim()) onAsk(val.trim());
    }
  };

  const submit = () => {
    if (val.trim()) onAsk(val.trim());
  };

  const toggleScope = (s: string) => {
    setScope((prev) =>
      prev.includes(s)
        ? prev.filter((x) => x !== s).length
          ? prev.filter((x) => x !== s)
          : ["all"]
        : s === "all"
        ? ["all"]
        : [...prev.filter((x) => x !== "all"), s],
    );
  };

  const scopeOpts = ["all", "networking", "storage", "deploy", "realtime", "postmortems"];

  // SSR-safe clock: empty on server, populated on mount, ticks every second.
  // Avoids the hydration mismatch from Date.now() being non-deterministic.
  const [tsNow, setTsNow] = useState<string>("");
  useEffect(() => {
    const tick = () => setTsNow(new Date().toISOString().slice(11, 19) + "Z");
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <main className="shell">
      <section className="hero">
        <div className="hero__copy">
          <div className="hero__breadcrumb">
            <span>~/ ask</span>
            <span className="sep">›</span>
            <span className="pill">corpus <span className="acc">{TOTAL_CHUNKS.toLocaleString()}</span> chunks</span>
            <span className="sep">›</span>
            <span>citation floor 0.40</span>
          </div>
          <h1 className="hero__title">
            How they <span className="underline">actually</span><br />build it.
            <span className="mono-aside">
              // citation-first reference for software engineers.<br />
              // every claim → <span className="acc">[source · chunk]</span> · refuses below <span className="acc-c">0.40</span> rerank.
            </span>
          </h1>
        </div>
        <div className="hero__viz">
          <div className="hero__viz-hd">
            <span><span className="id">trace_</span>fig_01 · request lifecycle</span>
            <span className="live"><span className="led" /> live</span>
          </div>
          <FlowGraph />
          <div className="hero__viz-ft">
            <div className="stat"><span className="k">P50</span><span className="v">42ms</span></div>
            <div className="stat"><span className="k">P99</span><span className="v acid">187ms</span></div>
            <div className="stat"><span className="k">AVAIL</span><span className="v cyan">99.97%</span></div>
            <div className="stat"><span className="k">PoPs</span><span className="v">312</span></div>
          </div>
        </div>
      </section>

      <section className="composer" aria-label="ask a question">
        <div className="composer__prompt">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Prompt /> ask
          </span>
          <span className="ts">{tsNow}</span>
        </div>
        <div className="composer__field">
          <textarea
            ref={taRef}
            className="composer__textarea"
            placeholder="how does … why did … what's actually inside …"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={onTextareaKeyDown}
            rows={2}
            autoFocus
          />
          <div className="composer__chips" role="group" aria-label="scope filter">
            {scopeOpts.map((s) => (
              <button
                key={s}
                className={"composer__chip " + (scope.includes(s) ? "is-on" : "")}
                onClick={() => toggleScope(s)}
                type="button"
              >
                #{s}
              </button>
            ))}
          </div>
        </div>
        <div className="composer__send">
          <button
            className="btn-run"
            onClick={submit}
            aria-label="run query"
            disabled={!val.trim()}
            type="button"
          >
            <span>RUN</span>
            <span className="keys"><span>⌘</span><span>↵</span></span>
            <span className="arrow">▸</span>
          </button>
        </div>
      </section>

      <section className="qlog" aria-label="recent investigations">
        <div className="qlog__hd">
          <span>TIMESTAMP</span>
          <span>QUERY</span>
          <span className="col-org">ORG</span>
          <span className="col-src">CONF</span>
          <span style={{ textAlign: "right" }}>↗</span>
        </div>
        {SUGGESTED_QUERIES.map((q, i) => (
          <button key={i} className="qlog__row" onClick={() => onAsk(q.q)} type="button">
            <span className="qlog__ts">{q.ts}</span>
            <span className="qlog__q">
              <span className="tag">{q.tag}</span>
              {q.q}
            </span>
            <span className="qlog__org">{q.org}</span>
            <span className="qlog__sources">
              <span className="pips">
                {Array.from({ length: 5 }).map((_, j) => (
                  <span
                    key={j}
                    className={"pip " + (j < Math.round(q.conf * 5) ? "on" : "")}
                  />
                ))}
              </span>
            </span>
            <span className="qlog__arrow">→</span>
          </button>
        ))}
      </section>

      <section className="corpus" aria-label="corpus organisations">
        {CORPUS.map((c, i) => (
          <div key={c.id} className="corpus__cell">
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span className="id">[{c.id}]</span>
              <span className="freshness" style={{ color: "var(--cyan)" }}>{c.freshness}</span>
            </div>
            <span className="name">{c.name}</span>
            <div className="spark">
              <Spark seed={i + 3} color={i % 3 === 0 ? "var(--acid)" : "var(--cyan)"} />
            </div>
            <div className="row">
              <span className="count">{c.count} chunks</span>
              <span style={{ color: "var(--tx-4)" }}>indexed</span>
            </div>
          </div>
        ))}
      </section>
    </main>
  );
}

// ── Answer screen + streaming text helpers ───────────────────

interface AnswerScreenProps {
  query: string;
  state: ReturnType<typeof useQueryStream>["state"];
  onBack: () => void;
  onCancel: () => void;
}

function AnswerScreen({ query, state, onBack, onCancel }: AnswerScreenProps) {
  const onAir = state.phase === "connecting" || state.phase === "streaming";
  const refused =
    state.phase === "done" && state.done?.refused === true;
  const errored = state.phase === "error";

  // Order citations 1..N by first appearance of [c<id>] in the streamed text.
  // This lets inline chips render with their bibliography number even before
  // the citation event for that chunk_id has arrived.
  const orderedCitedIds = useMemo(() => {
    const seen: string[] = [];
    const present = new Set<string>();
    const re = /\[c(\d+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(state.text)) !== null) {
      const id = m[1];
      if (!present.has(id)) {
        present.add(id);
        seen.push(id);
      }
    }
    return seen;
  }, [state.text]);

  const citationNumber = useMemo(() => {
    const map = new Map<string, number>();
    orderedCitedIds.forEach((id, idx) => map.set(id, idx + 1));
    return map;
  }, [orderedCitedIds]);

  const sourceEntries: SourceEntry[] = useMemo(() => {
    // Only include cited chunks that we have metadata for (i.e. the
    // citation event has arrived). Order: by bibliography number.
    return orderedCitedIds
      .map((id, idx): SourceEntry | null => {
        const c = state.citations.get(id);
        if (!c) return null;
        return { n: idx + 1, citation: c, score: null };
      })
      .filter((x): x is SourceEntry => x !== null);
  }, [orderedCitedIds, state.citations]);

  return (
    <main className="shell answer">
      <button className="answer__back" onClick={onBack} type="button">
        ← back / ~/ ask
      </button>

      <div className="qrecap">
        <div className="qrecap__hd">
          <span><span className="id">trace_</span>q · pipeline</span>
          <span className={"live " + (onAir ? "" : "is-done")}>
            <span className="led" /> {onAir ? "streaming" : refused ? "refused" : errored ? "error" : "complete"}
          </span>
        </div>
        <div className="qrecap__q">
          <span className="arrow">▸</span>
          <span>{query}</span>
        </div>
        <div className="qrecap__meters">
          <div className="qrecap__meter">
            <div className="k">RETRIEVE</div>
            <div className="v">
              {state.meta?.retrieved ?? "—"}
              <small>chunks</small>
            </div>
          </div>
          <div className="qrecap__meter">
            <div className="k">RERANK · TOP-K</div>
            <div className="v acid">
              {state.meta?.reranked ?? "—"}
              <small>kept</small>
            </div>
          </div>
          <div className="qrecap__meter">
            <div className="k">TOP SCORE</div>
            <div className="v cyan">
              {state.meta?.top_rerank_score != null
                ? state.meta.top_rerank_score.toFixed(2)
                : "—"}
            </div>
          </div>
          <div className="qrecap__meter">
            <div className="k">ELAPSED</div>
            <div className="v">
              {state.done ? (state.done.total_ms / 1000).toFixed(2) : "—"}
              <small>s</small>
            </div>
          </div>
        </div>
      </div>

      {refused ? (
        <RefusalCard
          reason={state.done?.refusal_reason ?? null}
          onSeed={onBack}
        />
      ) : errored ? (
        <ErrorCard
          code={state.error?.code ?? "unknown"}
          message={state.error?.message ?? "Something went wrong."}
        />
      ) : (
        <>
          <div className="body-grid">
            <article className="prose" aria-busy={onAir}>
              <StreamingProse text={state.text} citations={state.citations} citationNumber={citationNumber} />
              {onAir && <span className="cursor-blk" aria-hidden="true" />}
            </article>

            <aside className="trace" aria-label="pipeline trace">
              <div className="trace__hd">
                <span>PIPELINE TRACE</span>
                <span className="id">q</span>
              </div>
              <div className="trace__list">
                <TraceStep label="rewrite query"     sub="haiku · small-llm"      doneAt={state.meta || state.text.length > 0 ? "+0.8s" : null} live={onAir && !state.meta} />
                <TraceStep label="vector search"     sub={state.meta ? `retrieved ${state.meta.retrieved} / ${TOTAL_CHUNKS.toLocaleString()} chunks` : "queued"} doneAt={state.meta ? "+1.1s" : null} live={onAir && !state.meta} />
                <TraceStep label="rerank"            sub={state.meta ? `cohere v3 · top-k=${state.meta.reranked} · floor 0.40` : "queued"} doneAt={state.meta ? "+1.4s" : null} live={onAir && !state.meta} />
                <TraceStep label="guard · pii"       sub={state.meta ? "passed" : "queued"} doneAt={state.meta ? "+1.5s" : null} warn />
                <TraceStep label="synthesize"        sub={state.done ? `${state.done.cost_usd ? "$" + state.done.cost_usd.toFixed(4) : "complete"}` : (onAir ? "streaming tokens" : "queued")} doneAt={state.done ? `+${(state.done.total_ms / 1000).toFixed(2)}s` : null} live={onAir && state.text.length > 0} />
              </div>
              <div className={"trace__live " + (onAir ? "" : "done")}>
                <span className="lbl">
                  <span className="led" /> {onAir ? "streaming tokens" : "done"}
                </span>
                <div className={"bar " + (onAir ? "" : "done")} />
              </div>
            </aside>
          </div>

          {state.phase === "done" && !refused && (
            <SourcesPanel entries={sourceEntries} />
          )}
        </>
      )}
    </main>
  );
}

// ── Trace step ───────────────────────────────────────────────

interface TraceStepProps {
  label: string;
  sub: string;
  doneAt: string | null;
  live?: boolean;
  warn?: boolean;
}

function TraceStep({ label, sub, doneAt, live, warn }: TraceStepProps) {
  const cls = warn ? "warn" : doneAt ? "done" : "pending";
  return (
    <div className="trace__step">
      <span className={"ms " + cls}>{doneAt ?? (live ? "···" : "—")}</span>
      <span className="body">
        <span className="head">{label}</span>
        <span className="sub">{sub}</span>
      </span>
    </div>
  );
}

// ── Streaming markdown → prose with inline Cite chips ────────

interface StreamingProseProps {
  text: string;
  citations: Map<string, Citation>;
  citationNumber: Map<string, number>;
}

function StreamingProse({ text, citations, citationNumber }: StreamingProseProps) {
  if (!text) return null;
  // Split into paragraph blocks on blank lines; first non-empty is the lede.
  const blocks = text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  let ledeRendered = false;
  let h2Index = 0;
  return (
    <>
      {blocks.map((block, i) => {
        // ## Heading / ### Heading
        const h2 = /^##+\s+(.+)$/.exec(block);
        if (h2) {
          h2Index += 1;
          return (
            <h2 key={i}>
              <span className="h-num">§ {String(h2Index).padStart(2, "0")}</span>
              <span>{h2[1]}</span>
            </h2>
          );
        }
        const isLede = !ledeRendered;
        ledeRendered = true;
        const children = renderInline(block, citations, citationNumber);
        if (isLede) return <p key={i} className="lede">{children}</p>;
        return <p key={i}>{children}</p>;
      })}
    </>
  );
}

function renderInline(
  text: string,
  citations: Map<string, Citation>,
  citationNumber: Map<string, number>,
): ReactNode {
  const parts: ReactNode[] = [];
  const re = /\[c(\d+)\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const chunkId = m[1];
    const meta = citations.get(chunkId);
    const n = citationNumber.get(chunkId) ?? 0;
    const data: CitationData = {
      n,
      src: meta ? sourceShortCode(meta.source_name) : "??",
      chunk: chunkId,
      doc: meta?.document_title ?? "(loading source)",
      url: meta?.document_url,
    };
    parts.push(<Cite key={`c-${m.index}-${chunkId}`} c={data} animate={false} />);
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.map((p, i) => (typeof p === "string" ? <Fragment key={`s-${i}`}>{p}</Fragment> : p));
}

// ── Refusal + Error cards ────────────────────────────────────

function RefusalCard({
  reason,
  onSeed,
}: {
  reason: string | null;
  onSeed: () => void;
}) {
  return (
    <div className="refusal" role="alert">
      <div className="refusal__hd">
        <span>⚠ REFUSAL · {reason ?? "low_confidence"}</span>
        <span className="code">err: top rerank below floor 0.40</span>
      </div>
      <div className="refusal__bd">
        <h2 className="refusal__head">No confident answer in the corpus.</h2>
        <p className="refusal__body">
          The top rerank score across retrieved chunks was below the 0.40 floor —
          so the model declined to synthesize. The corpus may not cover this
          topic yet. Try{" "}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              onSeed();
            }}
          >
            rephrasing
          </a>{" "}
          or <a href="#" onClick={(e) => e.preventDefault()}>suggest a missing source</a>{" "}
          so the next reader gets it.
        </p>
        <div className="refusal__diag">
          <div><span className="k">REASON</span><span className="v">{reason ?? "—"}</span></div>
          <div><span className="k">FLOOR</span><span className="v">0.40</span></div>
          <div><span className="k">ACTION</span><span className="v warn">refuse · log</span></div>
        </div>
      </div>
    </div>
  );
}

function ErrorCard({ code, message }: { code: string; message: string }) {
  return (
    <div className="refusal" role="alert">
      <div className="refusal__hd">
        <span>⚠ ERROR · {code}</span>
        <span className="code">{message.slice(0, 80)}</span>
      </div>
      <div className="refusal__bd">
        <h2 className="refusal__head">Something went wrong on the pipeline.</h2>
        <p className="refusal__body">{message}</p>
      </div>
    </div>
  );
}
