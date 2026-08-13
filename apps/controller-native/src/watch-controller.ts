import {
  WatchInputAdapter,
  decodeWatchPayload,
  isStrictlyLocal,
  type WatchLinkStatus,
  type WatchPlatform,
} from "@101/adapter-watch";
import type { InputFrame } from "@101/input";

/**
 * Minimal shape of the native watch bridge, declared here rather than imported so this controller
 * can be unit-tested without a native runtime. `modules/one01-watch` satisfies it on device.
 */
export interface WatchBridge {
  isWatchSupported(): boolean;
  startWatchRelay(): Promise<WatchLinkSnapshot>;
  stopWatchRelay(): Promise<void>;
  getWatchLinkState(): Promise<WatchLinkSnapshot>;
  addWatchSampleListener(listener: (event: { data: string }) => void): { remove(): void };
  addWatchLinkListener(listener: (snapshot: WatchLinkSnapshot) => void): { remove(): void };
}

export interface WatchLinkSnapshot {
  platform: WatchPlatform;
  companionPaired: boolean;
  appInstalled: boolean;
  reachable: boolean;
  nearby?: boolean;
}

export interface WatchControllerEvents {
  onFrame(frame: InputFrame): void;
  onStatus?(status: WatchLinkStatus): void;
  onError?(message: string): void;
}

/**
 * Turns relayed watch payloads into 101 input frames inside 101 Link.
 *
 * The phone already owns a session, a device identity and a transport, so the watch adds a source
 * rather than a second peer. Frames carry the phone's own player identity, which is what makes
 * "phone tracks orientation while the watch detects rapid wrist movement" work with no game code:
 * both sources merge in the Input Bus under one player.
 */
export class WatchController {
  private readonly bridge: WatchBridge;
  private readonly events: WatchControllerEvents;
  private adapter?: WatchInputAdapter;
  private subscriptions: Array<{ remove(): void }> = [];
  private decodeFailures = 0;

  constructor(bridge: WatchBridge, events: WatchControllerEvents) {
    this.bridge = bridge;
    this.events = events;
  }

  get supported() {
    return this.bridge.isWatchSupported();
  }

  get status() {
    return this.adapter?.linkStatus;
  }

  /** True only when the route is proven device-to-device. */
  get strictlyLocal() {
    const status = this.adapter?.linkStatus;
    return status ? isStrictlyLocal(status) : false;
  }

  /** Payloads that failed to decode. A non-zero count means the watch app is out of date. */
  get rejectedSamples() {
    return this.decodeFailures;
  }

  async start(playerId: string) {
    if (this.adapter) return this.adapter.linkStatus;
    if (!this.bridge.isWatchSupported()) throw new Error("This device cannot receive watch input");

    const snapshot = await this.bridge.startWatchRelay();
    const adapter = new WatchInputAdapter({
      platform: snapshot.platform,
      playerId,
      deviceId: `watch-${snapshot.platform}-${playerId}`,
      onStatus: (status) => this.events.onStatus?.(status),
    });
    this.adapter = adapter;
    adapter.start((frame) => this.events.onFrame(frame));
    adapter.updateLink(snapshot);

    this.subscriptions.push(
      this.bridge.addWatchSampleListener((event) => this.consume(event.data)),
      this.bridge.addWatchLinkListener((next) => adapter.updateLink(next)),
    );
    return adapter.linkStatus;
  }

  async stop() {
    for (const subscription of this.subscriptions) subscription.remove();
    this.subscriptions = [];
    // Stopping releases held wrist controls, so a removed watch cannot leave input applied.
    this.adapter?.stop();
    this.adapter = undefined;
    await this.bridge.stopWatchRelay().catch(() => undefined);
  }

  calibrate(orientation: readonly [number, number, number, number]) {
    this.adapter?.calibrateNeutral(orientation);
  }

  private consume(base64: string) {
    const adapter = this.adapter;
    if (!adapter) return;
    const bytes = decodeBase64(base64);
    const sample = bytes && decodeWatchPayload(bytes);
    if (!sample) {
      // A malformed packet is dropped, never allowed to interrupt the controller. The count is
      // surfaced so a version mismatch is diagnosable instead of looking like a dead watch.
      this.decodeFailures += 1;
      if (this.decodeFailures === 1) this.events.onError?.("A watch sample could not be decoded. The watch app may be a different version.");
      return;
    }
    adapter.push(sample);
  }
}

/**
 * Bytes cross the native bridge base64-encoded because that is the only binary representation both
 * Expo platforms pass reliably. `atob` exists in the Hermes runtime and in Node, so no polyfill or
 * extra dependency is needed; a malformed string yields undefined rather than throwing.
 */
function decodeBase64(value: string): Uint8Array | undefined {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return undefined;
  }
}
