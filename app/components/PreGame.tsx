"use client";

import QRCode from "qrcode";
import Link from "next/link";
import { useEffect, useState } from "react";

import type { InputSource } from "@101/input";
import type { SessionRole } from "@101/session";
import type { GameManifest } from "@101/sdk";

import CameraSetup from "./camera/CameraSetup";
import { GamePoster } from "./GamePoster";
import { Icon } from "./Icon";
import { getBrowserHostTransport, type BrowserPairingInfo } from "../lib/browser-link";
import { CATALOG_INPUT_LABELS, playableWithSources } from "../lib/catalog";
import type { CameraKind } from "../lib/camera-plan";
import { recallCameraSetup } from "../lib/camera-setup";
import { useLocalDevice } from "../lib/local-capabilities";
import { useSessionId } from "../lib/session-id";

/**
 * The screen a game opens on, before it starts.
 *
 * Pressing Play used to drop a player straight into a running game. For several of these that is the
 * wrong moment to arrive: Echo Maze routes private clues to a phone and Orbital Crew runs stations on
 * separate screens, so the player met a notice telling them to pair something while the game was
 * already going. The question — how do you want to play this — has to come first.
 *
 * The game is held at the gate by not mounting it. `useGameHost` launches from a `useEffect` with no
 * condition in it, so a mounted game is a running game; the chooser and the game therefore live at
 * two URLs rather than behind one flag. That also keeps every rendered-HTML assertion pointable at a
 * real address, which a same-URL state flag would not.
 *
 * Nothing here is written per game. Every option is derived from that game's own manifest and roles,
 * so a game added tomorrow gets a correct screen without anyone editing this file.
 */
export default function PreGame({
  manifest,
  requires,
  roles,
}: {
  manifest: GameManifest;
  requires: readonly (readonly InputSource[])[];
  roles: readonly SessionRole[];
}) {
  const sessionId = useSessionId();
  const { sources } = useLocalDevice();
  const [pairingOpen, setPairingOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);

  /*
   * Whether a camera is worth offering, which is three separate questions.
   *
   * The game has to declare one as an immersive controller; this device has to have one the probe
   * actually found, rather than a getUserMedia function that exists; and the browser has to be able
   * to open it at all. Offering a camera the game ignores is a minute of somebody's time spent on
   * nothing, which is what the manifest contract test exists to prevent.
   */
  const cameraSource = (manifest.controllers?.immersive ?? [])
    .find((source: InputSource) => source === "camera-pose" || source === "camera-hand");
  const cameraKind: CameraKind | undefined = cameraSource === "camera-pose" ? "body" : cameraSource === "camera-hand" ? "hands" : undefined;
  const cameraHere = cameraKind !== undefined && sources.includes(cameraSource!);

  const playHref = sessionId ? `/games/${manifest.id}/play?session=${sessionId}` : `/games/${manifest.id}/play`;

  /*
   * What this screen can say about the device it is on.
   *
   * Empty until the probe has run — which includes the server render and the first paint — and an
   * unmeasured device must not be described. Printing a device list nobody measured is the same
   * mistake as the gamepad claim that read "Ready on this device" for games that were not.
   */
  const onThisScreen = (manifest.controllers?.basic ?? manifest.inputs)
    .filter((source: InputSource) => sources.includes(source))
    .map((source: InputSource) => CATALOG_INPUT_LABELS[source]);

  /*
   * Whether this screen alone can serve every control the game needs.
   *
   * Before the probe has run there is nothing measured, and an unmeasured device must not be told it
   * cannot play — so the option stays open until there is a reason to close it. No shipped game can
   * be blocked here, since all ten run on a bare keyboard; this is for a game 101 did not write.
   */
  const measured = sources.length > 0;
  const playableHere = !measured || playableWithSources({ requires }, sources);

  // players.max is what the manifest wishes for; roles are what the session can actually fill.
  // Orbital Crew declares six and defines five stations, and a sixth seat could never be occupied.
  const seats = Math.min(manifest.players.max, Math.max(roles.length, 1));
  const phoneRole = roles[0];

  return (
    <main className="pre-game">
      {/* The chooser is arrived at from the library, so it needs the same way back a game has.
          Without it the only exit was the rail, which is a different gesture from the one that
          brought you here. */}
      <Link className="back-button pre-game-back" href="/">
        <Icon name="back" size={16} />Back
      </Link>

      <header className="pre-game-head">
        <GamePoster id={manifest.id} title={manifest.name} />
        <div>
          <h1>{manifest.name}</h1>
          {manifest.tagline && <p>{manifest.tagline}</p>}
        </div>
      </header>

      <h2 className="pre-game-question">How do you want to play?</h2>

      {cameraOpen && cameraKind && sessionId ? (
        <CameraSetup
          kind={cameraKind}
          sessionId={sessionId}
          playHref={`${playHref}${playHref.includes("?") ? "&" : "?"}camera=${cameraKind}`}
          // A game that has you dodging on your feet needs your legs in shot; one you play with your
          // hands at a desk does not, and asking for them would push you out of your own reach.
          needsLegs={cameraKind === "body"}
          onCancel={() => setCameraOpen(false)}
        />
      ) : (
      <div className="pre-game-options">
        <article className="pre-game-option">
          <Icon name="keyboard" size={24} />
          <h3>On this screen</h3>
          <p>
            {playableHere
              ? onThisScreen.length > 0 ? `${onThisScreen.join(", ")}. Nothing to connect.` : "Nothing to connect."
              : "This game needs a control this screen cannot provide. Connect a phone to play it."}
          </p>
          {playableHere
            ? <Link className="primary-button" href={playHref}>Start <Icon name="arrow" size={16} /></Link>
            : <Link className="outline-button needs-device" href={playHref}>Start anyway <Icon name="arrow" size={16} /></Link>}
        </article>

        {phoneRole && (
          <article className="pre-game-option">
            <Icon name="phone-motion" size={24} />
            <h3>With a phone</h3>
            <p>{phoneRole.layout.motion?.label ?? phoneRole.layout.title}</p>
            <button className="outline-button" onClick={() => setPairingOpen((open) => !open)} aria-expanded={pairingOpen}>
              {pairingOpen ? "Hide the code" : "Connect a phone"} <Icon name={pairingOpen ? "close" : "plus"} size={16} />
            </button>
          </article>
        )}

        {seats > 1 && (
          <article className="pre-game-option">
            <Icon name="devices" size={24} />
            <h3>With other people</h3>
            <p>
              Up to {seats} {seats === 1 ? "person" : "people"}
              {roles.length > 1 ? `. Each phone takes a part: ${roles.map((role) => role.label).join(", ")}.` : "."}
            </p>
          </article>
        )}

        {/* Always last. Playing with your body is the most interesting thing this product does and
            the slowest to start, so it is offered after the ways that need nothing set up. */}
        {cameraHere && cameraKind && (
          <article className="pre-game-option">
            <Icon name={cameraSource === "camera-hand" ? "camera-hand" : "camera-pose"} size={24} />
            <h3>{cameraKind === "body" ? "With your body" : "With your hands"}</h3>
            <p>
              {cameraKind === "body"
                ? "Move in front of the camera. Nothing to hold."
                : "Wave and gesture at the camera. Nothing to hold."}
            </p>
            <button className="outline-button" onClick={() => setCameraOpen(true)} aria-expanded={cameraOpen}>
              {recallCameraSetup(cameraKind) ? "Set up again" : "Set up the camera"} <Icon name="arrow" size={16} />
            </button>
          </article>
        )}
      </div>
      )}

      {pairingOpen && <PairingBlock sessionId={sessionId} />}

      {/* True for all ten: every game renders its own connect control while running. */}
      <p className="pre-game-note">You can add a phone at any time, including once the game has started.</p>
    </main>
  );
}

