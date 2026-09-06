"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether the navigation rail shows labels.
 *
 * A per-viewer convenience, so it lives in this browser and nowhere else, and every read and write
 * is guarded: a private window or a browser set to block site data throws on access rather than
 * returning null, and the collapsed default has to render correctly when it does.
 */
const KEY = "101.rail";

let open: boolean | null = null;
const listeners = new Set<() => void>();

function read(): boolean {
  if (open === null) {
    try {
      open = window.localStorage.getItem(KEY) === "open";
    } catch {
      open = false;
    }
  }
  return open;
}

export function setRailOpen(next: boolean) {
  open = next;
  try {
    window.localStorage.setItem(KEY, next ? "open" : "closed");
  } catch {
    /* the preference simply does not persist */
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useRailOpen(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
