import type { Metadata } from "next";
import BeatForgeStandalone from "./BeatForgeStandalone";

export const metadata: Metadata = {
  title: "BeatForge 101",
  description: "Hit the beat with a keyboard, a gamepad, or the movement of your whole body.",
};

export default function BeatForgePage() {
  return <BeatForgeStandalone />;
}
