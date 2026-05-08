/**
 * SSE consumer hook for /api/query.
 *
 * Uses `fetch` + `ReadableStream` rather than `EventSource` because the
 * EventSource API only supports GET. We POST a JSON body and parse the
 * server-sent-events frame format ourselves.
 *
 * Frame format we accept:
 *   event: <name>\n
 *   data: <json>\n
 *   \n
 * (We ignore comments, retry directives, and `id:` lines for V1.)
 *
 * Cancellation: an internal AbortController is exposed via `cancel()` and
 * fires automatically on unmount. The server-side route handles the
 * disconnect via Module 6's cancel-on-disconnect path.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface Citation {
  chunk_id: string;
  source_name: string;
  document_title: string;
  document_url: string;
  breadcrumb: string;
}

export interface MetaInfo {
  rewritten_query: string | null;
  retrieved: number;
  reranked: number;
  top_rerank_score: number | null;
}

export interface DoneInfo {
  status: "answer" | "refused";
  refused: boolean;
  refusal_reason: string | null;
  ttft_ms: number | null;
  total_ms: number;
  cost_usd: number;
}

export interface ErrorInfo {
  code: string;
  message: string;
}

export type StreamPhase = "idle" | "connecting" | "streaming" | "done" | "error" | "aborted";

export interface QueryStreamState {
  phase: StreamPhase;
  meta: MetaInfo | null;
  text: string;
  citations: Map<string, Citation>;
  done: DoneInfo | null;
  error: ErrorInfo | null;
}

const initialState: QueryStreamState = {
  phase: "idle",
  meta: null,
  text: "",
  citations: new Map(),
  done: null,
  error: null,
};

export function useQueryStream() {
  const [state, setState] = useState<QueryStreamState>(initialState);
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  useEffect(() => {
    return () => cancel();
  }, [cancel]);

  const submit = useCallback(
    async (query: string) => {
      // Cancel any in-flight request before starting a new one.
      cancel();
      const controller = new AbortController();
      abortRef.current = controller;

      setState({
        phase: "connecting",
        meta: null,
        text: "",
        citations: new Map(),
        done: null,
        error: null,
      });

      try {
        const res = await fetch("/api/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          let err: ErrorInfo = {
            code: "http_error",
            message: `HTTP ${res.status}`,
          };
          try {
            const json = (await res.json()) as { error?: ErrorInfo };
            if (json.error) err = json.error;
          } catch {
            /* ignore — keep default message */
          }
          setState((s) => ({ ...s, phase: "error", error: err }));
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE frames are separated by a blank line.
          let sep: number;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            handleFrame(frame, setState);
          }
        }
      } catch (err) {
        if (controller.signal.aborted) {
          setState((s) => ({ ...s, phase: "aborted" }));
        } else {
          const message = err instanceof Error ? err.message : "network error";
          setState((s) => ({
            ...s,
            phase: "error",
            error: { code: "network_error", message },
          }));
        }
      }
    },
    [cancel],
  );

  return { state, submit, cancel };
}

function handleFrame(
  frame: string,
  setState: React.Dispatch<React.SetStateAction<QueryStreamState>>,
) {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7).trim();
    else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
    // ignore other directives
  }
  if (dataLines.length === 0) return;
  const dataStr = dataLines.join("\n");
  let data: unknown;
  try {
    data = JSON.parse(dataStr);
  } catch {
    return;
  }

  switch (event) {
    case "meta":
      setState((s) => ({ ...s, phase: "streaming", meta: data as MetaInfo }));
      break;
    case "token": {
      const text = (data as { text: string }).text;
      setState((s) => ({ ...s, text: s.text + text }));
      break;
    }
    case "citation": {
      const c = data as Citation;
      setState((s) => {
        const next = new Map(s.citations);
        next.set(c.chunk_id, c);
        return { ...s, citations: next };
      });
      break;
    }
    case "done":
      setState((s) => ({ ...s, phase: "done", done: data as DoneInfo }));
      break;
    case "error":
      setState((s) => ({ ...s, phase: "error", error: data as ErrorInfo }));
      break;
  }
}
