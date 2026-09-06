import type { Metadata } from "next";
import SwarmCommanderStandalone from "./SwarmCommanderStandalone";

export const metadata: Metadata = { title: "Swarm Commander 101", description: "Command hundreds of units with one gesture, and hold a line that keeps moving." };
export default function SwarmCommanderPage() { return <SwarmCommanderStandalone />; }
