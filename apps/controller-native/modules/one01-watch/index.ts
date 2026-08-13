import { NativeModule, requireNativeModule, type EventSubscription } from "expo-modules-core";

/**
 * Phone-side receiver for wrist samples relayed by the 101 watch companions.
 *
 * The two platforms use entirely different frameworks — Watch Connectivity on iOS, the Wearable
 * Data Layer on Android — but both deliver the same 53-byte payload, so this exposes one interface
 * and `@101/adapter-watch` decodes it without a per-platform branch.
 *
 * Bytes cross the bridge base64-encoded because that is the only binary representation both Expo
 * platforms pass reliably; it costs about a third more size on a link that is already local, and
 * buys a single code path.
 */
export interface WatchLinkSnapshot {
  /** "watchos" or "wearos". */
  platform: "watchos" | "wearos";
  companionPaired: boolean;
  appInstalled: boolean;
  reachable: boolean;
  /** Wear OS only. Undefined on watchOS, where proximity is not the deciding signal. */
  nearby?: boolean;
}

export interface WatchSampleEvent {
  /** Base64-encoded 53-byte payload. */
  data: string;
}

type One01WatchEvents = {
  onWatchSample: (event: WatchSampleEvent) => void;
  onWatchLinkChange: (snapshot: WatchLinkSnapshot) => void;
};

declare class One01WatchNativeModule extends NativeModule<One01WatchEvents> {
  /** True when the platform can receive watch samples at all. */
  isSupported(): boolean;
  /** Begins listening. Safe to call repeatedly. */
  start(): Promise<WatchLinkSnapshot>;
  stop(): Promise<void>;
  /** Current companion state; locality is derived in `@101/adapter-watch`, never asserted here. */
  getLinkState(): Promise<WatchLinkSnapshot>;
  /** Sends a short haptic on the watch, where the platform supports it. */
  playHaptic(): Promise<void>;
}

const native = requireNativeModule<One01WatchNativeModule>("One01Watch");

export function isWatchSupported() {
  return native.isSupported();
}

export function startWatchRelay() {
  return native.start();
}

export function stopWatchRelay() {
  return native.stop();
}

export function getWatchLinkState() {
  return native.getLinkState();
}

export function playWatchHaptic() {
  return native.playHaptic();
}

export function addWatchSampleListener(listener: (event: WatchSampleEvent) => void): EventSubscription {
  return native.addListener("onWatchSample", listener);
}

export function addWatchLinkListener(listener: (event: WatchLinkSnapshot) => void): EventSubscription {
  return native.addListener("onWatchLinkChange", listener);
}
