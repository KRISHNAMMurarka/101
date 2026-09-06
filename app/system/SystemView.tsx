"use client";

import Link from "next/link";

import { Icon } from "../components/Icon";

/**
 * The system model. Previously reachable only as `view === "system"` inside Launcher's state
 * union — no URL, no way to link it, and gone entirely on a phone with the rest of the navigation.
 */
export default function SystemView() {
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
        <Link className="primary-button" href="/input">Test the bus live <Icon name="arrow" size={16} /></Link>
      </div>
      <div className="architecture-stack">
        {layers.map(([number, title, copy]) => (
          <article key={number}><span>{number}</span><div><h2>{title}</h2><p>{copy}</p></div><b>↘</b></article>
        ))}
      </div>
      <div className="principles-grid">
        <article><span>LOCAL</span><h3>Private by default</h3><p>Camera, motion and microphone processing remain on the device. No telemetry is required.</p></article>
        <article><span>OPEN</span><h3>Strong foundations</h3><p>Phaser, Three.js, Rapier and Howler sit behind replaceable 101 facades.</p></article>
        <article><span>SEEDED</span><h3>Seeded worlds</h3><p>Procedural directors combine threats, modifiers and pacing—not just higher speed.</p></article>
      </div>
    </section>
  );
}
