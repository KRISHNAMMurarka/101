"use client";

import { useSyncExternalStore } from "react";

import { Icon } from "./Icon";

/**
 * Full screen, in the game's own frame.
 *
 * It used to float over the bottom-right corner of the page, which put a control belonging to the
 * game outside it. It now sits at the top-left of the game's status bar, where a window's own
 * controls live — and replaces a status dot that had been decorative since the subsystem name beside
 * it was removed.
 *
 * What fills the screen is the game, not the document: calling requestFullscreen on the document
 * element is what F11 does, and it takes the website's chrome with it.
 */

function subscribe(listener: () => void) {
  const onChange = () => {
    // Escape never runs the click handler, so the marker class has to come off here or the element
    // keeps its full-screen sizing back inside the page.
    if (!document.fullscreenElement) {
      for (const element of document.querySelectorAll(".game-fullscreen")) element.classList.remove("game-fullscreen");
    }
    listener();
  };
  document.addEventListener("fullscreenchange", onChange);
  return () => document.removeEventListener("fullscreenchange", onChange);
}

const never = () => () => {};
/** Safari on iPhone has no Element.requestFullscreen at all; a button that does nothing is worse
 *  than no button. */
const isSupported = () => Boolean(document.documentElement.requestFullscreen);

export default function FullscreenButton() {
  const active = useSyncExternalStore(subscribe, () => document.fullscreenElement !== null, () => false);
  const available = useSyncExternalStore(never, isSupported, () => false);
  if (!available) return null;

  const toggle = async (event: React.MouseEvent<HTMLButtonElement>) => {
    try {
      if (document.fullscreenElement) { await document.exitFullscreen(); return; }
      /*
       * The frame this button is in. Walking up from the button rather than searching the document
       * means a page with two game frames would still expand the right one.
       */
      const frame = event.currentTarget.closest<HTMLElement>("[data-game-frame]") ?? event.currentTarget.closest<HTMLElement>(
        "[class$='-arena'], [class$='-stage'], [class$='-stage-shell'], [class$='-layout']",
      ) ?? event.currentTarget.closest<HTMLElement>("[class$='-page']");
      if (!frame) return;
      frame.classList.add("game-fullscreen");
      await frame.requestFullscreen({ navigationUI: "hide" });
    } catch {
      // A rejected request means the browser declined the gesture; there is nothing to tell the
      // player that they cannot already see.
    }
  };

  return (
    <button
      type="button"
      className="frame-fullscreen"
      onClick={toggle}
      aria-pressed={active}
      aria-label={active ? "Leave full screen" : "Full screen"}
      title={active ? "Leave full screen" : "Full screen"}
    >
      <Icon name={active ? "shrink" : "expand"} size={16} />
    </button>
  );
}
