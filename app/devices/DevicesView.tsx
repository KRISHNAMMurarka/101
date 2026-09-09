"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";

import { Icon } from "../components/Icon";
import { getBrowserHostTransport, type BrowserPairingInfo } from "../lib/browser-link";
import { CATALOG_INPUT_LABELS } from "../lib/catalog";
import { useLocalDevice } from "../lib/local-capabilities";
import { useSessionId } from "../lib/session-id";

/**
 * Devices is a destination, not a modal.
 *
 * Connecting used to exist only as a dialog raised from one button on one route: it could not be
 * linked to, landed on, or returned to, and once dismissed there was nowhere in the product that
 * said what was connected. So a player who had not paired anything had no way to find out what to
 * do, and a player who had paired something had no way to confirm it. Both are answered here, and
 * the rail keeps a way back to it from every route.
 *
 * The page is ordered by the questions people actually ask, in order: what can this thing do on its
 * own, what is attached to it, and how do I attach something else.
 */

export default function DevicesView() {
  const sessionId = useSessionId();
  const { capabilities, sources, shape } = useLocalDevice();
  const [pairing, setPairing] = useState<BrowserPairingInfo>();
  const [qrCode, setQrCode] = useState("");
  const [hubError, setHubError] = useState("");
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
        setHubError("");
      })
      .catch(() => {
        if (current) setHubError("The connection is unavailable. Try again in a moment.");
      });
    return () => { current = false; };
  }, [sessionId]);

  const controllerUrl = pairing?.controllerUrl ?? (sessionId ? `/controller?session=${sessionId}` : "");

  const copy = async () => {
    if (!controllerUrl) return;
    await navigator.clipboard?.writeText(new URL(controllerUrl, window.location.origin).toString());
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <main className="devices-page">
      <header className="page-head">
        <p className="eyebrow">Devices</p>
        <h1>What is connected</h1>
        <p className="page-intro">101 needs at least one way to send input. This screen already counts as one — everything else is extra players, extra senses, or a controller you would rather hold.</p>
      </header>

      <article className="device-card">
        <div className="device-card-head">
          <Icon name={shape === "computer" ? "keyboard" : "phone-motion"} size={24} />
          <div>
            <h2>This {shape}</h2>
            <p>Ready now, no pairing needed</p>
          </div>
          <span className="state-badge state-live">Active</span>
        </div>
        <ul className="capability-list">
          {sources.map((source) => (
            <li key={source}><Icon name={source} size={16} /> {CATALOG_INPUT_LABELS[source]}</li>
          ))}
        </ul>
        {/* Presence, not permission: the camera and motion entries above mean the API exists, and
            the browser will still ask the player at the point of use. Saying so here is the
            difference between a readout and a promise. */}
        {(capabilities.camera || capabilities.gyroscope) && (
          <p className="device-note">Camera and motion still ask permission the first time a game uses them.</p>
        )}
      </article>

      <article className="device-card">
        <div className="device-card-head">
          <Icon name="devices" size={24} />
          <div>
            <h2>Add a device</h2>
            <p>A phone, tablet or second computer on the same Wi-Fi</p>
          </div>
        </div>

        <div className="pair-body">
          {qrCode ? (
            /* A generated data URL, rendered directly; it never leaves the local browser. */
            /* eslint-disable-next-line @next/next/no-img-element */
            <img className="pairing-qr" src={qrCode} alt="Scan this code to connect a controller" />
          ) : (
            <div className="pairing-qr pending"><span>{hubError ? "Not ready" : "Preparing…"}</span></div>
          )}

          <ol className="pair-steps">
            <li>Put both devices on the same Wi-Fi.</li>
            <li>Scan this code with the other device&apos;s camera, or open the link below on it.</li>
            <li>It becomes a controller. No app install — it runs in the browser.</li>
          </ol>
        </div>

        <div className="session-code"><span>Room code</span><strong>{sessionId ?? "······"}</strong></div>
        <div className="pair-link">
          <code>{controllerUrl || "preparing…"}</code>
          <button onClick={copy} disabled={!controllerUrl}>{copied ? "Copied" : "Copy"}</button>
        </div>

        {hubError && <p className="pairing-error">Can&apos;t reach this computer&apos;s connection service. Make sure both devices are on the same Wi-Fi, then reload.</p>}
        {pairing && <p className="pairing-ready">Ready to connect</p>}

        <div className="pair-actions">
          {controllerUrl && <a className="primary-button" href={controllerUrl} target="_blank" rel="noreferrer">Open 101 Link on this device <Icon name="external" size={16} /></a>}

        </div>
      </article>

    </main>
  );
}
