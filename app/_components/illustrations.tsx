"use client";

/**
 * Operator-console illustrations.
 *
 *   FlowGraph — animated request-flow diagram for the hero
 *   Spark      — tiny sparkline used in corpus cells
 *   Prompt     — small command-line prompt glyph
 */
import { useEffect, useRef, useState } from "react";

interface NodeDef {
  x: number;
  y: number;
  label: string;
  sub: string;
  color: string;
}

export function FlowGraph() {
  const ref = useRef<SVGSVGElement | null>(null);
  const [t, setT] = useState(0);

  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      setT(((now - start) / 1000) % 4);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const N: Record<string, NodeDef> = {
    client: { x: 60, y: 110, label: "CLIENT", sub: "browser/app", color: "var(--cyan)" },
    edge: { x: 180, y: 110, label: "EDGE", sub: "anycast · 312 PoP", color: "var(--cyan)" },
    lb: { x: 320, y: 110, label: "L7-LB", sub: "consistent-hash", color: "var(--tx-2)" },
    api: { x: 460, y: 60, label: "API-α", sub: "stateless", color: "var(--tx-2)" },
    api2: { x: 460, y: 160, label: "API-β", sub: "stateless", color: "var(--tx-2)" },
    queue: { x: 600, y: 60, label: "QUEUE", sub: "at-least-once", color: "var(--amber)" },
    store: { x: 600, y: 160, label: "PG-WAL", sub: "primary", color: "var(--acid)" },
    replica: { x: 720, y: 230, label: "REPLICA", sub: "lag 12ms", color: "var(--tx-3)" },
  };

  const edges: Array<[string, string, number]> = [
    ["client", "edge", 0.0],
    ["edge", "lb", 0.4],
    ["lb", "api", 0.8],
    ["lb", "api2", 0.8],
    ["api", "queue", 1.4],
    ["api", "store", 1.4],
    ["api2", "store", 1.6],
    ["store", "replica", 2.2],
  ];

  const W = 760;
  const H = 300;

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      height="100%"
      preserveAspectRatio="xMidYMid meet"
      style={{ display: "block", padding: "44px 16px 56px", maxWidth: "100%" }}
      aria-label="Animated request-flow diagram across edge, load balancer, application, queue, and storage layers."
    >
      <g stroke="var(--line-2)" strokeWidth="0.4" opacity="0.35">
        {Array.from({ length: Math.ceil(W / 24) }).map((_, i) => (
          <line key={"v" + i} x1={i * 24} y1="0" x2={i * 24} y2={H} />
        ))}
        {Array.from({ length: Math.ceil(H / 24) }).map((_, i) => (
          <line key={"h" + i} x1="0" y1={i * 24} x2={W} y2={i * 24} />
        ))}
      </g>

      <g stroke="var(--line-3)" strokeWidth="1" fill="none">
        {edges.map(([from, to], i) => {
          const a = N[from];
          const b = N[to];
          const mx = (a.x + b.x) / 2;
          const d = `M ${a.x} ${a.y} L ${mx} ${a.y} L ${mx} ${b.y} L ${b.x} ${b.y}`;
          return <path key={i} d={d} />;
        })}
      </g>

      <g>
        {edges.map(([from, to, start], i) => {
          const a = N[from];
          const b = N[to];
          const mx = (a.x + b.x) / 2;
          const local = t - start;
          if (local < 0 || local > 0.9) return null;
          const k = Math.min(1, local / 0.9);
          let x: number;
          let y: number;
          if (k < 0.4) {
            const kk = k / 0.4;
            x = a.x + (mx - a.x) * kk;
            y = a.y;
          } else if (k < 0.6) {
            const kk = (k - 0.4) / 0.2;
            x = mx;
            y = a.y + (b.y - a.y) * kk;
          } else {
            const kk = (k - 0.6) / 0.4;
            x = mx + (b.x - mx) * kk;
            y = b.y;
          }
          return (
            <g key={i}>
              <circle cx={x} cy={y} r="3" fill="var(--acid)" opacity="0.95" />
              <circle cx={x} cy={y} r="6" fill="var(--acid)" opacity="0.18" />
            </g>
          );
        })}
      </g>

      <g>
        {Object.entries(N).map(([k, n]) => (
          <g key={k} transform={`translate(${n.x}, ${n.y})`}>
            <rect x="-44" y="-18" width="88" height="36" rx="2" fill="var(--panel-2)" stroke={n.color} strokeWidth="1" />
            <text x="0" y="-2" textAnchor="middle" fontSize="10" fontFamily="var(--mono)" fill="var(--tx)" letterSpacing="0.06em" fontWeight="600">
              {n.label}
            </text>
            <text x="0" y="11" textAnchor="middle" fontSize="8" fontFamily="var(--mono)" fill="var(--tx-3)" letterSpacing="0.04em">
              {n.sub}
            </text>
            <g stroke={n.color} strokeWidth="1" opacity="0.85">
              <line x1="-44" y1="-18" x2="-40" y2="-18" />
              <line x1="-44" y1="-18" x2="-44" y2="-14" />
              <line x1="44" y1="-18" x2="40" y2="-18" />
              <line x1="44" y1="-18" x2="44" y2="-14" />
              <line x1="-44" y1="18" x2="-40" y2="18" />
              <line x1="-44" y1="18" x2="-44" y2="14" />
              <line x1="44" y1="18" x2="40" y2="18" />
              <line x1="44" y1="18" x2="44" y2="14" />
            </g>
          </g>
        ))}
      </g>

      <g fontFamily="var(--mono)" fontSize="9" fill="var(--tx-4)" letterSpacing="0.08em">
        {(
          [
            [N.client.x, "L0"],
            [N.edge.x, "L1"],
            [N.lb.x, "L2"],
            [N.api.x, "L3"],
            [N.queue.x, "L4"],
            [N.replica.x, "L5"],
          ] as [number, string][]
        ).map(([x, l], i) => (
          <text key={i} x={x} y={H - 6} textAnchor="middle">
            {l}
          </text>
        ))}
      </g>

      <line x1="40" y1={H - 22} x2={W - 30} y2={H - 22} stroke="var(--line-2)" strokeWidth="0.6" />
    </svg>
  );
}

/** Deterministic sparkline used in corpus cells. */
export function Spark({ seed = 1, color = "var(--cyan)" }: { seed?: number; color?: string }) {
  const W = 140;
  const H = 18;
  const N = 22;
  const pts: [number, number][] = [];
  let v = 0.5;
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * W;
    const r = Math.sin(seed * 13.37 + i * 1.7) * 0.5 + Math.cos(seed * 4.4 + i * 0.9) * 0.3;
    v = Math.max(0.1, Math.min(0.95, v + r * 0.18));
    pts.push([x, H - v * (H - 4) - 2]);
  }
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: "block" }}>
      <path d={d} fill="none" stroke={color} strokeWidth="1" opacity="0.85" />
      <circle cx={last[0]} cy={last[1]} r="1.6" fill={color} />
    </svg>
  );
}

export function Prompt() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path
        d="M2 3 L6 7 L2 11"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line x1="7" y1="11" x2="12" y2="11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
