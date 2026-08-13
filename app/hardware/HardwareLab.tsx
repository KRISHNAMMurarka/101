"use client";

import { WebBluetoothAdapter } from "@101/adapter-bluetooth";
import { WebHIDAdapter } from "@101/adapter-hid";
import { WebSerialAdapter } from "@101/adapter-serial";
import { FixedLengthByteFramer, type HardwareCapabilityStatus, type HardwareReportMapping } from "@101/hardware";
import { InputBus, type InputAdapter, type InputFrame } from "@101/input";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type HardwareKind = "hid" | "bluetooth" | "serial";
type ConnectableAdapter = InputAdapter & { requestDevice?(): Promise<unknown>; requestPort?(): Promise<unknown> };

const INITIAL_STATUSES: Record<HardwareKind, HardwareCapabilityStatus> = {
  hid: { api: "hid", supported: false, secureContext: true, permission: "unsupported", connected: false },
  bluetooth: { api: "bluetooth", supported: false, secureContext: true, permission: "unsupported", connected: false },
  serial: { api: "serial", supported: false, secureContext: true, permission: "unsupported", connected: false },
};

const GENERIC_MAPPING: HardwareReportMapping = { controls: [
  { kind: "axis", name: "steer", offset: 0, valueType: "u8", inputCenter: 128, deadZone: .08 },
  { kind: "action", name: "trigger", offset: 1, valueType: "u8", threshold: 1 },
  { kind: "vector", name: "aim", component: "x", offset: 2, valueType: "i8" },
  { kind: "vector", name: "aim", component: "y", offset: 3, valueType: "i8", invert: true },
] };

export default function HardwareLab() {
  const busRef = useRef(new InputBus());
  const adapters = useRef(new Map<HardwareKind, ConnectableAdapter>());
  const [latest, setLatest] = useState<InputFrame>();
  const [error, setError] = useState("");
  const [hidVendor, setHidVendor] = useState("0x0101");
  const [blePrefix, setBlePrefix] = useState("101");
  const [bleService, setBleService] = useState("0000ff10-0000-1000-8000-00805f9b34fb");
  const [bleCharacteristic, setBleCharacteristic] = useState("0000ff11-0000-1000-8000-00805f9b34fb");
  const [baudRate, setBaudRate] = useState("115200");
  const [statuses, setStatuses] = useState<Record<HardwareKind, HardwareCapabilityStatus>>(INITIAL_STATUSES);

  useEffect(() => {
    const bus = busRef.current;
    const unsubscribe = bus.subscribe((frame) => setLatest(frame));
    const capabilityTimer = window.setTimeout(() => setStatuses(detectCapabilities()), 0);
    return () => { window.clearTimeout(capabilityTimer); unsubscribe(); void bus.destroy(); };
  }, []);

  const setStatus = (kind: HardwareKind) => (status: HardwareCapabilityStatus) => setStatuses((current) => ({ ...current, [kind]: status }));

  const connect = async (kind: HardwareKind) => {
    setError("");
    let adapter: ConnectableAdapter | undefined;
    try {
      await disconnect(kind);
      if (kind === "hid") {
        const vendorId = parseInteger(hidVendor, 65_535, "HID vendor ID");
        adapter = new WebHIDAdapter({ filters: [{ vendorId }], mapping: GENERIC_MAPPING, onStatus: setStatus(kind) });
        adapters.current.set(kind, adapter);
        await adapter.requestDevice?.();
      } else if (kind === "bluetooth") {
        if (!blePrefix.trim() || !bleService.trim() || !bleCharacteristic.trim()) throw new Error("Bluetooth name prefix, service, and characteristic are required");
        adapter = new WebBluetoothAdapter({ filters: [{ namePrefix: blePrefix.trim() }], service: bleService.trim(), characteristic: bleCharacteristic.trim(), mapping: GENERIC_MAPPING, onStatus: setStatus(kind) });
        adapters.current.set(kind, adapter);
        await adapter.requestDevice?.();
      } else {
        const rate = parseInteger(baudRate, 20_000_000, "baud rate");
        adapter = new WebSerialAdapter({ open: { baudRate: rate }, framer: new FixedLengthByteFramer(4), mapping: GENERIC_MAPPING, onStatus: setStatus(kind) });
        adapters.current.set(kind, adapter);
        await adapter.requestPort?.();
      }
      await busRef.current.register(adapter);
    } catch (cause) {
      adapters.current.delete(kind);
      await adapter?.stop();
      setError(cause instanceof Error ? cause.message : `Unable to connect ${kind}`);
    }
  };

  const disconnect = async (kind: HardwareKind) => {
    const adapter = adapters.current.get(kind);
    if (!adapter) return;
    adapters.current.delete(kind);
    await busRef.current.unregister(adapter);
    setStatuses((current) => ({ ...current, [kind]: { ...current[kind], connected: false } }));
  };

  return (
    <main className="hardware-lab-page">
      <header className="hardware-lab-topbar">
        <Link className="wordmark" href="/"><span className="mark-block">101</span><span className="mark-label">HARDWARE LAB</span></Link>
        <b>OPTIONAL · LOCAL · USER-SELECTED</b>
      </header>
      <section className="hardware-lab-intro">
        <p className="eyebrow">Diagnostic 06 · Specialist device adapters</p>
        <h1>Wire bytes into<br />game language.</h1>
        <p>The sample contract maps a four-byte report into <code>steer</code>, <code>trigger</code>, and <code>aim</code>. Change the declarative mapping in a developer package for any board or peripheral—games still receive ordinary 101 frames.</p>
      </section>
      {error && <p className="hardware-error" role="alert">{error}</p>}
      <section className="hardware-grid">
        <HardwareCard kind="hid" title="WebHID" description="USB or Bluetooth HID reports. The browser chooser limits access to the vendor you specify." status={statuses.hid} onConnect={() => void connect("hid")} onDisconnect={() => void disconnect("hid")}>
          <label>Vendor ID<input value={hidVendor} onChange={(event) => setHidVendor(event.target.value)} inputMode="text" /></label>
        </HardwareCard>
        <HardwareCard kind="bluetooth" title="Web Bluetooth" description="BLE GATT notifications from one declared service and characteristic. No background scan is performed." status={statuses.bluetooth} onConnect={() => void connect("bluetooth")} onDisconnect={() => void disconnect("bluetooth")}>
          <label>Device name prefix<input value={blePrefix} onChange={(event) => setBlePrefix(event.target.value)} /></label>
          <label>Service UUID<input value={bleService} onChange={(event) => setBleService(event.target.value)} /></label>
          <label>Input characteristic UUID<input value={bleCharacteristic} onChange={(event) => setBleCharacteristic(event.target.value)} /></label>
        </HardwareCard>
        <HardwareCard kind="serial" title="Web Serial" description="Arduino/ESP32-style serial bytes. This sample reads fixed four-byte packets with bounded buffering." status={statuses.serial} onConnect={() => void connect("serial")} onDisconnect={() => void disconnect("serial")}>
          <label>Baud rate<input value={baudRate} onChange={(event) => setBaudRate(event.target.value)} inputMode="numeric" /></label>
        </HardwareCard>
      </section>
      <section className="hardware-frame-panel">
        <div><span>LATEST NORMALIZED INPUT FRAME</span><b>{latest ? `${latest.source.toUpperCase()} · #${latest.sequence}` : "WAITING"}</b></div>
        <pre>{latest ? JSON.stringify({ deviceId: latest.deviceId, playerId: latest.playerId, actions: latest.actions, axes: latest.axes, vectors: latest.vectors }, null, 2) : "Select a supported device. The chooser is opened only by your click."}</pre>
      </section>
      <aside className="hardware-safety-note"><b>FALLBACK GUARANTEE</b><span>These adapters enhance games; they never replace keyboard, pointer, touch, or gamepad startup controls. API support varies by browser and OS, and this page reports that honestly.</span></aside>
    </main>
  );
}

