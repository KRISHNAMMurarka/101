import { ControllerInputModel, type ControllerInputSnapshot } from "@101/link-controller";
import { HttpControllerSignalingClient, SignaledLinkTransport } from "@101/pairing";
import {
  INPUT_Q1_FORMAT,
  PROTOCOL_VERSION,
  type ControllerLayout,
  type ControlMessage,
  type LinkState,
  type SpeakerCueMessage,
  type StatefulLinkTransport,
} from "@101/protocol";
import type { InputSource } from "@101/input";
import { fetch as nativeFetch } from "expo/fetch";

import { NativeWebRTCTransport } from "./native-webrtc";
import { ticketFromInput } from "./pairing-code";
import { connectionErrorMessage } from "./link-error";
import { ControllerConfigurationGate, ControllerSpeakerGate } from "./controller-runtime-gates";

export interface ControllerAssignment {
  playerId: string;
  role: string;
  gameId: string;
}

export interface ControllerSessionEvents {
  state(state: LinkState): void;
  layout(layout: ControllerLayout, hostControlled: boolean): void;
  assignment(assignment?: ControllerAssignment): void;
  hostState(values: Record<string, string | number | boolean>, message?: string, tone?: "normal" | "warning" | "critical"): void;
  haptic(pattern: "tap" | "impact" | "warning"): void;
  speakerCue(message: SpeakerCueMessage): void;
  speakerDiscard(message: SpeakerCueMessage): void;
  speakerCancel(): void;
  speakerReset(): void;
  calibration(mode: string): void;
  latency(milliseconds: number): void;
  error(message: string): void;
}

export class ControllerSession {
  private transport?: StatefulLinkTransport;
  private removeMessage?: () => void;
  private removeState?: () => void;
  private removeError?: () => void;
  private heartbeat?: ReturnType<typeof setInterval>;
  private model = new ControllerInputModel();
  private currentLayout?: ControllerLayout;
  private assignment?: ControllerAssignment;
  private waitingForRole = false;
  private sequence = 0;
  private lifecycleRevision = 0;
  private readonly configurationGate = new ControllerConfigurationGate();
  private readonly speakerGate = new ControllerSpeakerGate();

  constructor(
    readonly deviceId: string,
    private readonly deviceLabel: string,
    private readonly events: ControllerSessionEvents,
  ) {}

  async connect(input: string) {
    const revision = ++this.lifecycleRevision;
    await this.clearConnection(revision);
    this.requireCurrent(revision);
    const ticket = ticketFromInput(input);
    // Expo's native adapter enforces manual redirects and omitted cookies for signaling.
    const fetcher = nativeFetch as unknown as typeof fetch;
    const signaling = new HttpControllerSignalingClient(ticket, (input, init) => {
      // The immutable client's leave retires its own lease after cancellation. Every other
      // request still needs this session owner, including dispatch after a reentrant state event.
      if (init?.method !== "DELETE") this.requireCurrent(revision);
      return fetcher(input, init);
    });
    const transport = new SignaledLinkTransport({
      signaling,
      device: {
        deviceId: this.deviceId,
        label: this.deviceLabel,
        capabilities: {
          touch: true,
          accelerometer: true,
          gyroscope: true,
          magnetometer: true,
          camera: true,
          microphone: false,
          haptics: true,
          speaker: true,
        },
      },
      transportFactory: () => new NativeWebRTCTransport(),
      pollIntervalMs: 650,
    });
    this.requireCurrent(revision);
    try {
      this.attachTransport(transport, revision);
      this.requireCurrent(revision, transport);
      await transport.connect();
      this.requireCurrent(revision, transport);
    } catch (error) {
      if (this.isCurrent(revision, transport)) this.events.error(connectionErrorMessage(error));
      if (this.isCurrent(revision, transport)) await this.disconnect();
      else await transport.disconnect();
      throw error;
    }
    return ticket;
  }

  async connectManual(offer: string) {
    const revision = ++this.lifecycleRevision;
    await this.clearConnection(revision);
    this.requireCurrent(revision);
    const transport = new NativeWebRTCTransport();
    this.requireCurrent(revision);
    try {
      this.attachTransport(transport, revision);
      this.requireCurrent(revision, transport);
      await transport.connect();
      this.requireCurrent(revision, transport);
      const answer = await transport.acceptOfferCode(offer);
      this.requireCurrent(revision, transport);
      return answer;
    } catch (error) {
      if (this.isCurrent(revision, transport)) this.events.error(connectionErrorMessage(error));
      if (this.isCurrent(revision, transport)) await this.disconnect();
      else await transport.disconnect();
      throw error;
    }
  }

