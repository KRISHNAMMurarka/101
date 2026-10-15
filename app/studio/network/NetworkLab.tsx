"use client";

import { NetworkDiagnostics, type NetworkSnapshot } from "@101/diagnostics";
import type { InputFrame } from "@101/input";
import { WebRTCTransport, type LinkState } from "@101/protocol";
import { copyInvitationLink } from "@/app/lib/invitation-copy";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type Role = "choose" | "host" | "controller";

const EMPTY_NETWORK: NetworkSnapshot = {
  roundTripMs: 0,
  jitterMs: 0,
  droppedPercent: 0,
  receivedPackets: 0,
  sentPings: 0,
};

interface ConnectionInfo {
  path: string;
  protocol: string;
  bytesSent: number;
  bytesReceived: number;
}

export default function NetworkLab() {
  const [role, setRole] = useState<Role>("choose");
  const [state, setState] = useState<LinkState>("idle");
  const [localCode, setLocalCode] = useState("");
  const [remoteCode, setRemoteCode] = useState("");
  const [error, setError] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "manual">("idle");
  const [copying, setCopying] = useState(false);
  const [network, setNetwork] = useState<NetworkSnapshot>(EMPTY_NETWORK);
  const [connection, setConnection] = useState<ConnectionInfo>({ path: "Not connected", protocol: "—", bytesSent: 0, bytesReceived: 0 });
  const transportRef = useRef<WebRTCTransport | null>(null);
  const diagnosticsRef = useRef(new NetworkDiagnostics());
  const sequence = useRef(0);
  const cleanups = useRef<Array<() => void>>([]);
  const mounted = useRef(false), copyReserved = useRef(false), copyGeneration = useRef(0);
  const connectionGeneration = useRef(0);
  const copiedTimer = useRef<number | undefined>(undefined);
  const ownsConnection = (revision: number, transport?: WebRTCTransport) => mounted.current &&
    connectionGeneration.current === revision && (!transport || transportRef.current === transport);

  const invalidateCopy = () => {
    copyGeneration.current++;
    if (copiedTimer.current !== undefined) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = undefined; setCopyState("idle");
  };
  const replaceLocalCode = (code: string) => {
    invalidateCopy(); setLocalCode(code);
  };
  const resetTransport = async (revision: number) => {
    invalidateCopy();
    const transport = transportRef.current;
    cleanups.current.forEach((cleanup) => cleanup());
    cleanups.current = [];
    await transport?.disconnect();
    if (!ownsConnection(revision)) return;
    transportRef.current = null;
    diagnosticsRef.current = new NetworkDiagnostics();
    setNetwork(EMPTY_NETWORK);
    setConnection({ path: "Not connected", protocol: "—", bytesSent: 0, bytesReceived: 0 });
  };

  const installTransport = (transport: WebRTCTransport, revision: number) => {
    transportRef.current = transport;
    cleanups.current.push(transport.onStateChange(state => { if (ownsConnection(revision, transport)) setState(state); }));
    cleanups.current.push(transport.onMessage((message) => {
      if (!ownsConnection(revision, transport)) return;
      if (message.channel === "realtime" && !("type" in message.payload)) diagnosticsRef.current.observeFrame(message.payload);
      if (message.channel === "control" && message.payload.type === "ping") {
        transport.sendReliable({ type: "pong", sentAt: message.payload.sentAt, receivedAt: performance.now() });
      }
      if (message.channel === "control" && message.payload.type === "pong") {
        diagnosticsRef.current.observeRoundTrip(performance.now() - message.payload.sentAt);
      }
    }));
  };

  const becomeHost = async () => {
    const revision = ++connectionGeneration.current;
    setError("");
    setRole("host");
    replaceLocalCode("");
    setRemoteCode("");
    try {
      await resetTransport(revision);
      if (!ownsConnection(revision)) return;
      const transport = new WebRTCTransport({ initiator: true, iceServers: [] });
      installTransport(transport, revision);
      const code = await transport.createOfferCode();
      if (ownsConnection(revision, transport)) replaceLocalCode(code);
    } catch (cause) {
      if (!ownsConnection(revision)) return;
      setState("failed");
      setError(cause instanceof Error ? cause.message : "Could not create a local offer");
    }
  };

  const becomeController = async () => {
    const revision = ++connectionGeneration.current;
    setError("");
    setRole("controller");
    replaceLocalCode("");
    setRemoteCode("");
    try {
      await resetTransport(revision);
      if (ownsConnection(revision)) setState("idle");
    } catch (cause) {
      if (!ownsConnection(revision)) return;
      setState("failed");
      setError(cause instanceof Error ? cause.message : "Could not close this connection");
    }
  };

  const createAnswer = async () => {
    const revision = ++connectionGeneration.current;
    setError("");
    replaceLocalCode("");
    try {
      await resetTransport(revision);
      if (!ownsConnection(revision)) return;
      const transport = new WebRTCTransport({ initiator: false, iceServers: [] });
      installTransport(transport, revision);
      const code = await transport.acceptOfferCode(remoteCode);
      if (ownsConnection(revision, transport)) replaceLocalCode(code);
    } catch (cause) {
      if (!ownsConnection(revision)) return;
      setState("failed");
      setError(cause instanceof Error ? cause.message : "Could not accept this offer");
    }
  };

  const acceptAnswer = async () => {
    const revision = connectionGeneration.current, transport = transportRef.current;
    setError("");
    if (!transport) return;
    try {
      await transport.acceptAnswerCode(remoteCode);
    } catch (cause) {
      if (!ownsConnection(revision, transport)) return;
      setState("failed");
      setError(cause instanceof Error ? cause.message : "Could not accept this answer");
    }
  };

  const changeRole = async () => {
    const revision = ++connectionGeneration.current;
    setRole("choose"); setState("idle"); setError(""); replaceLocalCode("");
    try { await resetTransport(revision); }
    catch (cause) {
      if (!ownsConnection(revision)) return;
      setState("failed");
      setError(cause instanceof Error ? cause.message : "Could not close this connection");
    }
  };

  useEffect(() => {
    if (state !== "connected") return;
    const transport = transportRef.current, revision = connectionGeneration.current;
    if (!transport) return;
    const probe = window.setInterval(() => {
      if (!mounted.current || connectionGeneration.current !== revision || transportRef.current !== transport) return;
      const now = performance.now();
      diagnosticsRef.current.sentPing();
      transport.sendReliable({ type: "ping", sentAt: now });
      const frame: InputFrame = {
        deviceId: role === "host" ? "network-host" : "network-controller",
        playerId: "player-1",
        sequence: ++sequence.current,
        timestamp: now,
        source: "custom",
        actions: { probe: true },
        axes: { signal: Math.sin(sequence.current / 8) },
      };
      transport.sendRealtime(frame);
    }, 100);
    return () => window.clearInterval(probe);
  }, [role, state]);

  useEffect(() => {
    let reporting = false;
    const report = window.setInterval(async () => {
      if (!mounted.current) return;
      setNetwork(diagnosticsRef.current.snapshot());
      const transport = transportRef.current;
      if (!transport || reporting) return;
      const revision = connectionGeneration.current;
      const current = () => mounted.current && connectionGeneration.current === revision && transportRef.current === transport;
      reporting = true;
      try {
        const stats = await transport.stats();
        if (!stats || !current()) return;
        let bytesSent = 0;
        let bytesReceived = 0;
        let path = "Peer-to-peer";
        let protocol = "WebRTC DataChannel";
        stats.forEach((entry) => {
          if (entry.type === "data-channel") {
            bytesSent += Number(entry.bytesSent ?? 0);
            bytesReceived += Number(entry.bytesReceived ?? 0);
          }
          if (entry.type === "candidate-pair" && entry.nominated) {
            protocol = String(entry.state ?? "connected").toUpperCase();
            const remote = stats.get(entry.remoteCandidateId);
            const local = stats.get(entry.localCandidateId);
            const remoteType = remote?.candidateType ?? "peer";
            const localType = local?.candidateType ?? "local";
            path = `${localType} → ${remoteType}`;
          }
        });
        if (current()) setConnection({ path, protocol, bytesSent, bytesReceived });
      } catch {
        if (current()) setError("Connection details are unavailable. Change role to retry.");
      } finally { reporting = false; }
    }, 450);
    return () => window.clearInterval(report);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Invalidate the latest copy generation; this is not a captured DOM ref.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      copyGeneration.current++;
      // Retire all issued connection work using the latest generation.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      connectionGeneration.current++;
      if (copiedTimer.current !== undefined) window.clearTimeout(copiedTimer.current);
      cleanups.current.forEach((cleanup) => cleanup());
      void transportRef.current?.disconnect();
    };
  }, []);

  const copyCode = async () => {
    if (!localCode || copyReserved.current) return;
    const revision = copyGeneration.current;
    const current = () => mounted.current && copyGeneration.current === revision;
    copyReserved.current = true; setCopying(true); setCopyState("idle");
    if (copiedTimer.current !== undefined) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = undefined;
    try {
      const phase = await copyInvitationLink({ url: localCode, isCurrent: current,
        writeText: text => navigator.clipboard?.writeText(text) });
      if (!current() || phase === "stopped") return;
      setCopyState(phase);
      if (phase === "copied") copiedTimer.current = window.setTimeout(() => {
        if (current()) setCopyState("idle");
        copiedTimer.current = undefined;
      }, 1200);
    } finally {
      copyReserved.current = false;
      if (mounted.current) setCopying(false);
    }
  };

  return (
    <main className="network-page">
      <header className="network-topbar">
        <Link className="wordmark" href="/"><span className="mark-block">101</span><span className="mark-label">NETWORK LAB</span></Link>
        <div className={`network-state state-${state}`}><i />{state.toUpperCase()}</div>
      </header>

      <section className="network-intro">
        <p className="eyebrow">Manual peer pairing</p>
        <h1>Connect two browsers.<br />No signaling server.</h1>
        <p>Exchange an offer and answer manually. 101 opens a reliable control channel and a disposable realtime channel directly between the peers.</p>
      </section>

      {role === "choose" ? (
        <section className="role-choice">
          <button onClick={becomeHost}><span>01</span><strong>Create host offer</strong><p>This screen runs the 101 game or Network Lab.</p><b>Start as host →</b></button>
          <button onClick={becomeController}><span>02</span><strong>Join as controller</strong><p>This screen becomes the phone or second browser.</p><b>Start as controller →</b></button>
        </section>
      ) : (
        <section className="pair-workbench">
          <div className="pair-column">
            <div className="column-heading"><span>{role === "host" ? "HOST" : "CONTROLLER"}</span><button onClick={() => void changeRole()}>Change role</button></div>
            <h2>{role === "host" ? "1. Send this offer" : "2. Send this answer back"}</h2>
            <p>{role === "host" ? "Copy this code to the controller. It contains only local WebRTC session data." : "After importing the host offer, copy this answer back to the host."}</p>
            <textarea readOnly value={localCode} placeholder={role === "controller" ? "Your answer will appear here" : "Creating local offer…"} aria-label="Local pairing code" aria-describedby="network-copy-status" />
            <button className="primary-button" disabled={!localCode || copying} onClick={() => void copyCode()}>{copying ? "Copying…" : copyState === "copied" ? "Copied" : "Copy pairing code"}</button>
            <p id="network-copy-status" role="status">{copying ? "Waiting for permission to copy. You can select and copy the field yourself." :
              copyState === "manual" ? "Copying is unavailable. Select and copy the pairing code from its field." :
                copyState === "copied" ? "Pairing code copied." : localCode ? "Copy the code, or select and copy it from the field." : "Your pairing code will appear here."}</p>
          </div>

          <div className="pair-column remote-column">
            <div className="column-heading"><span>REMOTE DATA</span><i>PASTE ONLY</i></div>
            <h2>{role === "host" ? "3. Import the answer" : "1. Import the offer"}</h2>
            <p>Pairing codes are validated, size-limited, versioned, and checked for accidental corruption.</p>
            <textarea value={remoteCode} onChange={(event) => setRemoteCode(event.target.value)} placeholder={role === "host" ? "Paste the controller answer" : "Paste the host offer"} aria-label="Remote pairing code" />
            <button className="outline-button" disabled={!remoteCode.trim()} onClick={role === "host" ? acceptAnswer : createAnswer}>{role === "host" ? "Accept answer" : "Create answer"} →</button>
            {error && <p className="pair-error" role="alert">{error}</p>}
          </div>
        </section>
      )}

      <section className="network-metrics">
        <article><span>ROUND TRIP</span><strong>{network.roundTripMs}<small>ms</small></strong><i /></article>
        <article><span>JITTER</span><strong>{network.jitterMs}<small>ms</small></strong><i /></article>
        <article><span>DROPPED</span><strong>{network.droppedPercent}<small>%</small></strong><i /></article>
        <article><span>PACKETS</span><strong>{network.receivedPackets}</strong><i /></article>
      </section>

      <section className="connection-readout">
        <div><span>CONNECTION PATH</span><strong>{connection.path}</strong></div>
        <div><span>CHANNEL STATE</span><strong>{connection.protocol}</strong></div>
        <div><span>BYTES SENT / RECEIVED</span><strong>{connection.bytesSent} / {connection.bytesReceived}</strong></div>
        <div><span>ICE SERVERS</span><strong>NONE — STRICT LOCAL</strong></div>
      </section>

      <p className="network-privacy"><b>LOCALITY NOTE</b> This lab configures no STUN or TURN servers. That guarantees no 101 relay/signaling service is used, but it also means some network/browser combinations will not connect. The production Link flow will report its actual transport instead of hiding that tradeoff.</p>
    </main>
  );
}