/**
 * Pairing without a game.
 *
 * `preparePairing` connects its own transport, so this needs no `GameHost101` and no engine — which
 * is the whole reason the chooser can offer a phone without starting anything.
 */
function PairingBlock({ sessionId }: { sessionId: string | null }) {
  const [pairing, setPairing] = useState<BrowserPairingInfo>();
  const [qrCode, setQrCode] = useState("");
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!sessionId) return;
    let current = true;
    getBrowserHostTransport(sessionId)
      .preparePairing()
      .then(async (info) => {
        // The QR library needs literal hex, not a CSS variable; these mirror --ink and --paper.
        const image = await QRCode.toDataURL(info.controllerUrl, { width: 280, margin: 2, errorCorrectionLevel: "M", color: { dark: "#0a0a0a", light: "#f2f2f2" } });
        if (!current) return;
        setPairing(info);
        setQrCode(image);
        setFailed(false);
      })
      .catch((error) => {
        if (!current) return;
        console.warn("101 pairing unavailable", error);
        setFailed(true);
      });
    return () => { current = false; };
  }, [sessionId]);

  const url = pairing?.controllerUrl ?? (sessionId ? `/controller?session=${sessionId}` : "");

  const copy = async () => {
    if (!url) return;
    await navigator.clipboard?.writeText(new URL(url, window.location.origin).toString());
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <section className="pre-game-pairing">
      <div className="pair-body">
        {qrCode ? (
          /* A generated data URL, rendered directly; it never leaves this browser. */
          /* eslint-disable-next-line @next/next/no-img-element */
          <img className="pairing-qr" src={qrCode} alt={`Code for room ${sessionId}`} />
        ) : (
          <div className="pairing-qr pending"><span>{failed ? "Not ready" : "Preparing…"}</span></div>
        )}
        <ol className="pair-steps">
          <li>Put both devices on the same Wi-Fi.</li>
          <li>Scan this code with the other device&apos;s camera, or open the link below on it.</li>
          <li>It becomes a controller. No app install — it runs in the browser.</li>
        </ol>
      </div>

      <div className="session-code"><span>Room code</span><strong>{sessionId ?? "······"}</strong></div>
      <div className="pair-link">
        <code>{url || "preparing…"}</code>
        <button onClick={copy} disabled={!url}>{copied ? "Copied" : "Copy"}</button>
      </div>
      {failed && <p className="pairing-error">Can&apos;t reach the other devices on this network. Check that this device is online, then try again.</p>}
    </section>
  );
}
