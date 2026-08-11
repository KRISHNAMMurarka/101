import type { Metadata } from "next";
import OrbitalCrewStandalone from "./OrbitalCrewStandalone";

export const metadata: Metadata = {
  title: "Orbital Crew 101 — Asymmetric local co-op",
  description: "Pilot one endless ship from independent local controller roles, or run every station from a keyboard.",
};

export default function OrbitalCrewPage() {
  return <OrbitalCrewStandalone />;
}
