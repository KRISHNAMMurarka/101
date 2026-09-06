import type { Metadata } from "next";

import BodyDodgeStandalone from "../BodyDodgeStandalone";

export const metadata: Metadata = {
  title: "BodyDodge 101",
  description: "Move your body to slip through walls that keep coming. Uses your camera, or ordinary controls.",
};

/**
 * Where the game actually runs.
 *
 * Separate from /games/bodydodge because a mounted game is a running game — `useGameHost` launches from
 * an effect with no condition in it — so the only way to show a player the game before starting it
 * is to not mount it yet.
 */
export default function BodyDodgePlayPage() {
  return <BodyDodgeStandalone />;
}
