import type { Metadata } from "next";
import SwarmCommanderStandalone from "./SwarmCommanderStandalone";

export const metadata: Metadata = { title: "Swarm Commander 101 — Multi-device spatial strategy", description: "Command hundreds of locally simulated agents with scalable formations, mouse, gamepad, hand tracking, or two asymmetric 101 Link roles." };
export default function SwarmCommanderPage() { return <SwarmCommanderStandalone />; }
