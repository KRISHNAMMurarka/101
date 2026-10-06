"use client";


import QRCode from "qrcode";
import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { HostConnectionReview } from "../components/HostConnectionReview";
import { Icon } from "../components/Icon";
import { getBrowserHostTransport, type BrowserPairingInfo } from "../lib/browser-link";
import { refreshLocalCameras, useLocalDevice } from "../lib/local-capabilities";
import { useSessionId } from "../lib/session-id";
import { createLinkedDeviceObserver, inspectLocalDevice, type InspectedDevice, type InspectedResource, type LinkedDeviceObserver, type LinkedDeviceSnapshot } from "./device-inspection";
import "./devices.css";

const emptyDiscovery: LinkedDeviceSnapshot = Object.freeze({ sessionId: "", phase: "idle", reserved: false, timerArmed: false, devices: Object.freeze([]) });
const resourceStates: Record<InspectedResource["state"], string> = { unchecked: "Not checked", "needs-permission": "Needs setup", denied: "Access blocked", unsupported: "Unavailable here", unavailable: "Not available", observed: "Input received" };
const deviceStates: Record<InspectedDevice["state"], string> = { reported: "Inputs reported", active: "Input received", unknown: "Inputs not identified", partial: "Some inputs need setup", offline: "Not responding" };
const onlineNow = () => typeof navigator === "undefined" || navigator.onLine !== false;
const onlineOnServer = () => true;
function subscribeOnline(listener: () => void) { window.addEventListener("online", listener); window.addEventListener("offline", listener); return () => { window.removeEventListener("online", listener); window.removeEventListener("offline", listener); }; }

