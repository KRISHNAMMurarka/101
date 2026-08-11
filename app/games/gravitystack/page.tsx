import type { Metadata } from "next";
import GravityStackStandalone from "./GravityStackStandalone";

export const metadata: Metadata = {
  title: "GravityStack 101 — Variable-gravity physics tower",
  description: "Build an endless seeded Rapier tower while keyboard, gamepad, or phone tilt rotates gravity.",
};

export default function GravityStackPage() {
  return <GravityStackStandalone />;
}
