import type { Metadata } from "next";
import ShadowArenaStandalone from "./ShadowArenaStandalone";

export const metadata: Metadata = {
  title: "Shadow Arena 101 — Local camera combat",
  description: "Fight deterministic endless rounds with keyboard, gamepad, 101 Link, or private on-device body-pose controls.",
};

export default function ShadowArenaPage() {
  return <ShadowArenaStandalone />;
}