function HardwareCard({ kind, title, description, status, onConnect, onDisconnect, children }: { kind: HardwareKind; title: string; description: string; status: HardwareCapabilityStatus; onConnect(): void; onDisconnect(): void; children: React.ReactNode }) {
  return <article className={`hardware-card ${status.connected ? "connected" : ""}`}>
    <div className="hardware-card-head"><span>{kind.toUpperCase()}</span><i>{status.supported ? status.connected ? "CONNECTED" : "AVAILABLE" : "UNSUPPORTED"}</i></div>
    <h2>{title}</h2><p>{description}</p><div className="hardware-fields">{children}</div>
    <dl><div><dt>SECURE CONTEXT</dt><dd>{status.secureContext ? "YES" : "NO"}</dd></div><div><dt>PERMISSION</dt><dd>{status.permission.toUpperCase()}</dd></div></dl>
    <button disabled={!status.supported || !status.secureContext} onClick={status.connected ? onDisconnect : onConnect}>{status.connected ? "DISCONNECT" : `SELECT ${kind.toUpperCase()} DEVICE`}</button>
  </article>;
}

function detectCapabilities(): Record<HardwareKind, HardwareCapabilityStatus> {
  const browser = navigator as Navigator & { hid?: unknown; bluetooth?: unknown; serial?: unknown };
  const secure = typeof isSecureContext === "undefined" || isSecureContext;
  return {
    hid: { api: "hid", supported: Boolean(browser.hid), secureContext: secure, permission: browser.hid ? "prompt" : "unsupported", connected: false },
    bluetooth: { api: "bluetooth", supported: Boolean(browser.bluetooth), secureContext: secure, permission: browser.bluetooth ? "prompt" : "unsupported", connected: false },
    serial: { api: "serial", supported: Boolean(browser.serial), secureContext: secure, permission: browser.serial ? "prompt" : "unsupported", connected: false },
  };
}

function parseInteger(value: string, max: number, label: string) {
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw new Error(`Invalid ${label}`);
  return parsed;
}
