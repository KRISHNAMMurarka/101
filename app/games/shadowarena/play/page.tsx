import type { Metadata } from "next";

import ShadowArenaStandalone from "../ShadowArenaStandalone";

export const metadata: Metadata = {
  title: "Shadow Arena 101",
  description: "Your silhouette steps into the arena. Fight with your body, or with a controller.",
};

/**
 * Where the game actually runs.
 *
 * Separate from /games/shadowarena because a mounted game is a running game — `useGameHost` launches from
 * an effect with no condition in it — so the only way to show a player the game before starting it
 * is to not mount it yet.
 */
export default function ShadowArenaPlayPage() {
  return <ShadowArenaStandalone />;
}
