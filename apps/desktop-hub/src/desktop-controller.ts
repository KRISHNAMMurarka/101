import { RemoteClockMap } from "@101/connect";
import { AutomaticPairingHost, HttpHostSignalingClient } from "@101/pairing";
import { MultiplexLinkTransport } from "@101/protocol";
import type { LinkMessage } from "@101/protocol";
import { SessionHost } from "@101/session";
import type { SessionSnapshot } from "@101/session";
import type { InputFrame } from "@101/input";
import type { DesktopInputBridge, DesktopInputCommand } from "./desktop-input.ts";

const ROLE = "desktop-control";
const PLAYER = "desktop-controller";
const MAX_SOURCE_AGE_MS = 250;
const KEY_NAMES = ["Left", "Right", "Up", "Down", "Space", "Return", "Escape", "Tab"] as const;
const ACTION_NAMES = ["left", "right", ...KEY_NAMES.map(key => `key${key}`)] as const;
export const desktopControlLayout = Object.freeze({ title: "Desktop control", layout: [
  { type: "touch-surface" as const, action: "pointer", pressAction: "left", label: "Pointer and left click" },
  { type: "button" as const, action: "right", label: "Right click" },
  ...KEY_NAMES.map(key => ({ type: "button" as const, action: `key${key}`, label: key })),
] });

interface PairingLifecycle { start(): Promise<void>; stop(): Promise<void> }
export interface DesktopControllerOptions {
  transport: MultiplexLinkTransport; pairing: PairingLifecycle; bridge: DesktopInputBridge;
  now: () => number;
  onChange?: (snapshot: SessionSnapshot) => void;
}
interface Probe { localSentAt: number; remoteReceivedAt?: number }

/** Dedicated single-peer SessionHost. The selected signaling peer route, role,
 * controller frame identity, clock interval, public route, and native approval
 * all have separate admission checks. A paired phone alone grants no input.
 */
