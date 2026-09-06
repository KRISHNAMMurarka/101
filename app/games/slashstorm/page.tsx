import type { Metadata } from "next";
import SlashstormStandalone from "./SlashstormStandalone";

export const metadata: Metadata = {
  title: "Slashstorm 101",
  description: "Slice an endless storm of shapes. Play with a keyboard, a gamepad, or by swinging your phone.",
};

export default function SlashstormPage() {
  return <SlashstormStandalone />;
}
