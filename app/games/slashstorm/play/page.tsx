import type { Metadata } from "next";

import SlashstormStandalone from "../SlashstormStandalone";

export const metadata: Metadata = {
  title: "Slashstorm 101",
  description: "Slice an endless storm of shapes. Swipe on a phone, or play with a keyboard or gamepad.",
};

/**
 * Where the game actually runs.
 *
 * Separate from /games/slashstorm because a mounted game is a running game — `useGameHost` launches from
 * an effect with no condition in it — so the only way to show a player the game before starting it
 * is to not mount it yet.
 */
export default function SlashstormPlayPage() {
  return <SlashstormStandalone />;
}