export default function DevicesView() {
  const sessionId = useSessionId(), local = useLocalDevice(), online = useSyncExternalStore(subscribeOnline, onlineNow, onlineOnServer);
  const [discovery, setDiscovery] = useState<LinkedDeviceSnapshot>(emptyDiscovery);
  const [selected, setSelected] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [pairing, setPairing] = useState<BrowserPairingInfo>();
  const [qrCode, setQrCode] = useState("");
  const [qrFailed, setQrFailed] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "pending" | "copied" | "failed">("idle");
  const [cameraPermission, setCameraPermission] = useState<PermissionState | "unknown">("unknown");
  const [checkingInputs, setCheckingInputs] = useState(false);
  const observer = useRef<{ sessionId: string; controller: LinkedDeviceObserver; life: number } | undefined>(undefined);
  const life = useRef(0), currentSelection = useRef<string | undefined>(undefined), permissionGeneration = useRef(0), permissionPending = useRef(false);
  const permissionDetach = useRef<(() => void) | undefined>(undefined), clipboardPending = useRef(false), invitationGeneration = useRef(0);
  const returnFocus = useRef<HTMLElement | undefined>(undefined), listTitle = useRef<HTMLHeadingElement>(null), inspectTitle = useRef<HTMLHeadingElement>(null), addTitle = useRef<HTMLHeadingElement>(null), linkField = useRef<HTMLInputElement>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const revision = ++life.current;
    return () => {
      // Cleanup intentionally advances the current generation, rather than a captured ref value.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      if (life.current === revision) life.current++;
      // eslint-disable-next-line react-hooks/exhaustive-deps
      permissionGeneration.current++; permissionDetach.current?.(); permissionDetach.current = undefined;
      // eslint-disable-next-line react-hooks/exhaustive-deps
      invitationGeneration.current++; if (copiedTimer.current) clearTimeout(copiedTimer.current);
      const owned = observer.current; observer.current = undefined; void owned?.controller.close();
    };
  }, [sessionId]);
  useEffect(() => { if (!online) void observer.current?.controller.stop(); }, [online]);
  useEffect(() => {
    const target = selected ? inspectTitle.current : adding ? addTitle.current : undefined;
    target?.focus();
  }, [selected, adding]);
  useEffect(() => {
    if (!pairing) return;
    let current = true;
    const expiry = setTimeout(() => { if (current) { invitationGeneration.current++; setPairing(undefined); setQrCode(""); setCopyState("idle"); } }, Math.max(0, pairing.ticket.expiresAt - Date.now()));
    void QRCode.toDataURL(pairing.controllerUrl, { width: 640, margin: 4, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#d8d8d8" } })
      .then(image => { if (current) setQrCode(image); }).catch(() => { if (current) setQrFailed(true); });
    return () => { current = false; clearTimeout(expiry); };
  }, [pairing]);

  const ensureObserver = () => {
    if (!sessionId) return;
    if (observer.current?.sessionId === sessionId) return observer.current.controller;
    const revision = life.current;
    const controller = createLinkedDeviceObserver({ sessionId, transport: getBrowserHostTransport(sessionId), now: () => performance.now(), onChange(snapshot) {
      if (life.current === revision && observer.current?.controller === controller) setDiscovery(snapshot);
    } });
    observer.current = { sessionId, controller, life: revision }; return controller;
  };
  const find = () => { if (online) void ensureObserver()?.start(); };
  const closeTask = () => {
    currentSelection.current = undefined; permissionGeneration.current++; permissionDetach.current?.(); permissionDetach.current = undefined;
    setSelected(undefined); setAdding(false);
    if (adding) ready(undefined);
    if (returnFocus.current?.isConnected) returnFocus.current.focus(); else listTitle.current?.focus();
  };
  const refreshInputs = async () => {
    if (permissionPending.current) return;
    permissionPending.current = true; setCheckingInputs(true); const generation = ++permissionGeneration.current, revision = life.current;
    permissionDetach.current?.(); permissionDetach.current = undefined;
    try {
      await refreshLocalCameras();
      if (life.current !== revision || permissionGeneration.current !== generation || currentSelection.current !== "local-device") return;
      if (!navigator.permissions?.query) { setCameraPermission("unknown"); return; }
      const permission = await navigator.permissions.query({ name: "camera" as PermissionName });
      if (life.current !== revision || permissionGeneration.current !== generation || currentSelection.current !== "local-device") return;
      const update = () => { if (life.current === revision && permissionGeneration.current === generation && currentSelection.current === "local-device") setCameraPermission(permission.state); };
      update(); permission.addEventListener("change", update); permissionDetach.current = () => permission.removeEventListener("change", update);
    } catch { if (life.current === revision && permissionGeneration.current === generation) setCameraPermission("unknown"); }
    finally { permissionPending.current = false; if (life.current === revision) setCheckingInputs(false); }
  };
  const inspect = (id: string, trigger: HTMLElement) => {
    returnFocus.current = trigger; currentSelection.current = id; setAdding(false); setSelected(id);
    if (selected === id) inspectTitle.current?.focus();
    if (id === "local-device") void refreshInputs(); else { permissionGeneration.current++; permissionDetach.current?.(); permissionDetach.current = undefined; }
  };
  const ready = (info: BrowserPairingInfo | undefined) => {
    invitationGeneration.current++; if (copiedTimer.current) clearTimeout(copiedTimer.current);
    if (info && Date.now() >= info.ticket.expiresAt) info = undefined;
    setQrCode(""); setQrFailed(false); setCopyState("idle"); setPairing(info);
    if (info && online) find();
  };
  const controllerUrl = online && pairing ? pairing.controllerUrl : "";
  const copy = async () => {
    if (!controllerUrl || clipboardPending.current) return;
    const generation = invitationGeneration.current, revision = life.current;
    clipboardPending.current = true; setCopyState("pending");
    try {
      if (!navigator.clipboard?.writeText) throw Error("Copy unavailable");
      await navigator.clipboard.writeText(controllerUrl);
      if (life.current !== revision || invitationGeneration.current !== generation || !pairing || Date.now() >= pairing.ticket.expiresAt) return;
      setCopyState("copied"); copiedTimer.current = setTimeout(() => { if (life.current === revision && invitationGeneration.current === generation) setCopyState("idle"); }, 1400);
    } catch {
      if (life.current === revision && invitationGeneration.current === generation) { setCopyState("failed"); linkField.current?.focus(); linkField.current?.select(); }
    } finally { clipboardPending.current = false; }
  };
  const live = discovery.sessionId === sessionId ? discovery : emptyDiscovery;
  const localDetails = inspectLocalDevice(local, { cameraApi: typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia, cameraPermission });
  const detail = selected === "local-device" ? localDetails : live.devices.find(device => `linked:${device.id}` === selected);
  const looking = live.phase === "looking", listening = live.phase === "listening";
  const discoveryMessage = !online ? "You’re offline. You can inspect local inputs. Reconnect, then find devices again." : looking ? "Looking for controllers in this room… You can cancel." :
    live.phase === "failed" ? "Couldn’t check connected devices. Stop looking, then retry or add a device using its connection link." :
      live.phase === "stopped" ? "Stopped looking. Find devices again when you’re ready." : live.phase === "idle" ? "Find controllers already linked to this room, or add another device." :
        live.devices.length ? "Only details received in this room are listed. Inspection does not give an application access." : "No connected devices found yet. Keep this room open on the other device, or add a device.";

  return <main className="devices-page devices-flow">
    <header className="page-head"><p className="eyebrow">Devices</p><h1>What is connected</h1>
      <p className="page-intro">Inspect the inputs on this screen, find a linked controller, or prepare an invitation for another device.</p></header>
    <article className="device-card" aria-labelledby="devices-local-title">
      <div className="device-card-head"><Icon name={local.shape === "computer" ? "keyboard" : "phone-motion"} size={24} /><div><h2 id="devices-local-title">This {local.shape}</h2><p>{local.sources.length ? "Local inputs to choose in an application" : "No local inputs found yet"}</p></div>
        <button className="outline-button devices-flow-button" onClick={event => inspect("local-device", event.currentTarget)}>Inspect this {local.shape}</button></div>
      <p className="device-note">Some inputs need setup or permission. An input listed here is not already running.</p>
    </article>
    <article className="device-card" aria-labelledby="devices-linked-title">
      <div className="device-card-head"><Icon name="devices" size={24} /><div><h2 id="devices-linked-title" ref={listTitle} tabIndex={-1}>Linked devices</h2><p>{live.devices.length ? `${live.devices.length} ${live.devices.length === 1 ? "device" : "devices"} received in this room` : "No linked devices listed"}</p></div></div>
      <div className="devices-flow-actions">
        <button className="outline-button devices-flow-button" disabled={!sessionId || !online || live.reserved || looking || listening} onClick={find}>Find connected devices</button>
        {(looking || listening || live.reserved) && <button className="outline-button devices-flow-button" onClick={() => void observer.current?.controller.stop()}>{looking ? "Cancel looking" : "Stop looking"}</button>}
        <button className="primary-button devices-flow-button" onClick={event => { returnFocus.current = event.currentTarget; currentSelection.current = undefined; permissionGeneration.current++; permissionDetach.current?.(); permissionDetach.current = undefined; setSelected(undefined); setAdding(true); }}>Add a device</button>
      </div>
      <p className="devices-flow-status" role="status" aria-live="polite">{discoveryMessage}</p>
      {live.devices.length > 0 && <ul className="devices-flow-list">{live.devices.map(device => <li key={device.id}><div><h3>{device.label}</h3><p>{deviceStates[device.state]}</p></div>
        <button className="outline-button devices-flow-button" onClick={event => inspect(`linked:${device.id}`, event.currentTarget)}>Inspect <span className="devices-flow-hidden-name">{device.label}</span></button></li>)}</ul>}
    </article>
    {selected && <section className="device-card devices-flow-inspection" aria-labelledby="devices-inspect-title">
      <div className="devices-flow-task-head"><h2 id="devices-inspect-title" ref={inspectTitle} tabIndex={-1}>{detail ? `Inspect ${detail.label}` : "Device no longer listed"}</h2><button className="outline-button devices-flow-button" onClick={closeTask}>Back to devices</button></div>
      {detail ? <><p className="devices-flow-status" role="status">{selected === "local-device" ? "Local availability and permission only. Choose an application to start using an input." : deviceStates[detail.state] + ". These are connection details, not a device identity check or permission to control an application."}</p>
        <ul className="devices-flow-resources">{detail.resources.map(resource => <li key={resource.id}><div className="devices-flow-resource-head"><h3>{resource.label}</h3><span className="state-badge">{resourceStates[resource.state]}</span></div><p>{resource.note}</p></li>)}</ul>
        <div className="devices-flow-actions">{selected === "local-device" ? <button className="outline-button devices-flow-button" disabled={checkingInputs} onClick={() => void refreshInputs()}>{checkingInputs ? "Checking inputs…" : "Refresh inputs"}</button> :
          <button className="outline-button devices-flow-button" onClick={() => { void observer.current?.controller.stop().then(find); }} disabled={!online}>Find this device again</button>}<Link className="outline-button devices-flow-button" href="/">Choose an application</Link></div>
      </> : <p>Find devices again or prepare a new connection link. <button className="outline-button devices-flow-button" onClick={find}>Find connected devices</button></p>}
    </section>}
    {adding && <section className="device-card devices-flow-add" aria-labelledby="devices-add-title">
      <div className="devices-flow-task-head"><h2 id="devices-add-title" ref={addTitle} tabIndex={-1}>Add a device</h2><button className="outline-button devices-flow-button" onClick={closeTask}>Back to devices</button></div>
      <p className="device-note">Prepare a connection link, then review it on the other device. A room code or a device name does not give an application access.</p>
      {!online && <p className="devices-flow-status" role="status">Reconnect to the network before checking the connection address. You can return to local inputs now.</p>}
      {sessionId && online && <HostConnectionReview sessionId={sessionId} onReady={ready} />}
      {/* The generated, expiring local QR data URL is already sized and cannot use a remote image optimizer. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {controllerUrl ? <><div className="pair-body">{qrCode ? <img className="pairing-qr" src={qrCode} alt="Scan this invitation to review a controller connection" /> : <div className="pairing-qr pending"><span>{qrFailed ? "Use the link below" : "Preparing code…"}</span></div>}
        <ol className="pair-steps"><li>Open this link or scan the code on the other device.</li><li>Review the host and connection address there.</li><li>Return here to inspect the inputs it reports. Choose an application to use them.</li></ol></div>
        <label className="devices-flow-link-label" htmlFor="devices-invitation">Connection link</label><div className="devices-flow-share"><input id="devices-invitation" ref={linkField} value={controllerUrl} readOnly /><button className="outline-button devices-flow-button" disabled={copyState === "pending"} onClick={() => void copy()}>{copyState === "copied" ? "Copied" : copyState === "pending" ? "Copying…" : "Copy link"}</button></div>
        <p className="devices-flow-status" role="status">{copyState === "failed" ? "Copy wasn’t available. Select the link and copy it yourself." : qrFailed ? "Couldn’t prepare the code. Use the connection link instead." : "Invitation prepared. Another device is connected only after its details appear in Linked devices."}</p>
        <a className="outline-button devices-flow-button" href={controllerUrl} target="_blank" rel="noreferrer">Open invitation on this device <Icon name="external" size={16} /></a>
      </> : <p className="device-note">The code and link appear after you check and connect to the selected address.</p>}
      <p className="device-note">Room code: <strong>{sessionId ?? "Preparing…"}</strong></p>
    </section>}
  </main>;
}
