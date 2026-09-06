import type { Metadata } from "next";
import TiltDriftStandalone from "./TiltDriftStandalone";

export const metadata: Metadata = {
  title: "TiltDrift 101",
  description: "Take every corner at speed. Steer with a keyboard, a gamepad, or by tilting your phone.",
};

export default function TiltDriftPage() {
  return <TiltDriftStandalone />;
}
