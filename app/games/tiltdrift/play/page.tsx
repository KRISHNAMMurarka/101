import type { Metadata } from "next";

import TiltDriftStandalone from "../TiltDriftStandalone";

export const metadata: Metadata = {
  title: "TiltDrift 101",
  description: "Take every corner at speed. Steer with a keyboard, a gamepad, or by tilting your phone.",
};

/**
 * Where the game actually runs.
 *
 * Separate from /games/tiltdrift because a mounted game is a running game — `useGameHost` launches from
 * an effect with no condition in it — so the only way to show a player the game before starting it
 * is to not mount it yet.
 */
export default function TiltDriftPlayPage() {
  return <TiltDriftStandalone />;
}
