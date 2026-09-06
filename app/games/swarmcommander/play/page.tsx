import type { Metadata } from "next";

import SwarmCommanderStandalone from "../SwarmCommanderStandalone";

export const metadata: Metadata = { title: "Swarm Commander 101", description: "Command hundreds of units with one gesture, and hold a line that keeps moving." };

/**
 * Where the game actually runs.
 *
 * Separate from /games/swarmcommander because a mounted game is a running game — `useGameHost` launches from
 * an effect with no condition in it — so the only way to show a player the game before starting it
 * is to not mount it yet.
 */
export default function SwarmCommanderPlayPage() {
  return <SwarmCommanderStandalone />;
}
