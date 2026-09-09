"use client";

import { useEffect, useId, useRef } from "react";
import { Icon } from "./Icon";

/** A completed run has one next action; announce the result and put it within keyboard reach. */
export default function GameOverPanel({ title, score, detail = "Final score", onRestart }: {
  title: string;
  score: number;
  detail?: string;
  onRestart(): void;
}) {
  const summaryId = useId();
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => { button.current?.focus({ preventScroll: true }); }, []);
  return (
    <section className="game-over-panel" aria-label="Run complete">
      <div id={summaryId}><p>{title}</p><h2>{score.toLocaleString()}</h2><span>{detail}</span></div>
      <button ref={button} type="button" className="primary-button" aria-describedby={summaryId} onClick={onRestart}>
        Play again <Icon name="arrow" size={16} />
      </button>
    </section>
  );
}
