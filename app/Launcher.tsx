"use client";

import type { GameManifest } from "@101/sdk";
import Link from "next/link";
import { useId, useMemo, useState } from "react";
import InputLab from "./components/InputLab";
import SlashstormGame from "./components/SlashstormGame";

type View = "library" | "lab" | "slashstorm" | "system";

const INPUT_LABELS: Record<string, string> = {
  keyboard: "Keyboard",
  mouse: "Mouse",
  touch: "Touch",
  gamepad: "Gamepad",
  "phone-motion": "Phone motion",
  "watch-motion": "Watch",
  "camera-hand": "Hands",
  "camera-pose": "Body",
  "camera-face": "Head",
  custom: "Custom hardware",
};

export default function Launcher({ games }: { games: GameManifest[] }) {
  const [view, setView] = useState<View>("library");
  const [pairingOpen, setPairingOpen] = useState(false);
  const instanceId = useId();
  const sessionId = `101${instanceId.replace(/[^a-z0-9]/gi, "").toUpperCase()}LAB`.slice(0, 6).padEnd(6, "X");

  const catalog = useMemo(
    () => games.filter((game) => game.id !== "input-lab"),
    [games],
  );

  const navigate = (next: View) => {
    setView(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <main className="site-shell">
      <header className="topbar">
        <button className="wordmark" onClick={() => navigate("library")} aria-label="101 home">
          <span className="mark-block">101</span>
          <span className="mark-label">Local gaming system</span>
        </button>
        <nav className="nav" aria-label="Primary navigation">
          <button className={view === "library" ? "active" : ""} onClick={() => navigate("library")}>Games</button>
          <button className={view === "lab" ? "active" : ""} onClick={() => navigate("lab")}>Input Lab</button>
          <button className={view === "slashstorm" ? "active" : ""} onClick={() => navigate("slashstorm")}>Slashstorm</button>
          <Link href="/network">Network Lab</Link>
          <button className={view === "system" ? "active" : ""} onClick={() => navigate("system")}>The system</button>
        </nav>
        <button className="connect-button" onClick={() => setPairingOpen(true)}>
          <span className="status-dot" /> Connect device
        </button>
      </header>

      {view === "library" && (
        <>
          <section className="hero">
            <div className="hero-copy">
              <p className="eyebrow">Open source · Local first · Browser first</p>
              <h1>Anything can be<br />a controller.</h1>
              <p className="hero-intro">
                101 turns keyboards, phones, watches, cameras and custom hardware into one shared input language—then lets every game speak it.
              </p>
              <div className="hero-actions">
                <button className="primary-button" onClick={() => navigate("slashstorm")}>
                  Play Slashstorm <span aria-hidden="true">↗</span>
                </button>
                <button className="text-button" onClick={() => setPairingOpen(true)}>
                  Try a second-screen controller
                </button>
              </div>
              <div className="local-proof">
                <span className="proof-icon" aria-hidden="true">⌁</span>
                <span><strong>No account. No cloud gameplay.</strong> Your inputs stay on the local path.</span>
              </div>
            </div>
            <div className="hero-system" aria-label="101 input system illustration">
              <div className="system-stage system-stage-inputs">
                <span className="stage-caption">Physical world</span>
                <div className="input-nodes">
                  <span>KEYS</span><span>PHONE</span><span>HAND</span><span>PAD</span><span>WATCH</span><span>DIY</span>
                </div>
              </div>
              <div className="flow-line"><i /><b>normalized events</b><i /></div>
              <div className="bus-card">
                <span className="bus-index">01</span>
                <div><strong>101 INPUT BUS</strong><small>move · aim · slash · pose · trigger</small></div>
                <span className="live-pill">LIVE</span>
              </div>
              <div className="flow-line"><i /><b>one stable API</b><i /></div>
              <div className="game-window">
                <div className="window-top"><span>GAME_101</span><span>60 FPS</span></div>
                <div className="window-field">
                  <span className="orbit orbit-a" /><span className="orbit orbit-b" />
                  <span className="player-core">101</span>
                  <span className="vector-line" />
                </div>
              </div>
              <p className="system-note">The game never needs to know where the action came from.</p>
            </div>
          </section>

          <section className="signal-strip" aria-label="Supported input categories">
            {["Keyboard", "Gamepad", "Phone motion", "Camera", "Watch", "HID / BLE", "Future input"].map((item, index) => (
              <span key={item}><b>{String(index + 1).padStart(2, "0")}</b>{item}</span>
            ))}
          </section>

          <section className="library-section" id="games">
            <div className="section-heading">
              <div><p className="eyebrow">Game library</p><h2>Ten games. One nervous system.</h2></div>
              <p>The catalog is manifest-driven. Input Lab, Network Lab, and the first Slashstorm vertical slice are playable now; the remaining game worlds validate the same engine.</p>
            </div>
            <div className="game-grid">
              <article className="game-card featured-game" style={{ "--accent": "#ff5c35" } as React.CSSProperties}>
                <div className="card-top"><span className="game-number">LAB</span><span className="ready-badge">PLAYABLE</span></div>
                <div className="mini-arena" aria-hidden="true"><span /><i /><b /></div>
                <div className="game-card-copy">
                  <h3>101 Input Lab</h3>
                  <p>See normalized keyboard, pointer, touch, gamepad and second-screen events in one live arena.</p>
                  <div className="input-tags"><span>Keyboard</span><span>Mouse</span><span>Gamepad</span><span>Link preview</span></div>
                </div>
                <button onClick={() => navigate("lab")}>Launch diagnostic <span>↗</span></button>
              </article>

              {catalog.map((game, index) => (
                <article className={`game-card game-${game.id}`} key={game.id} style={{ "--accent": game.accent ?? "#b5ff66" } as React.CSSProperties}>
                  <div className="card-top"><span className="game-number">{String(index + 1).padStart(2, "0")}</span>{game.status === "playable" ? <span className="ready-badge">PLAYABLE</span> : <span className="roadmap-badge">ROADMAP</span>}</div>
                  <div className="game-motif" aria-hidden="true"><span /><i /><b /></div>
                  <div className="game-card-copy">
                    <h3>{game.name}</h3>
                    <p>{game.tagline}</p>
                    <div className="input-tags">
                      {game.inputs.slice(0, 3).map((input) => <span key={input}>{INPUT_LABELS[input] ?? input}</span>)}
                      {game.inputs.length > 3 && <span>+{game.inputs.length - 3}</span>}
                    </div>
                    <div className="preset-status">
                      <span>Playable</span>
                      {game.controllers?.enhanced?.length ? <span>Enhanced available</span> : null}
                      {game.controllers?.immersive?.length ? <span>Immersive available</span> : null}
                    </div>
                  </div>
                  {game.id === "slashstorm" ? <button className="game-card-launch" onClick={() => navigate("slashstorm")}>Launch game <span>↗</span></button> : <div className="card-status"><span>{game.renderer.toUpperCase()}</span><span>{game.players.max}P</span><span>∞</span></div>}
                </article>
              ))}
            </div>
          </section>

          <section className="promise-section">
            <div className="promise-index">101</div>
            <div className="promise-copy"><p className="eyebrow">The promise</p><h2>Game eleven should be dramatically easier to build than game one.</h2></div>
            <button className="outline-button" onClick={() => navigate("system")}>Explore the architecture →</button>
          </section>
        </>
      )}

      {view === "lab" && <InputLab sessionId={sessionId} onConnect={() => setPairingOpen(true)} onExit={() => navigate("library")} />}
      {view === "slashstorm" && <SlashstormGame sessionId={sessionId} onConnect={() => setPairingOpen(true)} onExit={() => navigate("library")} />}
      {view === "system" && <SystemView onLaunch={() => navigate("lab")} />}

      <footer className="footer">
        <div className="mark-block">101</div>
        <p>One local runtime. Almost anything can become a controller.</p>
        <div><span>MIT core</span><span>Offline by design</span><span>Networking + first game</span></div>
      </footer>

      {pairingOpen && <PairingPanel sessionId={sessionId} onClose={() => setPairingOpen(false)} onOpenController={() => { setPairingOpen(false); if (view === "library") navigate("lab"); }} />}
    </main>
  );
}

function PairingPanel({ sessionId, onClose, onOpenController }: { sessionId: string; onClose: () => void; onOpenController: () => void }) {
  const [copied, setCopied] = useState(false);
  const controllerUrl = `/controller?session=${sessionId}`;

  const copy = async () => {
    await navigator.clipboard?.writeText(new URL(controllerUrl, window.location.origin).toString());
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="pairing-panel" role="dialog" aria-modal="true" aria-labelledby="pairing-title">
        <button className="close-button" onClick={onClose} aria-label="Close">×</button>
        <p className="eyebrow">Local browser test path</p>
        <h2 id="pairing-title">Make this browser a controller.</h2>
        <p className="panel-intro">Open the link in another tab in this browser profile. It connects directly to the Input Lab through the transport layer—no account and no database.</p>
        <div className="session-code"><span>SESSION</span><strong>{sessionId}</strong><i>LOCAL</i></div>
        <div className="pair-link"><code>{controllerUrl}</code><button onClick={copy}>{copied ? "Copied" : "Copy"}</button></div>
        <a className="primary-button full-button" href={controllerUrl} target="_blank" rel="noreferrer" onClick={onOpenController}>Open controller in a new tab ↗</a>
        <div className="pairing-scope"><span>✓ Working now: same-browser game controller</span><Link href="/network">Open manual offline WebRTC pairing →</Link></div>
      </section>
    </div>
  );
}

function SystemView({ onLaunch }: { onLaunch: () => void }) {
  const layers = [
    ["01", "101 Games", "Read actions, axes, vectors and poses. Never hardware APIs."],
    ["02", "Game SDK", "A narrow, versioned contract for lifecycle, assets and input."],
    ["03", "Input Bus", "Normalizes sources, rejects stale frames and assigns players."],
    ["04", "Protocol", "Reliable control and disposable realtime channels behind transports."],
    ["05", "Adapters", "Keyboard, pointer and gamepad now; motion, vision and hardware next."],
  ];
  return (
    <section className="system-page">
      <div className="system-page-intro">
        <p className="eyebrow">System model · Phase 1</p>
        <h1>Games speak actions.<br />Adapters speak hardware.</h1>
        <p>That boundary is the product. A new device is added once, and every compatible 101 game can use it without learning a new API.</p>
        <button className="primary-button" onClick={onLaunch}>Test the bus live ↗</button>
      </div>
      <div className="architecture-stack">
        {layers.map(([number, title, copy]) => (
          <article key={number}><span>{number}</span><div><h2>{title}</h2><p>{copy}</p></div><b>↘</b></article>
        ))}
      </div>
      <div className="principles-grid">
        <article><span>LOCAL</span><h3>Private by default</h3><p>Camera, motion and microphone processing remain on the device. No telemetry is required.</p></article>
        <article><span>OPEN</span><h3>Strong foundations</h3><p>Phaser, Three.js, Rapier and Howler sit behind replaceable 101 facades.</p></article>
        <article><span>∞</span><h3>Seeded worlds</h3><p>Procedural directors combine threats, modifiers and pacing—not just higher speed.</p></article>
      </div>
    </section>
  );
}
