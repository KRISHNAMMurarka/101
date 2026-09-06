import type { Metadata } from "next";
import OrbitalCrewStandalone from "./OrbitalCrewStandalone";

export const metadata: Metadata = {
  title: "Orbital Crew 101",
  description: "Run one ship from several screens at once, or take every station yourself.",
};

export default function OrbitalCrewPage() {
  return <OrbitalCrewStandalone />;
}
