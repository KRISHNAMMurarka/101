"use client";

import { useSyncExternalStore } from "react";

import type { DeviceCapabilities } from "@101/protocol";

import type { InputSource } from "@101/input";

/**
 * What this browser can actually contribute.
 *
 * The platform could describe a *remote* device's capabilities — `DeviceCapabilities` arrives in the
 * `hello` handshake and `resolveInputManifest` matches games against it — but nothing ever asked the
 * same question of the screen the player is sitting at. So the launcher could not answer "can I play
 * this right now, on this, alone?", which is the first question anyone has.
 *
 * Presence, not permission. `getUserMedia` existing does not mean a camera is allowed, and
 * DeviceMotionEvent existing does not mean iOS has granted it — those are prompts the player answers
 * later, at the point of use. Claiming otherwise here would put a green tick next to something that
 * then fails, which is worse than not claiming it.
 */
export function detectLocalCapabilities(): DeviceCapabilities {
  if (typeof window === "undefined") return {};
  const nav = window.navigator;
  return {
    touch: (nav.maxTouchPoints ?? 0) > 0,
    accelerometer: "DeviceMotionEvent" in window,
    gyroscope: "DeviceOrientationEvent" in window,
    magnetometer: "ondeviceorientationabsolute" in window,
    camera: Boolean(nav.mediaDevices?.getUserMedia),
    microphone: Boolean(nav.mediaDevices?.getUserMedia),
    haptics: "vibrate" in nav,
    // A connected pad, not the API existing. `"getGamepads" in navigator` is true in every modern
    // browser, so every desktop claimed a gamepad and cards read "Ready on this device" for games
    // the platform's own resolver said were not playable there. Browsers also withhold pads until
    // one is used, so this can be false at first paint and true later — which the store below
    // handles rather than pretending the answer is fixed.
    gamepad: typeof nav.getGamepads === "function" && nav.getGamepads().some((pad) => pad !== null),
    speaker: "AudioContext" in window || "webkitAudioContext" in window,
  };
}

/** The input sources this browser can drive on its own, in the vocabulary games already declare. */
export function localInputSources(capabilities = detectLocalCapabilities()): InputSource[] {
  const sources: InputSource[] = [];
  const fine = typeof window !== "undefined" && window.matchMedia?.("(pointer: fine)").matches;
  if (fine) sources.push("keyboard", "mouse");
  if (capabilities.touch) sources.push("touch");
  if (capabilities.gamepad) sources.push("gamepad");
  if (capabilities.gyroscope || capabilities.accelerometer) sources.push("phone-motion");
  if (capabilities.camera) sources.push("camera-hand", "camera-pose", "camera-face");
  return sources;
}

/**
 * A plain-language name for the shape of this device, used to tell the player which half of the
 * room they are holding. Deliberately three answers and not a device database.
 */
export function describeLocalDevice(): "phone" | "tablet" | "computer" {
  if (typeof window === "undefined") return "computer";
  const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  if (!coarse) return "computer";
  return Math.min(window.screen.width, window.screen.height) >= 600 ? "tablet" : "phone";
}

/**
 * The probe as a client-only store.
 *
 * Nothing here changes during a document's life — a browser does not grow a gyroscope — so the
 * snapshot is resolved once and held, which is both what `useSyncExternalStore` needs for a stable
 * reference and the reason this is not state that an effect should be assigning.
 */
export type LocalDevice = {
  capabilities: DeviceCapabilities;
  sources: InputSource[];
  shape: "phone" | "tablet" | "computer";
};

let resolvedDevice: LocalDevice | null = null;
const deviceListeners = new Set<() => void>();

function probe(): LocalDevice {
  const capabilities = detectLocalCapabilities();
  return { capabilities, sources: localInputSources(capabilities), shape: describeLocalDevice() };
}

/**
 * The snapshot is held rather than recomputed per call, because `useSyncExternalStore` compares by
 * reference and a fresh object every render is an infinite loop.
 */
function resolveLocalDevice(): LocalDevice {
  if (!resolvedDevice) resolvedDevice = probe();
  return resolvedDevice;
}

function refresh() {
  const next = probe();
  const changed = next.shape !== resolvedDevice?.shape
    || next.sources.length !== resolvedDevice.sources.length
    || next.sources.some((source, index) => source !== resolvedDevice?.sources[index]);
  if (!changed) return;
  resolvedDevice = next;
  for (const listener of deviceListeners) listener();
}

/**
 * Plugging in a pad changes the answer, and so does putting one down. Without this the first paint's
 * answer would be permanent, which is the same defect as the API-presence check it replaced — just
 * arrived at more slowly.
 */
function subscribeToDevice(listener: () => void) {
  deviceListeners.add(listener);
  if (deviceListeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("gamepadconnected", refresh);
    window.addEventListener("gamepaddisconnected", refresh);
  }
  return () => {
    deviceListeners.delete(listener);
    if (deviceListeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("gamepadconnected", refresh);
      window.removeEventListener("gamepaddisconnected", refresh);
    }
  };
}

const noDevice: LocalDevice = { capabilities: {}, sources: [], shape: "computer" };

/** `null`-shaped on the server: an empty probe, so the first paint claims nothing it cannot know. */
export function useLocalDevice(): LocalDevice {
  return useSyncExternalStore(subscribeToDevice, resolveLocalDevice, () => noDevice);
}
