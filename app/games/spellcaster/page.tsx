import type { Metadata } from "next";
import SpellcasterStandalone from "./SpellcasterStandalone";

export const metadata: Metadata = {
  title: "Spellcaster 101",
  description: "Draw a shape in the air and it becomes a spell. Cast with your hands, your phone, or a pad.",
};

export default function SpellcasterPage() {
  return <SpellcasterStandalone />;
}
