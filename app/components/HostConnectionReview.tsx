"use client";

import { useEffect, useId, useRef, useState } from "react";
import { getBrowserHostTransport, readBrowserHubCandidates, type BrowserPairingInfo } from "../lib/browser-link";
import { canonicalHubEndpoint, controllerOriginForPhone, type HubCandidate, type HubEndpointReview } from "../lib/host-endpoint-review";

export function HostConnectionReview({ sessionId, onReady }: { sessionId: string; onReady: (info: BrowserPairingInfo | undefined) => void }) {
  const id = useId(), field = useRef<HTMLInputElement>(null), generation = useRef(0), pending = useRef<AbortController | undefined>(undefined);
  const ready = useRef(onReady);
  const focusAfterCancel = useRef(false);
  const [candidates, setCandidates] = useState<readonly HubCandidate[]>([]);
  const [address, setAddress] = useState("");
  const [review, setReview] = useState<HubEndpointReview>();
  const [phoneEndpoint, setPhoneEndpoint] = useState("");
  const [phase, setPhase] = useState<"review" | "checking" | "checked" | "connecting" | "ready" | "failed">("review");
  const [message, setMessage] = useState("");
  useEffect(() => { ready.current = onReady; }, [onReady]);
  useEffect(() => {
    const hints = readBrowserHubCandidates();
    // Browser storage and URL hints are discovered after hydration; they do not initiate requests.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCandidates(hints); setAddress(hints[0]?.endpoint ?? "");
    setReview(undefined); setPhase("review"); setMessage(""); ready.current(undefined);
    return () => { generation.current += 1; pending.current?.abort(); };
  }, [sessionId]);

  const reset = (next = address) => {
    generation.current += 1; pending.current?.abort(); pending.current = undefined;
    setAddress(next); setReview(undefined); setPhoneEndpoint(""); setPhase("review"); setMessage(""); ready.current(undefined);
  };
  const check = async () => {
    reset();
    const revision = ++generation.current, controller = new AbortController(); pending.current = controller;
    try {
      const endpoint = canonicalHubEndpoint(address); setAddress(endpoint); setPhase("checking");
      const result = await getBrowserHostTransport(sessionId).reviewEndpoint(endpoint, { signal: controller.signal });
      if (revision !== generation.current || controller.signal.aborted) return;
      setReview(result); setPhoneEndpoint(endpoint); setPhase("checked"); setMessage("Address checked. Choose the address to share, then connect.");
    } catch {
      if (revision !== generation.current || controller.signal.aborted) return;
      setPhase("failed"); setMessage("Couldn’t check this address. Check that the connection service is running, or choose another address.");
    } finally { if (revision === generation.current) pending.current = undefined; }
  };
  const connect = async () => {
    if (!review) return;
    const revision = ++generation.current, controller = new AbortController(); pending.current?.abort(); pending.current = controller;
    setPhase("connecting"); setMessage(""); ready.current(undefined);
    try {
      const info = await getBrowserHostTransport(sessionId).preparePairing(review.endpoint, { phoneEndpoint, signal: controller.signal });
      if (revision !== generation.current || controller.signal.aborted) return;
      setPhase("ready"); setMessage("Connected. The code below uses the address you selected."); ready.current(info);
    } catch {
      if (revision !== generation.current || controller.signal.aborted) return;
      setPhase("failed"); setMessage("Couldn’t connect. Check the address again and try once more.");
    } finally { if (revision === generation.current) pending.current = undefined; }
  };
  const busy = phase === "checking" || phase === "connecting";
  useEffect(() => {
    if (!busy && focusAfterCancel.current) { focusAfterCancel.current = false; field.current?.focus(); }
  }, [busy]);
  let phoneOrigin = "";
  if (review && phoneEndpoint && typeof window !== "undefined") phoneOrigin = controllerOriginForPhone(window.location.origin, phoneEndpoint);
  return (
    <div style={{ display: "grid", gap: 12, marginBlock: 16, minWidth: 0 }}>
      <p className="device-note">Choose the computer’s connection address. Addresses from links and this network need your review.</p>
      {candidates.length > 0 && <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>{candidates.map(candidate => (
        <button key={candidate.endpoint} type="button" className="outline-button" disabled={busy} style={{ minHeight: 44, overflowWrap: "anywhere", maxWidth: "100%" }} onClick={() => { reset(candidate.endpoint); field.current?.focus(); }}>
          {candidate.endpoint} <span>({candidate.source})</span>
        </button>
      ))}</div>}
      <label htmlFor={`${id}-address`}>Connection address</label>
      <input ref={field} id={`${id}-address`} type="url" autoComplete="off" spellCheck={false} maxLength={2048} value={address} disabled={busy}
        aria-describedby={`${id}-status`} onChange={event => reset(event.target.value)}
        style={{ width: "100%", minWidth: 0, minHeight: 44, padding: "8px 12px", border: "1px solid var(--line)", background: "var(--panel)", color: "var(--paper)", font: "inherit" }} />
      {review && <fieldset style={{ minWidth: 0, border: "1px solid var(--line)", padding: 12 }} disabled={busy || phase === "ready"}>
        <legend>Address to share with your phone</legend>
        {review.phoneEndpoints.map(endpoint => <label key={endpoint} style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 44, overflowWrap: "anywhere" }}>
          <input type="radio" name={`${id}-phone`} value={endpoint} checked={phoneEndpoint === endpoint} onChange={() => { setPhoneEndpoint(endpoint); ready.current(undefined); }} />
          <span>{endpoint}</span>
        </label>)}
        <p className="device-note" style={{ overflowWrap: "anywhere" }}>Phone page: {phoneOrigin}. Select a network address for a different device.</p>
      </fieldset>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {!busy && phase !== "ready" && <button type="button" className="outline-button" style={{ minHeight: 44 }} disabled={!address} onClick={() => void check()}>{review ? "Check again" : "Check address"}</button>}
        {phase === "checked" && <button type="button" className="primary-button" style={{ minHeight: 44 }} onClick={() => void connect()}>Connect</button>}
        {(busy || review || phase === "ready") && <button type="button" className="outline-button" style={{ minHeight: 44 }} onClick={() => { focusAfterCancel.current = busy; reset(); if (!busy) field.current?.focus(); }}>{busy ? "Cancel" : "Change address"}</button>}
      </div>
      <p id={`${id}-status`} role="status" aria-live="polite" className={phase === "failed" ? "pairing-error" : "device-note"}>
        {busy ? (phase === "checking" ? "Checking address…" : "Connecting…") : message || "Choose Connect to use the address shown."}
      </p>
    </div>
  );
}
