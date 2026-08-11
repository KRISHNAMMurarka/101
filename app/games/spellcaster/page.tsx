import type { Metadata } from "next";
import SpellcasterStandalone from "./SpellcasterStandalone";

export const metadata: Metadata = {
  title: "Spellcaster 101 — Local hand-gesture survival",
  description: "Cast through a temporal hand-gesture state machine, phone motion, keyboard, or gamepad in a seeded endless arena.",
};

export default function SpellcasterPage() {
  return <SpellcasterStandalone />;
}
