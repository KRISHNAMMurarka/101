"use client";

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { DynamicControllerDeck } from "../controller/Controller";
import type { ControllerHostBinding } from "../lib/use-game-host";
import type { GameControllerRole } from "@101/sdk";
import { GameControllerInput } from "./game-controller-input";
import { Icon } from "./Icon";
import styles from "./GameControllerOverlay.module.css";

/** A reserved strip below the existing play field, included in that field's fullscreen wrapper. */
export default function GameControllerOverlay({ binding, children, runComplete = false }: { binding: ControllerHostBinding | null; children: ReactNode; runComplete?: boolean }) {
  const [open, setOpen] = useState(false);
  const expanded = open && !runComplete;
  const [selected, setSelected] = useState("");
  const id = useId();
  const frameRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLElement>(null);
  const role = binding?.roles.find((candidate) => candidate.id === selected) ?? binding?.roles[0];

  useEffect(() => {
    const frame = frameRef.current; const dock = dockRef.current;
    if (!frame || !dock) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) frame.style.setProperty("--dock-height", `${Math.ceil(entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height)}px`);
    });
    observer.observe(dock);
    return () => observer.disconnect();
  }, []);

  return (
    <div className={styles.frame} data-game-frame data-controls-open={expanded ? "true" : "false"} ref={frameRef}>
      <div className={styles.playfield}>{children}</div>
      {/* Keep child control keys from also driving the game through its window keyboard listener. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <section className={styles.dock} aria-label="Controls on this screen" ref={dockRef}
        onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") setOpen(false); }}
        onKeyUp={(event) => event.stopPropagation()}>
        <div className={styles.toolbar}>
          <button className="outline-button" type="button" disabled={!role || runComplete} aria-expanded={expanded} aria-controls={id} onClick={() => setOpen((value) => !value)}>
            <Icon name="gamepad" size={18} /> {expanded ? "Hide controls" : "Show controls"}
          </button>
          {expanded && role && binding && (binding.roles.length > 1
            ? <label className={styles.role}>Play as <select value={role.id} onChange={(event) => setSelected(event.target.value)}>{binding.roles.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
            : <span className={styles.role}>{role.label}</span>)}
        </div>
        <div id={id} hidden={!expanded} className={styles.deck}>
          {expanded && role && binding && <LocalDeck key={role.id} binding={binding} role={role} />}
        </div>
      </section>
    </div>
  );
}

function LocalDeck({ binding, role }: { binding: ControllerHostBinding; role: GameControllerRole }) {
  const id = useId();
  const input = useMemo(() => new GameControllerInput(binding.host.inputBus, role, `screen-controls-${id}`), [binding.host, role, id]);
  const snapshot = useSyncExternalStore(input.subscribe, input.getSnapshot, input.getSnapshot);
  const [releaseRevision, setReleaseRevision] = useState(0);
  useEffect(() => {
    input.start();
    const release = () => { input.release(); setReleaseRevision((revision) => revision + 1); };
    const visibility = () => { if (document.hidden) release(); };
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", visibility);
    return () => { window.removeEventListener("blur", release); document.removeEventListener("visibilitychange", visibility); input.stop(); };
  }, [input]);
  return <DynamicControllerDeck key={releaseRevision} elements={role.layout.layout}
    actions={snapshot.actions} axes={snapshot.axes} vectors={snapshot.vectors}
    authoredHandedness={role.layout.handedness ?? "right"} playerHandedness={role.layout.handedness ?? "right"}
    setActions={input.setActions} setAction={input.setAction} setAxis={input.setAxis} setVector={input.setVector}
    haptic={() => undefined} />;
}
