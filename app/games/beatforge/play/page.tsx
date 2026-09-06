import type { Metadata } from "next";

import BeatForgeStandalone from "../BeatForgeStandalone";

export const metadata: Metadata = {
  title: "BeatForge 101",
  description: "Hit the beat with a keyboard, a gamepad, or the movement of your whole body.",
};

/**
 * Where the game actually runs.
 *
 * Separate from /games/beatforge because a mounted game is a running game — `useGameHost` launches from
 * an effect with no condition in it — so the only way to show a player the game before starting it
 * is to not mount it yet.
 */
export default function BeatForgePlayPage() {
  return <BeatForgeStandalone />;
}
