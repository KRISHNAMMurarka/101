import type { Metadata } from "next";
import MotionLab from "./MotionLab";

export const metadata: Metadata = {
  title: "101 Motion Lab — Calibrate local sensors",
  description: "Inspect calibrated phone orientation, acceleration, gestures, and normalized 101 input locally.",
};

export default function MotionPage() {
  return <MotionLab />;
}
