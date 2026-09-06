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
  const onChange = () => {
    // Leaving full screen by Escape never runs the toggle, so the marker class has to come off here
    // or the element keeps its full-screen sizing back inside the page.
    if (!document.fullscreenElement) {
      for (const element of document.querySelectorAll(".game-fullscreen")) element.classList.remove("game-fullscreen");
    }
    listener();
  };
  document.addEventListener("fullscreenchange", onChange);
  return () => document.removeEventListener("fullscreenchange", onChange);
}

/**
 * The element to fill the screen with.
 *
 * The document element was the wrong target: that is what F11 does, and it takes the page's chrome
 * with it — the player asked for the game to fill the screen, not the website. The game is the
 * element that owns the canvas, so this walks up from the canvas to the stage that contains it,
 * which is also what carries a game's HUD overlays. Falling back to the page element keeps the
 * control working for a game whose markup does not follow that shape.
 */
function fullscreenTarget(): HTMLElement | null {
  const canvas = document.querySelector("canvas");
  const stage = canvas?.closest<HTMLElement>("[class$='-arena'], [class$='-stage'], [class$='-stage-shell'], [class$='-layout']");
  return stage ?? canvas?.parentElement ?? document.querySelector<HTMLElement>("[class$='-page']");
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
      if (document.fullscreenElement) { await document.exitFullscreen(); return; }
      const target = fullscreenTarget();
      if (!target) return;
      target.classList.add("game-fullscreen");
      await target.requestFullscreen({ navigationUI: "hide" });
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
