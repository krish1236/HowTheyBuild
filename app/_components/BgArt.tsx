"use client";

/**
 * Ambient background layer. Renders behind everything (z-index: 0).
 * Six layers, in CSS-driven motion:
 *   1. Drifting cross grid
 *   2. Pulsing concentric rings (top-right + bottom-left)
 *   3. Topographic contour lines
 *   4. Streaming "packet" lines across the viewport
 *   5. Slow vertical scanline sweep
 *   6. Corner telemetry HUD with live clock
 */
import { useEffect, useState } from "react";

function Topo() {
  const W = 1600;
  const H = 900;
  const lines: string[] = [];
  for (let row = 0; row < 11; row++) {
    const y0 = (row / 10) * H;
    const amp = 26 + (row % 3) * 14;
    const freq = 0.0035 + (row % 4) * 0.0008;
    const phase = row * 0.7;
    let d = `M 0 ${y0.toFixed(1)}`;
    for (let x = 0; x <= W; x += 24) {
      const y =
        y0 +
        Math.sin(x * freq + phase) * amp +
        Math.cos(x * freq * 1.7 + phase * 0.6) * (amp * 0.35);
      d += ` L ${x} ${y.toFixed(1)}`;
    }
    lines.push(d);
  }
  return (
    <svg
      className="bg-art__topo"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid slice"
      xmlns="http://www.w3.org/2000/svg"
    >
      {lines.map((d, i) => (
        <path
          key={i}
          d={d}
          fill="none"
          stroke="currentColor"
          strokeWidth={i % 4 === 0 ? 0.7 : 0.4}
          opacity={0.25 + (i % 4 === 0 ? 0.25 : 0)}
        />
      ))}
    </svg>
  );
}

function Rings({ className }: { className?: string }) {
  return (
    <svg
      className={"bg-art__rings " + (className || "")}
      viewBox="0 0 600 600"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g>
        <circle cx="300" cy="300" />
        <circle cx="300" cy="300" />
        <circle cx="300" cy="300" />
        <circle cx="300" cy="300" />
        <circle cx="300" cy="300" />
      </g>
      <circle
        cx="300"
        cy="300"
        r="120"
        fill="none"
        stroke="currentColor"
        strokeWidth="0.6"
        opacity="0.18"
        strokeDasharray="2 5"
      />
      <circle
        cx="300"
        cy="300"
        r="240"
        fill="none"
        stroke="currentColor"
        strokeWidth="0.6"
        opacity="0.12"
        strokeDasharray="2 8"
      />
      <g stroke="currentColor" strokeWidth="0.6" opacity="0.35">
        <line x1="280" y1="300" x2="320" y2="300" />
        <line x1="300" y1="280" x2="300" y2="320" />
      </g>
    </svg>
  );
}

function Packets() {
  const lanes = [
    { top: "12%", dur: 11, delay: 0, w: 110, alt: false },
    { top: "23%", dur: 9, delay: 2.4, w: 70, alt: true },
    { top: "37%", dur: 14, delay: 4.0, w: 140, alt: false },
    { top: "48%", dur: 8, delay: 1.2, w: 60, alt: true },
    { top: "61%", dur: 12, delay: 5.6, w: 90, alt: false },
    { top: "72%", dur: 10, delay: 3.0, w: 80, alt: true },
    { top: "84%", dur: 13, delay: 7.2, w: 120, alt: false },
    { top: "92%", dur: 9.5, delay: 0.8, w: 65, alt: true },
  ];
  return (
    <div className="bg-art__packets">
      {lanes.map((l, i) => (
        <div
          key={i}
          className={"packet" + (l.alt ? " alt" : "")}
          style={
            {
              top: l.top,
              width: `${l.w}px`,
              "--dur": `${l.dur}s`,
              "--delay": `${l.delay}s`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}

function CornerHUD() {
  // SSR-safe: render an empty placeholder on the server, fill in on mount.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!now) {
    return (
      <>
        <div className="bg-art__corner tl" />
        <div className="bg-art__corner tr" />
        <div className="bg-art__corner bl" />
        <div className="bg-art__corner br" />
      </>
    );
  }
  const t = now.toISOString().slice(11, 19) + "Z";
  const tps = 138 + Math.round(Math.sin(now.getSeconds() * 0.6) * 14);
  return (
    <>
      <div className="bg-art__corner tl">
        sys.t <span className="v">{t}</span>
      </div>
      <div className="bg-art__corner tr">
        idx.tps <span className="v">{tps}</span>·s⁻¹
      </div>
      <div className="bg-art__corner bl">node us-east-1 · region a</div>
      <div className="bg-art__corner br">build 2026.05.10 · ok</div>
    </>
  );
}

export function BgArt() {
  return (
    <div className="bg-art" aria-hidden="true">
      <Topo />
      <div className="bg-art__grid" />
      <Rings />
      <Rings className="bg-art__rings-2" />
      <Packets />
      <div className="bg-art__scan" />
      <CornerHUD />
    </div>
  );
}