  async disconnect() {
    const revision = ++this.lifecycleRevision;
    await this.clearConnection(revision);
  }

  private async clearConnection(revision: number) {
    // Detach the owned transport before awaiting it: a replacement may attach while its leave
    // request is still pending, and this cleanup must never erase that new connection.
    const transport = this.transport;
    const removeMessage = this.removeMessage;
    const removeState = this.removeState;
    const removeError = this.removeError;
    this.transport = undefined;
    this.removeMessage = undefined;
    this.removeState = undefined;
    this.removeError = undefined;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    removeMessage?.();
    removeState?.();
    removeError?.();
    this.assignment = undefined;
    this.waitingForRole = false;
    this.configurationGate.reset();
    const disconnected = transport?.disconnect();
    if (this.isCurrent(revision)) this.events.speakerReset();
    if (this.isCurrent(revision)) this.events.assignment(undefined);
    if (this.isCurrent(revision)) this.events.hostState({});
    await disconnected;
  }

  private isCurrent(revision: number, transport?: StatefulLinkTransport) {
    return revision === this.lifecycleRevision && (!transport || this.transport === transport);
  }

  private requireCurrent(revision: number, transport?: StatefulLinkTransport) {
    if (!this.isCurrent(revision, transport)) throw new Error("Connection cancelled");
  }

  setSpeakerReady(ready: boolean) {
    if (!this.speakerGate.setReady(ready, () => this.events.speakerCancel())) return;
    if (this.transport?.state === "connected") this.sendHello();
  }

  useLocalLayout(layout: ControllerLayout) {
    this.configurationGate.reset();
    this.currentLayout = layout;
    const transition = this.model.transition(layout);
    this.sendSnapshot(transition.release, "touch");
    this.events.layout(layout, false);
  }

  setAction(action: string, value: boolean | number, owner = "direct", source: InputSource = "touch") {
    this.setActions({ [action]: value }, owner, source);
  }

  setActions(values: Record<string, boolean | number>, owner = "direct", source: InputSource = "touch") {
    // A role change releases and replaces the model before React unmounts the old controls. Their
    // gesture cleanup may therefore arrive a moment later. Ignore names that no longer belong to
    // the current model so cleanup cannot re-introduce a stale action into the new game panel.
    const current = this.model.snapshot().actions;
    const accepted = Object.fromEntries(Object.entries(values).filter(([name]) => name in current));
    if (Object.keys(accepted).length === 0) return;
    this.sendSnapshot(this.model.setActions(accepted, owner), source);
  }

  setAxis(action: string, value: number, source: InputSource = "touch") {
    this.sendSnapshot(this.model.setAxis(action, value), source);
  }

  setVector(action: string, x: number, y: number, source: InputSource = "touch") {
    this.sendSnapshot(this.model.setVector(action, x, y), source);
  }

  setSurface(vectorAction: string, pressAction: string, x: number, y: number, held: boolean) {
    this.sendSnapshot(this.model.setSurface(vectorAction, pressAction, x, y, held), "touch");
  }

  setMotion(
    action: string,
    x: number,
    y: number,
    mappings: Partial<Record<"shake" | "swing" | "spin", string>>,
    triggered: Readonly<Record<"shake" | "swing" | "spin", boolean>>,
  ) {
    this.model.setVector(action, x, y);
    this.sendSnapshot(this.model.snapshot(), "phone-motion");
    for (const gesture of ["shake", "swing", "spin"] as const) {
      const mappedAction = mappings[gesture];
      if (mappedAction && triggered[gesture]) this.pulse(mappedAction, "phone-motion");
    }
  }

  releaseAll() {
    this.sendSnapshot(this.model.releaseAll(), "touch");
  }

  private pulse(action: string, source: InputSource) {
    this.sendSnapshot(this.model.setAction(action, true), source);
    setTimeout(() => this.sendSnapshot(this.model.setAction(action, false), source), 90);
  }

