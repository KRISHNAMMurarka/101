import type { Metadata } from "next";

import SpellcasterStandalone from "../SpellcasterStandalone";

export const metadata: Metadata = {
  title: "Spellcaster 101",
  description: "Draw a shape in the air and it becomes a spell. Cast with your hands, your phone, or a pad.",
};

/**
 * Where the game actually runs.
 *
 * Separate from /games/spellcaster because a mounted game is a running game — `useGameHost` launches from
 * an effect with no condition in it — so the only way to show a player the game before starting it
 * is to not mount it yet.
 */
export default function SpellcasterPlayPage() {
  return <SpellcasterStandalone />;
}
