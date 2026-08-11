import type { Metadata } from "next";
import TiltDriftStandalone from "./TiltDriftStandalone";

export const metadata: Metadata = {
  title: "TiltDrift 101 — Infinite local racing",
  description: "A seeded 3D racing slice driven by keyboard, gamepad, touch, or calibrated phone tilt.",
};

export default function TiltDriftPage() {
  return <TiltDriftStandalone />;
}
