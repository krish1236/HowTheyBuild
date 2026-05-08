"use client";

import { useState, useRef, useEffect, type KeyboardEvent } from "react";
import { useQueryStream, type Citation } from "@/app/_lib/useQueryStream";
import { AnswerMarkdown } from "@/app/_components/AnswerMarkdown";

const SUGGESTED_QUERIES = [
  "How does Cloudflare orchestrate AI code review?",
  "What did Cloudflare do after the November 2025 outage?",
  "How do dynamic workflows handle long-running tasks?",
  "How does Cloudflare prevent global outages with safer config rollouts?",
];

export default function Home() {
  const [input, setInput] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState<string | null>(null);
  const { state, submit, cancel } = useQueryStream();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const answerRef = useRef<HTMLDivElement>(null);

  // Auto-grow textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`;
  }, [input]);

  // Auto-scroll while answer streams
  useEffect(() => {
    if (state.phase === "streaming" || state.phase === "done") {
      answerRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [state.text, state.phase]);

  function handleSubmit(query: string) {
    const q = query.trim();
    if (!q) return;
    if (state.phase === "streaming" || state.phase === "connecting") {
      cancel();
    }
    setSubmittedQuery(q);
    submit(q);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(input);
    }
  }

  const isBusy = state.phase === "connecting" || state.phase === "streaming";
  const showAnswerArea = submittedQuery !== null;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-neutral-200 dark:border-neutral-800">
        <div className="mx-auto max-w-3xl px-4 py-4 sm:py-5">
          <div className="flex items-baseline justify-between gap-4">
            <h1 className="text-lg sm:text-xl font-semibold tracking-tight">
              HowTheyBuild
            </h1>
            <p className="text-xs sm:text-sm text-neutral-500 dark:text-neutral-400">
              real production stories, with sources
            </p>
          </div>
        </div>
      </header>

      <main className="flex-1">
        <div className="mx-auto max-w-3xl px-4 py-6 sm:py-10">
          {/* Input */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSubmit(input);
            }}
            className="space-y-3"
          >
            <label htmlFor="query" className="sr-only">
              Your question
            </label>
            <div className="relative">
              <textarea
                ref={textareaRef}
                id="query"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Ask about how real companies build production systems…"
                rows={3}
                className="w-full resize-none rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-2.5 text-sm sm:text-base placeholder-neutral-400 dark:placeholder-neutral-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                aria-label="Your question"
                autoFocus
              />
              <div className="mt-2 flex items-center justify-between text-xs text-neutral-500 dark:text-neutral-400">
                <span>
                  Press <kbd className="px-1 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 font-mono">Enter</kbd> to ask
                  · <kbd className="px-1 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 font-mono">Shift+Enter</kbd> for new line
                </span>
                <div className="flex gap-2">
                  {isBusy && (
                    <button
                      type="button"
                      onClick={cancel}
                      className="px-3 py-1 rounded bg-neutral-200 hover:bg-neutral-300 dark:bg-neutral-800 dark:hover:bg-neutral-700 transition-colors"
                    >
                      Stop
                    </button>
                  )}
                  <button
                    type="submit"
                    disabled={isBusy || input.trim().length === 0}
                    className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isBusy ? "Asking…" : "Ask"}
                  </button>
                </div>
              </div>
            </div>
          </form>

          {/* Suggested queries (only when nothing has been asked yet) */}
          {!showAnswerArea && (
            <section className="mt-8" aria-label="Suggested questions">
              <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400 mb-3">
                Try
              </h2>
              <ul className="grid gap-2 sm:grid-cols-2">
                {SUGGESTED_QUERIES.map((q) => (
                  <li key={q}>
                    <button
                      type="button"
                      onClick={() => {
                        setInput(q);
                        handleSubmit(q);
                      }}
                      className="w-full text-left px-3 py-2.5 rounded-md border border-neutral-200 dark:border-neutral-800 hover:border-neutral-400 dark:hover:border-neutral-600 hover:bg-neutral-50 dark:hover:bg-neutral-900 transition-colors text-sm"
                    >
                      {q}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Answer area */}
          {showAnswerArea && (
            <section className="mt-8" aria-live="polite" aria-atomic="false">
              <div className="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400 mb-2">
                Question
              </div>
              <div className="text-sm sm:text-base mb-6 whitespace-pre-wrap">
                {submittedQuery}
              </div>

              <Status state={state} />

              <div ref={answerRef}>
                {state.text.length > 0 && (
                  <AnswerMarkdown text={state.text} citations={state.citations} />
                )}
              </div>

              {state.phase === "done" && state.done?.refused && (
                <RefusalCard reason={state.done.refusal_reason} />
              )}

              {state.phase === "error" && state.error && (
                <ErrorCard code={state.error.code} message={state.error.message} />
              )}

              {state.phase === "done" && state.done && !state.done.refused && (
                <SourcesPanel citations={state.citations} />
              )}

              {state.phase === "done" && state.done && (
                <div className="mt-6 text-xs text-neutral-500 dark:text-neutral-400 font-mono">
                  ttft {state.done.ttft_ms ?? "—"}ms · total {state.done.total_ms}ms · ${state.done.cost_usd.toFixed(4)}
                </div>
              )}
            </section>
          )}
        </div>
      </main>

      <footer className="border-t border-neutral-200 dark:border-neutral-800 mt-auto">
        <div className="mx-auto max-w-3xl px-4 py-4 text-xs text-neutral-500 dark:text-neutral-400 flex flex-wrap items-center justify-between gap-2">
          <span>
            HowTheyBuild · citation-first Q&amp;A over engineering blog posts and postmortems
          </span>
          <span className="flex gap-4">
            <a href="/about" className="hover:text-neutral-900 dark:hover:text-neutral-200 transition-colors">
              About
            </a>
            <a
              href="https://github.com/krish1236/HowTheyBuild"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-neutral-900 dark:hover:text-neutral-200 transition-colors"
            >
              GitHub
            </a>
            <a href="/remove" className="hover:text-neutral-900 dark:hover:text-neutral-200 transition-colors">
              Remove a source
            </a>
          </span>
        </div>
      </footer>
    </div>
  );
}

function Status({ state }: { state: ReturnType<typeof useQueryStream>["state"] }) {
  if (state.phase === "connecting") {
    return (
      <div className="text-sm text-neutral-500 dark:text-neutral-400 mb-3 flex items-center gap-2">
        <Spinner /> connecting…
      </div>
    );
  }
  if (state.phase === "streaming") {
    return (
      <div className="text-xs text-neutral-500 dark:text-neutral-400 mb-3">
        {state.meta && (
          <>
            retrieved {state.meta.retrieved} → reranked {state.meta.reranked}
            {state.meta.top_rerank_score != null
              ? ` · top score ${state.meta.top_rerank_score.toFixed(2)}`
              : ""}
          </>
        )}
      </div>
    );
  }
  return null;
}

function Spinner() {
  return (
    <svg
      className="animate-spin h-3 w-3 text-neutral-500"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

function RefusalCard({ reason }: { reason: string | null }) {
  return (
    <div className="mt-4 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 p-4 text-sm">
      <p className="font-medium text-amber-900 dark:text-amber-300">
        I don&rsquo;t have a confident answer in the provided sources.
      </p>
      <p className="mt-1 text-neutral-700 dark:text-neutral-300">
        The corpus may not cover this topic yet. Try rephrasing, or{" "}
        <a href="/suggest" className="underline hover:no-underline">
          suggest a missing source
        </a>
        .
      </p>
      {reason && (
        <p className="mt-2 text-xs font-mono text-neutral-500 dark:text-neutral-500">
          reason: {reason}
        </p>
      )}
    </div>
  );
}

function ErrorCard({ code, message }: { code: string; message: string }) {
  return (
    <div className="mt-4 rounded-md border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-4 text-sm">
      <p className="font-medium text-red-900 dark:text-red-300">Something went wrong.</p>
      <p className="mt-1 text-neutral-700 dark:text-neutral-300">{message}</p>
      <p className="mt-2 text-xs font-mono text-neutral-500 dark:text-neutral-500">code: {code}</p>
    </div>
  );
}

function SourcesPanel({ citations }: { citations: Map<string, Citation> }) {
  if (citations.size === 0) return null;
  return (
    <section className="mt-8 pt-6 border-t border-neutral-200 dark:border-neutral-800">
      <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400 mb-3">
        Sources
      </h2>
      <ul className="space-y-2 text-sm">
        {Array.from(citations.values()).map((c) => (
          <li key={c.chunk_id} className="flex items-start gap-2">
            <span className="px-1.5 py-0.5 text-[0.7rem] font-mono rounded bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300 shrink-0">
              c{c.chunk_id}
            </span>
            <a
              href={c.document_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-700 dark:text-blue-400 hover:underline"
            >
              {c.source_name} — {c.document_title}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

