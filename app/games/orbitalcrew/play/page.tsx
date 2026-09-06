import type { Metadata } from "next";

import OrbitalCrewStandalone from "../OrbitalCrewStandalone";

export const metadata: Metadata = {
  title: "Orbital Crew 101",
  description: "Run one ship from several screens at once, or take every station yourself.",
};

/**
 * Where the game actually runs.
 *
 * Separate from /games/orbitalcrew because a mounted game is a running game — `useGameHost` launches from
 * an effect with no condition in it — so the only way to show a player the game before starting it
 * is to not mount it yet.
 */
export default function OrbitalCrewPlayPage() {
  return <OrbitalCrewStandalone />;
}
