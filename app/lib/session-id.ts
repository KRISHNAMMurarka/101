"use client";

import { useSyncExternalStore } from "react";

/**
 * One session code per browser, shared by every route.
 *
 * Each surface used to derive its own from `useId()`, and ten games additionally hardcoded their
 * own — BEAT01, GRAV01, ECHO01, SHDW01, ORBIT1, SPELL1, SWRM01. A phone paired on the library page
 * therefore could not appear inside a game: they were different sessions, so the pairing silently
 * did not survive a navigation. That is invisible from inside any one screen, and obvious the moment
 * navigation works at all, which is what the shell now makes possible.
 *
 * A code in the URL still wins, because that is a pairing link someone deliberately followed.
 */
const KEY = "101.session";
const SHAPE = /^[A-Z0-9-]{4,128}$/i;

/** Ambiguous glyphs are dropped: this code is read off one screen and typed into another. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateSessionId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `101${Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join("")}`.slice(0, 6);
}

/**
 * Resolved once per document and then held, so every caller and every re-render sees one code —
 * and so `getSnapshot` below returns a stable reference, which is what useSyncExternalStore
 * requires to avoid an infinite render loop.
 */
let resolved: string | null = null;

function resolveSessionId(): string {
  if (resolved) return resolved;

  const requested = new URLSearchParams(window.location.search).get("session")?.trim();
  if (requested && SHAPE.test(requested)) {
    resolved = requested;
  } else {
    let stored: string | null = null;
    try {
      const candidate = window.localStorage.getItem(KEY);
      stored = candidate && SHAPE.test(candidate) ? candidate : null;
    } catch {
      /* private window or blocked site data */
    }
    resolved = stored ?? generateSessionId();
  }

  try {
    window.localStorage.setItem(KEY, resolved);
  } catch {
    /* not persisted; a fresh code each visit is the honest fallback */
  }
  return resolved;
}

/** The code never changes within a document, so nothing ever needs to be notified. */
const subscribe = () => () => {};

/**
 * `null` on the server and for the first client paint, then the real code. Callers render a
 * placeholder for that one frame rather than committing to a value the server could not know.
 */
export function useSessionId(): string | null {
  return useSyncExternalStore(subscribe, resolveSessionId, () => null);
}
