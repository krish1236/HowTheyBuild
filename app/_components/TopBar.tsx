"use client";

interface TopBarProps {
  onHome: () => void;
  screen: "home" | "answer";
  /** Optional: total chunks in corpus, shown in the right-side status row. */
  corpusCount?: number;
}

export function TopBar({ onHome, screen, corpusCount }: TopBarProps) {
  return (
    <header className="tbar">
      <div className="tbar__left">
        <a
          href="#"
          className="tbar__brand"
          onClick={(e) => {
            e.preventDefault();
            onHome();
          }}
        >
          <span className="dot" /> howtheybuild
          <span className="v">/ v0.5.0</span>
        </a>
      </div>
      <nav className="tbar__center" aria-label="primary">
        <button
          className={"tbar__tab " + (screen === "home" ? "is-active" : "")}
          onClick={onHome}
        >
          ~/ ask
        </button>
        <a className="tbar__tab" href="#" onClick={(e) => e.preventDefault()}>
          ~/ corpus <span className="k">C</span>
        </a>
        <a className="tbar__tab" href="#" onClick={(e) => e.preventDefault()}>
          ~/ history
        </a>
        <a className="tbar__tab" href="#" onClick={(e) => e.preventDefault()}>
          ~/ about
        </a>
      </nav>
      <div className="tbar__right">
        <span className="tbar__stat">
          <span className="led" /> sys ok
        </span>
        {corpusCount != null && (
          <span className="tbar__stat">
            corpus <b>{corpusCount.toLocaleString()}</b>
          </span>
        )}
        <span className="tbar__stat">
          <span className="led led--cyan" /> idx <b>fresh</b>
        </span>
      </div>
    </header>
  );
}
