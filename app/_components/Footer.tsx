"use client";

export function Footer() {
  return (
    <div className="shell">
      <footer className="foot">
        <span>HOWTHEYBUILD · CITATION-FIRST Q&amp;A · BUILD 2026.05.10</span>
        <span className="foot__r">
          <a href="#" onClick={(e) => e.preventDefault()}>status</a>
          <span className="sep">·</span>
          <a href="#" onClick={(e) => e.preventDefault()}>changelog</a>
          <span className="sep">·</span>
          <a
            href="https://github.com/krish1236/HowTheyBuild"
            target="_blank"
            rel="noopener noreferrer"
          >
            github
          </a>
          <span className="sep">·</span>
          <a href="#" onClick={(e) => e.preventDefault()}>suggest a source</a>
        </span>
      </footer>
    </div>
  );
}