export class DesktopController {
  readonly session: SessionHost;
  private readonly transport: MultiplexLinkTransport;
  private readonly pairing: PairingLifecycle;
  private readonly bridge: DesktopInputBridge;
  private readonly now: () => number;
  private readonly clock = new RemoteClockMap({ localClockId: "hub:performance", remoteClockId: "phone:performance",
    maxRttMs: 200, maxUncertaintyMs: 20, maxDriftPpm: 100, maxAgeMs: 500 });
  private selectedId?: string;
  private probe?: Probe;
  private lastSequence = 0;
  private lastRemoteAt = -Infinity;
  private lastPoint?: { x: number; y: number };
  private held = new Set<string>();
  private detach?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private started = false;
  private controlNeedsStop = false;
  private pairingNeedsStop = false;
  private sessionNeedsStop = false;
  private stopping?: Promise<void>;
  private generation = 0;
  constructor(options: DesktopControllerOptions) {
    this.transport = options.transport; this.pairing = options.pairing; this.bridge = options.bridge; this.now = options.now;
    this.session = new SessionHost({ gameId: ROLE,
      roles: [{ id: ROLE, label: "Desktop controller", playerId: PLAYER, requiredCapabilities: ["touch"], layout: desktopControlLayout }],
      transport: this.transport, now: this.now, deviceTimeoutMs: 3000,
      onFrame: frame => this.frame(frame),
      onDeviceReset: id => { if (id === this.selectedId) void this.stopControl(); },
      onChange: snapshot => {
        options.onChange?.(snapshot);
        if (this.selectedId && !this.admitsIdentity(this.selectedId)) void this.stopControl();
      },
    });
  }
  async start(): Promise<void> {
    if (this.started) return;
    if (this.stopping || this.controlNeedsStop || this.pairingNeedsStop || this.sessionNeedsStop)
      throw new Error("Desktop controller shutdown is incomplete");
    this.started = true;
    this.detach = this.transport.onMessage(message => this.control(message));
    this.controlNeedsStop = true;
    this.sessionNeedsStop = true;
    try {
      await this.session.start();
      if (!this.started) return;
      this.pairingNeedsStop = true;
      await this.pairing.start();
      if (!this.started) return;
      this.timer = setInterval(() => this.tick(), 250);
    } catch (error) {
      try { await this.stop(); }
      catch (stopError) { throw new AggregateError([error, stopError], "Desktop controller start and shutdown failed"); }
      throw error;
    }
  }
  candidates(): readonly { id: string; label: string }[] {
    return this.session.session.snapshot().devices.filter(device => device.capabilities.touch === true)
      .map(device => ({ id: device.id, label: device.label }));
  }
  private admitsIdentity(id: string): boolean {
    const routes = this.transport.ids();
    const snapshot = this.session.session.snapshot();
    return routes.length === 1 && routes[0] === id && snapshot.devices.some(device => device.id === id && device.capabilities.touch === true) &&
      snapshot.assignments.some(assignment => assignment.deviceId === id && assignment.roleId === ROLE && assignment.playerId === PLAYER);
  }
  async selectController(id: string): Promise<boolean> {
    if (!this.started || this.selectedId || !this.admitsIdentity(id)) return false;
    this.selectedId = id; this.generation++;
    this.clock.reset(); this.lastSequence = 0; this.lastRemoteAt = -Infinity; this.held.clear(); this.lastPoint = undefined;
    return true;
  }
  async approveWindow(): Promise<boolean> {
    const selected = this.selectedId, generation = this.generation;
    if (!selected || !this.admitsIdentity(selected)) return false;
    try {
      await this.bridge.select();
      if (generation !== this.generation || !this.admitsIdentity(selected)) { await this.bridge.stop(); return false; }
      return this.bridge.startRoutes();
    } catch { await this.bridge.stop().catch(() => {}); return false; }
  }
  private tick(): void {
    const id = this.selectedId;
    if (!id) return;
    if (!this.admitsIdentity(id)) { void this.stopControl(); return; }
    const at = this.now();
    if (this.probe && at - this.probe.localSentAt > 200) { this.probe = undefined; this.clock.reset(); }
    if (!this.probe) {
      this.probe = { localSentAt: at };
      this.transport.sendReliable({ type: "ping", deviceId: id, sentAt: at });
    }
  }
  private control(message: LinkMessage): void {
    const id = this.selectedId;
    if (!id || !this.admitsIdentity(id) || message.channel !== "control") return;
    const packet = message.payload, pending = this.probe;
    if (!pending) return;
    if (packet.type === "pong" && packet.sentAt === pending.localSentAt && Number.isFinite(packet.receivedAt)) {
      pending.remoteReceivedAt = packet.receivedAt;
    } else if (packet.type === "ping" && !("deviceId" in packet) && pending.remoteReceivedAt !== undefined) {
      const observed = this.clock.observe({ localSentAt: pending.localSentAt,
        remoteReceivedAt: pending.remoteReceivedAt, remoteSentAt: packet.sentAt, localReceivedAt: this.now() });
      this.probe = undefined;
      if (!observed) this.clock.reset();
    }
  }
  private frame(frame: InputFrame): void {
    const id = this.selectedId, generation = this.generation, at = this.now();
    if (!id || this.selectedId !== id || generation !== this.generation || !this.admitsIdentity(id) ||
      frame.deviceId !== id || frame.playerId !== PLAYER || frame.source !== "touch" ||
      !Number.isSafeInteger(frame.sequence) || frame.sequence <= this.lastSequence || !Number.isFinite(frame.timestamp) ||
      frame.timestamp <= this.lastRemoteAt || Object.keys(frame.actions).some(name => !ACTION_NAMES.includes(name as typeof ACTION_NAMES[number])) ||
      Object.keys(frame.vectors ?? {}).some(name => name !== "pointer") || Object.keys(frame.axes ?? {}).length > 0 ||
      Object.keys(frame.poses ?? {}).length > 0) return;
    const deadline = this.clock.translate(frame.timestamp + MAX_SOURCE_AGE_MS, at)?.earliest;
    if (deadline === undefined || deadline <= at || deadline > at + MAX_SOURCE_AGE_MS) return;
    const vector = frame.vectors?.pointer;
    if (vector && (!Number.isFinite(vector.x) || !Number.isFinite(vector.y) || vector.x < 0 || vector.x > 1 || vector.y < 0 || vector.y > 1)) return;
    for (const name of ACTION_NAMES) if (frame.actions[name] !== undefined && typeof frame.actions[name] !== "boolean") return;
    this.lastSequence = frame.sequence; this.lastRemoteAt = frame.timestamp;
    if (this.selectedId !== id || generation !== this.generation) return;
    if (vector) { this.lastPoint = { x: vector.x, y: vector.y }; this.bridge.publish({ type: "pointer", ...this.lastPoint }, deadline); }
    for (const name of ACTION_NAMES) {
      if (this.selectedId !== id || generation !== this.generation) return;
      const down = frame.actions[name] === true;
      if (down === this.held.has(name)) continue;
      let command: DesktopInputCommand;
      if (name === "left" || name === "right") {
        if (!this.lastPoint) continue;
        command = { type: "button", button: name === "left" ? "Left" : "Right", down, ...this.lastPoint };
      } else command = { type: "key", key: name.slice(3) as (typeof KEY_NAMES)[number], down };
      if (this.bridge.publish(command, deadline).ok) {
        if (down) this.held.add(name); else this.held.delete(name);
      }
    }
  }
  async stopControl(): Promise<void> {
    this.generation++; this.selectedId = undefined; this.probe = undefined; this.clock.reset(); this.held.clear(); this.lastPoint = undefined;
    await this.bridge.stop();
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (!this.started && !this.controlNeedsStop && !this.pairingNeedsStop && !this.sessionNeedsStop)
      return Promise.resolve();
    this.started = false;
    if (this.timer) clearInterval(this.timer); this.timer = undefined;
    this.detach?.(); this.detach = undefined;
    // Reserve the joined teardown before any bridge, pairing, or transport
    // callback can reenter. Each failed owner remains available for retry.
    const task = Promise.resolve().then(async () => {
      const stages: { name: "control" | "pairing" | "session"; run: () => Promise<void> }[] = [];
      if (this.controlNeedsStop) stages.push({ name: "control", run: () => this.stopControl() });
      if (this.pairingNeedsStop) stages.push({ name: "pairing", run: () => this.pairing.stop() });
      if (this.sessionNeedsStop) stages.push({ name: "session", run: () => this.session.stop() });
      const results = await Promise.allSettled(stages.map(stage => Promise.resolve().then(stage.run)));
      let failure: unknown, failed = false;
      results.forEach((result, index) => {
        if (result.status === "rejected") { if (!failed) failure = result.reason; failed = true; return; }
        switch (stages[index]!.name) {
          case "control": this.controlNeedsStop = false; break;
          case "pairing": this.pairingNeedsStop = false; break;
          case "session": this.sessionNeedsStop = false; break;
        }
      });
      if (failed) throw failure;
    });
    const settled = task.finally(() => { if (this.stopping === settled) this.stopping = undefined; });
    this.stopping = settled;
    return settled;
  }
}

export function createDesktopController(options: Omit<DesktopControllerOptions, "transport" | "pairing"> &
    { endpoint: string; sessionId: string; hostToken: string }): DesktopController {
  const transport = new MultiplexLinkTransport();
  const signaling = new HttpHostSignalingClient(options.endpoint, options.sessionId, options.hostToken);
  const pairing = new AutomaticPairingHost({ signaling, transport });
  return new DesktopController({ transport, pairing, bridge: options.bridge, now: options.now, onChange: options.onChange });
}
