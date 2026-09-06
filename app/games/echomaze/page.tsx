import type { Metadata } from "next";
import EchoMazeStandalone from "./EchoMazeStandalone";

export const metadata: Metadata = {
  title: "Echo Maze 101",
  description: "Explore a maze in the dark while a second screen shows you what it hides.",
};

export default function EchoMazePage() {
  return <EchoMazeStandalone />;
}
