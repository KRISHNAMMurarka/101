import type { Metadata } from "next";
import BodyDodgeStandalone from "./BodyDodgeStandalone";

export const metadata: Metadata = {
  title: "BodyDodge 101",
  description: "Move your body to slip through walls that keep coming. Uses your camera, or ordinary controls.",
};

export default function BodyDodgePage() {
  return <BodyDodgeStandalone />;
}
