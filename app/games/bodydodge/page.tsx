import type { Metadata } from "next";
import BodyDodgeStandalone from "./BodyDodgeStandalone";

export const metadata: Metadata = {
  title: "BodyDodge 101 — Local camera survival",
  description: "An infinite seeded body-dodging game with bundled local pose tracking and conventional controls.",
};

export default function BodyDodgePage() {
  return <BodyDodgeStandalone />;
}
