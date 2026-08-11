import type { Metadata } from "next";
import EchoMazeStandalone from "./EchoMazeStandalone";

export const metadata: Metadata = {
  title: "Echo Maze 101 — Local private-display exploration",
  description: "Explore deterministic endless maze floors while an optional local companion receives role-private scanner clues.",
};

export default function EchoMazePage() {
  return <EchoMazeStandalone />;
}
