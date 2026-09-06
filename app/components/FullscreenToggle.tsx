"use client";

import { useSyncExternalStore } from "react";

import { Icon } from "./Icon";

/**
 * Fullscreen for a game.
 *
 * There was none anywhere in the product — no `requestFullscreen` call in app/ or packages/ — so a
 * game played inside the page chrome at whatever height its own stylesheet had picked, and on a
 * laptop or a phone held sideways that was often taller than the window.
 *
 * It lives in the shell rather than in each game because there is nothing game-specific about it:
 * one implementation covers every current game and every future one, including a game 101 did not
 * ship. The target is the document element, so a game's HUD, overlays and readouts come with it.
 */

function subscribe(listener: () => void) {
  document.addEventListener("fullscreenchange", listener);
  return () => document.removeEventListener("fullscreenchange", listener);
}

/**
 * Safari on iPhone has no Element.requestFullscreen at all, so the control must not be offered
 * there — a button that does nothing is worse than no button.
 *
 * Read through the same store as the state itself rather than assigned by an effect: the server
 * answer is "no", the client answer is the real one, and neither changes during a document's life.
 */
const nothing = () => () => {};
const isSupported = () => Boolean(document.documentElement.requestFullscreen);

export default function FullscreenToggle() {
  const active = useSyncExternalStore(subscribe, () => document.fullscreenElement !== null, () => false);
  const available = useSyncExternalStore(nothing, isSupported, () => false);
  if (!available) return null;

  const toggle = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    } catch {
      // A rejected request means the browser declined the gesture — nothing to tell the player that
      // they cannot already see.
    }
  };

  return (
    <button className="fullscreen-toggle" onClick={toggle} aria-pressed={active}>
      <Icon name={active ? "close" : "plus"} size={16} />
      {active ? "Exit full screen" : "Full screen"}
    </button>
  );
}
