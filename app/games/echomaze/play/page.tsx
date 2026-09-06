import type { Metadata } from "next";

import EchoMazeStandalone from "../EchoMazeStandalone";

export const metadata: Metadata = {
  title: "Echo Maze 101",
  description: "Explore a maze in the dark while a second screen shows you what it hides.",
};

/**
 * Where the game actually runs.
 *
 * Separate from /games/echomaze because a mounted game is a running game — `useGameHost` launches from
 * an effect with no condition in it — so the only way to show a player the game before starting it
 * is to not mount it yet.
 */
export default function EchoMazePlayPage() {
  return <EchoMazeStandalone />;
}
