import type { Metadata } from "next";
import BeatForgeStandalone from "./BeatForgeStandalone";

export const metadata: Metadata = {
  title: "BeatForge 101 — Infinite local rhythm movement",
  description: "Play a seeded endless rhythm chart with keyboard, gamepad, motion controller, or optional local body pose.",
};

export default function BeatForgePage() {
  return <BeatForgeStandalone />;
}
