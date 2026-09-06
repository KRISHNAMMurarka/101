import type { Metadata } from "next";

import GravityStackStandalone from "../GravityStackStandalone";

export const metadata: Metadata = {
  title: "GravityStack 101",
  description: "Stack a tower upward while gravity keeps changing which way down is.",
};

/**
 * Where the game actually runs.
 *
 * Separate from /games/gravitystack because a mounted game is a running game — `useGameHost` launches from
 * an effect with no condition in it — so the only way to show a player the game before starting it
 * is to not mount it yet.
 */
export default function GravityStackPlayPage() {
  return <GravityStackStandalone />;
}
