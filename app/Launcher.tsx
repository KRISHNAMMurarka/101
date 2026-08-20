"use client";

import type { GameManifest } from "@101/sdk";
import Link from "next/link";
import QRCode from "qrcode";
import { Suspense, lazy, useEffect, useId, useMemo, useState } from "react";
import { getBrowserHostTransport, type BrowserPairingInfo } from "./lib/browser-link";
/**
 * Playable surfaces load on demand, one entry each.
 *
 * These used to be static imports. A static import makes every game a hard dependency of the
 * launcher's own chunk, so opening the library downloaded all ten games — 2.8 MB across 36
 * preloaded chunks, including a 1.6 MB physics engine — before rendering a single card. That cost
 * grows with the catalog, which is the one thing a library of a thousand games cannot afford.
 *
 * This map is also the single place a new surface is registered. Adding one no longer means
 * editing an import list, a union type, and a render chain separately.
 */
const SURFACES = {
  lab: lazy(() => import("./components/InputLab")),
  beatforge: lazy(() => import("./components/BeatForgeGame")),
  bodydodge: lazy(() => import("./components/BodyDodgeGame")),
  echomaze: lazy(() => import("./components/EchoMazeGame")),
  gravitystack: lazy(() => import("./components/GravityStackGame")),
  orbitalcrew: lazy(() => import("./components/OrbitalCrewGame")),
  shadowarena: lazy(() => import("./components/ShadowArenaGame")),
  slashstorm: lazy(() => import("./components/SlashstormGame")),
  spellcaster: lazy(() => import("./components/SpellcasterGame")),
  swarmcommander: lazy(() => import("./components/SwarmCommanderGame")),
  tiltdrift: lazy(() => import("./components/TiltDriftGame")),
} as const;

