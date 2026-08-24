import { ControllerInputModel, type ControllerInputSnapshot } from "@101/link-controller";
import { HttpControllerSignalingClient, SignaledLinkTransport } from "@101/pairing";
import {
  PROTOCOL_VERSION,
  type ControllerLayout,
  type ControlMessage,
  type LinkState,
  type StatefulLinkTransport,
} from "@101/protocol";
import type { InputSource } from "@101/input";

import { NativeWebRTCTransport } from "./native-webrtc";
import { ticketFromInput } from "./pairing-code";

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
  private sequence = 0;

  constructor(
    readonly deviceId: string,
    private readonly deviceLabel: string,
    private readonly events: ControllerSessionEvents,
  ) {}

  async connect(input: string) {
    await this.disconnect();
    const ticket = ticketFromInput(input);
    const signaling = new HttpControllerSignalingClient(ticket);
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
        },
      },
      transportFactory: () => new NativeWebRTCTransport(),
      pollIntervalMs: 650,
    });
    this.attachTransport(transport);
    try {
      await transport.connect();
    } catch (error) {
      this.events.error(errorMessage(error));
      await this.disconnect();
      throw error;
    }
    return ticket;
  }

  async connectManual(offer: string) {
    await this.disconnect();
    const transport = new NativeWebRTCTransport();
    this.attachTransport(transport);
    try {
      await transport.connect();
      return await transport.acceptOfferCode(offer);
    } catch (error) {
      this.events.error(errorMessage(error));
      await this.disconnect();
      throw error;
    }
  }

  async disconnect() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.removeMessage?.();
    this.removeState?.();
    this.removeError?.();
    this.removeMessage = undefined;
    this.removeState = undefined;
    this.removeError = undefined;
    await this.transport?.disconnect();
    this.transport = undefined;
    this.assignment = undefined;
    this.events.assignment(undefined);
  }

  useLocalLayout(layout: ControllerLayout) {
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
      // The device has to name itself, or the host cannot tell whose liveness this beat refreshes
      // and expires a perfectly healthy controller mid-game.
      this.transport?.sendReliable({ type: "ping", sentAt, deviceId: this.deviceId });
    }, 2_000);
    if (this.currentLayout) this.sendSnapshot(this.model.snapshot(), "touch");
  }

  private attachTransport(transport: StatefulLinkTransport) {
    this.transport = transport;
    this.removeMessage = transport.onMessage((message) => {
      if (message.channel === "control") this.handleControl(message.payload);
      if (message.channel === "realtime" && "type" in message.payload && message.payload.type === "haptic" && message.payload.deviceId === this.deviceId) {
        this.events.haptic(message.payload.pattern);
      }
    });
    this.removeState = transport.onStateChange((state) => {
      this.events.state(state);
      if (state === "connected") this.onConnected();
    });
    // Signaling failures the transport recovers from. Without this the outage was invisible until
    // it surfaced as an unhandled-rejection toast; now the controller can explain itself.
    this.removeError = withErrorChannel(transport)?.onError((error) => {
      this.events.error(`Hub unreachable — retrying. ${error.message}`);
    });
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
      },
    });
  }

  private handleControl(message: ControlMessage) {
    if ("deviceId" in message && message.deviceId !== this.deviceId) return;
    if (message.type === "player.assign") {
      this.assignment = { playerId: message.playerId, role: message.role, gameId: message.gameId };
      this.events.assignment(this.assignment);
    } else if (message.type === "player.wait") {
      this.assignment = undefined;
      this.events.assignment(undefined);
      this.events.hostState({}, "Waiting for an open controller role", "warning");
    } else if (message.type === "controller.configure") {
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "101 Link could not connect";
}

/**
 * Not every transport reports recoverable signaling failures. The same-browser and manual-offer
 * transports have no Hub to lose, so the channel is optional rather than part of the interface.
 */
function withErrorChannel(transport: StatefulLinkTransport) {
  const candidate = transport as StatefulLinkTransport & { onError?(listener: (error: Error) => void): () => void };
  return typeof candidate.onError === "function" ? { onError: candidate.onError.bind(candidate) } : undefined;
}
