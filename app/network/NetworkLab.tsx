"use client";

import { NetworkDiagnostics, type NetworkSnapshot } from "@101/diagnostics";
import type { InputFrame } from "@101/input";
import { WebRTCTransport, type LinkState } from "@101/protocol";
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
  const [copied, setCopied] = useState(false);
  const [network, setNetwork] = useState<NetworkSnapshot>(EMPTY_NETWORK);
  const [connection, setConnection] = useState<ConnectionInfo>({ path: "Not connected", protocol: "—", bytesSent: 0, bytesReceived: 0 });
  const transportRef = useRef<WebRTCTransport | null>(null);
  const diagnosticsRef = useRef(new NetworkDiagnostics());
  const sequence = useRef(0);
  const cleanups = useRef<Array<() => void>>([]);

  const resetTransport = async () => {
    cleanups.current.forEach((cleanup) => cleanup());
    cleanups.current = [];
    await transportRef.current?.disconnect();
    transportRef.current = null;
    diagnosticsRef.current = new NetworkDiagnostics();
    setNetwork(EMPTY_NETWORK);
    setConnection({ path: "Not connected", protocol: "—", bytesSent: 0, bytesReceived: 0 });
  };

  const installTransport = (transport: WebRTCTransport) => {
    transportRef.current = transport;
    cleanups.current.push(transport.onStateChange(setState));
    cleanups.current.push(transport.onMessage((message) => {
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
    setError("");
    setRole("host");
    setLocalCode("");
    setRemoteCode("");
    try {
      await resetTransport();
      const transport = new WebRTCTransport({ initiator: true, iceServers: [] });
      installTransport(transport);
      setLocalCode(await transport.createOfferCode());
    } catch (cause) {
      setState("failed");
      setError(cause instanceof Error ? cause.message : "Could not create a local offer");
    }
  };

  const becomeController = async () => {
    setError("");
    setRole("controller");
    setLocalCode("");
    setRemoteCode("");
    await resetTransport();
    setState("idle");
  };

  const createAnswer = async () => {
    setError("");
    try {
      await resetTransport();
      const transport = new WebRTCTransport({ initiator: false, iceServers: [] });
      installTransport(transport);
      setLocalCode(await transport.acceptOfferCode(remoteCode));
    } catch (cause) {
      setState("failed");
      setError(cause instanceof Error ? cause.message : "Could not accept this offer");
    }
  };

  const acceptAnswer = async () => {
    setError("");
    try {
      await transportRef.current?.acceptAnswerCode(remoteCode);
    } catch (cause) {
      setState("failed");
      setError(cause instanceof Error ? cause.message : "Could not accept this answer");
    }
  };

  useEffect(() => {
    if (state !== "connected") return;
    const probe = window.setInterval(() => {
      const transport = transportRef.current;
      if (!transport) return;
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
    const report = window.setInterval(async () => {
      setNetwork(diagnosticsRef.current.snapshot());
      const stats = await transportRef.current?.stats();
      if (!stats) return;
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
      setConnection({ path, protocol, bytesSent, bytesReceived });
    }, 450);
    return () => window.clearInterval(report);
  }, []);

  useEffect(() => () => {
    cleanups.current.forEach((cleanup) => cleanup());
    void transportRef.current?.disconnect();
  }, []);

  const copyCode = async () => {
    await navigator.clipboard?.writeText(localCode);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <main className="network-page">
      <header className="network-topbar">
        <Link className="wordmark" href="/"><span className="mark-block">101</span><span className="mark-label">NETWORK LAB</span></Link>
        <div className={`network-state state-${state}`}><i />{state.toUpperCase()}</div>
      </header>

      <section className="network-intro">
        <p className="eyebrow">Diagnostic 02 · Manual offline WebRTC</p>
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
            <div className="column-heading"><span>{role === "host" ? "HOST" : "CONTROLLER"}</span><button onClick={() => { void resetTransport(); setRole("choose"); setState("idle"); }}>Change role</button></div>
            <h2>{role === "host" ? "1. Send this offer" : "2. Send this answer back"}</h2>
            <p>{role === "host" ? "Copy this code to the controller. It contains only local WebRTC session data." : "After importing the host offer, copy this answer back to the host."}</p>
            <textarea readOnly value={localCode} placeholder={role === "controller" ? "Your answer will appear here" : "Creating local offer…"} aria-label="Local pairing code" />
            <button className="primary-button" disabled={!localCode} onClick={copyCode}>{copied ? "Copied" : "Copy pairing code"}</button>
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