type View = "library" | "lab" | "slashstorm" | "tiltdrift" | "bodydodge" | "orbitalcrew" | "beatforge" | "gravitystack" | "spellcaster" | "echomaze" | "shadowarena" | "swarmcommander" | "system";

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
  const generatedSessionId = `101${instanceId.replace(/[^a-z0-9]/gi, "").toUpperCase()}LAB`.slice(0, 6).padEnd(6, "X");
  const [sessionId] = useState(() => {
    if (typeof window === "undefined") return generatedSessionId;
    const requested = new URLSearchParams(window.location.search).get("session")?.trim();
    return requested && /^[A-Z0-9-]{4,128}$/i.test(requested) ? requested : generatedSessionId;
  });

  // `library` and `system` render inline; every other view is a code-split surface.
  const Surface = view in SURFACES ? SURFACES[view as keyof typeof SURFACES] : undefined;

  const catalog = useMemo(
    () => games.filter((game) => game.id !== "input-lab"),
    [games],
  );

  const navigate = (next: View) => {
    setView(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const launchGame = (id: string) => {
    if (isPlayableView(id)) navigate(id);
  };

  return (
    <main className="site-shell">
      <header className="topbar">
        <button className="wordmark" onClick={() => navigate("library")} aria-label="101 home">
          <span className="mark-block">101</span>
          <span className="mark-label">Local gaming system</span>
        </button>
        {/*
          A navigation bar carries destinations, not an inventory. Listing all ten games here
          duplicated the grid directly below it and pushed the row to seventeen items, so the one
          control that matters — Connect device — competed with sixteen others. Games live in the
          grid, the six diagnostics collapse into one menu, and the bar is three items again.
        */}
        <nav className="nav" aria-label="Primary navigation">
          <button className={view === "library" ? "active" : ""} onClick={() => navigate("library")}>Games</button>
          <details className="nav-menu">
            <summary>Labs</summary>
            <div className="nav-menu-items">
              <button className={view === "lab" ? "active" : ""} onClick={() => navigate("lab")}>Input</button>
              <Link href="/motion">Motion</Link>
              <Link href="/vision">Vision</Link>
              <Link href="/network">Network</Link>
              <Link href="/controller-lab">Controller</Link>
              <Link href="/hardware">Hardware</Link>
            </div>
          </details>
          <button className={view === "system" ? "active" : ""} onClick={() => navigate("system")}>System</button>
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
              <p>The catalog is manifest-driven. All ten playable games now share the same engine, role-aware session host, procedural systems, and normalized controls.</p>
            </div>
            <div className="game-grid">
              <article className="game-card featured-game">
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
                <article className={`game-card game-${game.id}`} key={game.id}>
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
                  {isPlayableView(game.id) ? <button className="game-card-launch" onClick={() => launchGame(game.id)}>Launch game <span>↗</span></button> : <div className="card-status"><span>{game.renderer.toUpperCase()}</span><span>{game.players.max}P</span><span>∞</span></div>}
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

      {Surface ? (
        <Suspense fallback={<p className="surface-loading">Loading…</p>}>
          <Surface sessionId={sessionId} onConnect={() => setPairingOpen(true)} onExit={() => navigate("library")} />
        </Suspense>
      ) : null}
      {view === "system" && <SystemView onLaunch={() => navigate("lab")} />}

      <footer className="footer">
        <div className="mark-block">101</div>
        <p>One local runtime. Almost anything can become a controller.</p>
        <div><span>MIT core</span><span>Offline by design</span><span>Motion · vision · ten games</span></div>
      </footer>

      {pairingOpen && <PairingPanel sessionId={sessionId} onClose={() => setPairingOpen(false)} onOpenController={() => { setPairingOpen(false); if (view === "library") navigate("lab"); }} />}
    </main>
  );
}

function PairingPanel({ sessionId, onClose, onOpenController }: { sessionId: string; onClose: () => void; onOpenController: () => void }) {
  const [copied, setCopied] = useState(false);
  const [pairing, setPairing] = useState<BrowserPairingInfo>();
  const [qrCode, setQrCode] = useState("");
  const [hubError, setHubError] = useState("");
  const controllerUrl = `/controller?session=${sessionId}`;

  useEffect(() => {
    let current = true;
    getBrowserHostTransport(sessionId).preparePairing().then(async (info) => {
      const image = await QRCode.toDataURL(info.controllerUrl, { width: 280, margin: 2, errorCorrectionLevel: "M", // The QR library needs literal hex, not a CSS variable, so these mirror --ink and --paper.
        color: { dark: "#0a0a0a", light: "#f2f2f2" } });
      if (!current) return;
      setPairing(info);
      setQrCode(image);
      setHubError("");
    }).catch((error) => {
      if (current) setHubError(error instanceof Error ? error.message : "Local Hub unavailable");
    });
    return () => { current = false; };
  }, [sessionId]);

  const copy = async () => {
    await navigator.clipboard?.writeText(pairing?.controllerUrl ?? new URL(controllerUrl, window.location.origin).toString());
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="pairing-panel" role="dialog" aria-modal="true" aria-labelledby="pairing-title">
        <button className="close-button" onClick={onClose} aria-label="Close">×</button>
        <p className="eyebrow">Strict-local pairing</p>
        <h2 id="pairing-title">Scan once. Control every game.</h2>
        <p className="panel-intro">101 Hub exchanges a short-lived WebRTC offer on your LAN. The controller stays paired while games replace its role and JSON-defined panel—no account or cloud signaling.</p>
        {/* A generated data URL is intentionally rendered directly; it never leaves the local browser. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {qrCode ? <img className="pairing-qr" src={qrCode} alt={`QR code for local session ${sessionId}`} /> : <div className="pairing-qr pending"><span>{hubError ? "HUB OFFLINE" : "PREPARING QR"}</span></div>}
        <div className="session-code"><span>SESSION</span><strong>{sessionId}</strong><i>LOCAL</i></div>
        <div className="pair-link"><code>{pairing?.controllerUrl ?? controllerUrl}</code><button onClick={copy}>{copied ? "Copied" : "Copy"}</button></div>
        {hubError && <p className="pairing-error">Start <code>npm run hub</code>, then reopen this panel. {hubError}</p>}
        {pairing && <p className="pairing-ready">LAN WEBRTC READY · {pairing.hubEndpoint}</p>}
        <a className="primary-button full-button" href={pairing?.controllerUrl ?? controllerUrl} target="_blank" rel="noreferrer" onClick={onOpenController}>Open 101 Link ↗</a>
        <div className="pairing-scope"><span>✓ Working now: same-browser game controller</span><span>✓ Automatic LAN WebRTC + reconnect</span><Link href="/network">Manual serverless pairing →</Link></div>
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
    ["05", "Adapters", "Keyboard, pointer, gamepad, calibrated motion and local camera pose now; hardware next."],
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

function isPlayableView(id: string): id is Extract<View, "slashstorm" | "tiltdrift" | "bodydodge" | "orbitalcrew" | "beatforge" | "gravitystack" | "spellcaster" | "echomaze" | "shadowarena" | "swarmcommander"> {
  return id === "slashstorm" || id === "tiltdrift" || id === "bodydodge" || id === "orbitalcrew" || id === "beatforge" || id === "gravitystack" || id === "spellcaster" || id === "echomaze" || id === "shadowarena" || id === "swarmcommander";
}
