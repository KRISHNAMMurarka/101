import type { Metadata } from "next";
import SlashstormStandalone from "./SlashstormStandalone";

export const metadata: Metadata = {
  title: "Slashstorm 101 — Play locally",
  description: "An endless seeded slicing game powered by the 101 Input Bus.",
};

export default function SlashstormPage() {
  return <SlashstormStandalone />;
}