  private onConnected() {
    this.sendHello();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      const sentAt = Date.now();
      // A React game host may remount while this WebRTC peer stays connected. Re-announcing lets
      // the fresh SessionHost recover capabilities, binary configuration, and private audio.
      this.sendHello();
      // The device has to name itself, or the host cannot tell whose liveness this beat refreshes
      // and expires a perfectly healthy controller mid-game.
      this.transport?.sendReliable({ type: "ping", sentAt, deviceId: this.deviceId });
    }, 2_000);
    if (this.currentLayout) this.sendSnapshot(this.model.snapshot(), "touch");
  }

  private attachTransport(transport: StatefulLinkTransport, revision: number) {
    this.transport = transport;
    const removeMessage = transport.onMessage((message) => {
      if (!this.isCurrent(revision, transport)) return;
      if (message.channel === "control") this.handleControl(message.payload);
      if (message.channel === "realtime" && "type" in message.payload && message.payload.deviceId === this.deviceId) {
        if (message.payload.type === "haptic") this.events.haptic(message.payload.pattern);
        if (message.payload.type === "speaker.cue") {
          this.speakerGate.deliver(message.payload, this.events.speakerCue, this.events.speakerDiscard);
        }
      }
    });
    if (!this.isCurrent(revision, transport)) { removeMessage(); return; }
    this.removeMessage = removeMessage;
    const removeState = transport.onStateChange((state) => {
      if (!this.isCurrent(revision, transport)) return;
      this.events.state(state);
      if (this.isCurrent(revision, transport) && state === "connected") this.onConnected();
    });
    if (!this.isCurrent(revision, transport)) { removeState(); return; }
    this.removeState = removeState;
    // Signaling failures the transport recovers from. Without this the outage was invisible until
    // it surfaced as an unhandled-rejection toast; now the controller can explain itself.
    const removeError = withErrorChannel(transport)?.onError(() => {
      if (!this.isCurrent(revision, transport)) return;
      this.events.error("Connection interrupted. Retrying on this Wi-Fi…");
    });
    if (!this.isCurrent(revision, transport)) { removeError?.(); return; }
    this.removeError = removeError;
  }

  private sendHello() {
    this.transport?.sendReliable({
      type: "hello",
      version: PROTOCOL_VERSION,
      deviceId: this.deviceId,
      device: this.deviceLabel,
      capabilities: {
        touch: true,
        accelerometer: true,
        gyroscope: true,
        magnetometer: true,
        camera: true,
        microphone: false,
        haptics: true,
        speaker: true,
      },
      features: {
        inputFormats: [INPUT_Q1_FORMAT],
        speakerAudio: this.speakerGate.ready ? "ready" : "locked",
      },
    });
  }

  private handleControl(message: ControlMessage) {
    if ("deviceId" in message && message.deviceId !== this.deviceId) return;
    if (message.type === "player.assign") {
      if (this.waitingForRole) this.events.hostState({});
      this.waitingForRole = false;
      if (!this.assignment
        || this.assignment.playerId !== message.playerId
        || this.assignment.role !== message.role
        || this.assignment.gameId !== message.gameId) this.configurationGate.reset();
      this.assignment = { playerId: message.playerId, role: message.role, gameId: message.gameId };
      this.events.assignment(this.assignment);
    } else if (message.type === "player.wait") {
      this.assignment = undefined;
      this.waitingForRole = true;
      this.configurationGate.reset();
      this.events.assignment(undefined);
      this.events.hostState({}, "Waiting for an open controller role", "warning");
    } else if (message.type === "controller.configure") {
      if (!this.configurationGate.accept(message)) {
        this.sendSnapshot(this.model.snapshot(), "touch");
        return;
      }
      this.currentLayout = message.layout;
      const transition = this.model.transition(message.layout);
      this.sendSnapshot(transition.release, "touch");
      this.events.layout(message.layout, true);
    } else if (message.type === "controller.state") {
      this.events.hostState(message.values, message.message, message.tone);
    } else if (message.type === "haptic") {
      this.events.haptic(message.pattern);
    } else if (message.type === "calibration.request") {
      this.events.calibration(message.mode);
    } else if (message.type === "ping") {
      this.transport?.sendReliable({ type: "pong", sentAt: message.sentAt, receivedAt: Date.now() });
    } else if (message.type === "pong") {
      this.events.latency(Math.max(0, Date.now() - message.sentAt));
    }
  }

  private sendSnapshot(snapshot: ControllerInputSnapshot, source: InputSource) {
    if (!this.transport || this.transport.state !== "connected") return;
    this.transport.sendRealtime({
      deviceId: this.deviceId,
      playerId: this.assignment?.playerId ?? "player-1",
      sequence: ++this.sequence,
      timestamp: Date.now(),
      source,
      actions: snapshot.actions,
      axes: snapshot.axes,
      vectors: snapshot.vectors,
    });
  }
}

/**
 * Not every transport reports recoverable signaling failures. The same-browser and manual-offer
 * transports have no Hub to lose, so the channel is optional rather than part of the interface.
 */
function withErrorChannel(transport: StatefulLinkTransport) {
  const candidate = transport as StatefulLinkTransport & { onError?(listener: (error: Error) => void): () => void };
  return typeof candidate.onError === "function" ? { onError: candidate.onError.bind(candidate) } : undefined;
}
