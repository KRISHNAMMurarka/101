import type { Metadata } from "next";

import { parseGameManifest } from "@101/sdk";

import PreGame from "@/app/components/PreGame";
import ORBITALCREW_MANIFEST from "@/games/orbitalcrew/manifest.json";
import { ORBITAL_CREW_ROLES } from "@/games/orbitalcrew/src/roles";

export const metadata: Metadata = {
  title: "Orbital Crew 101",
  description: "Run one ship from several screens at once, or take every station yourself.",
};

/*
 * Parsed once at module scope, so a malformed manifest fails the build rather than the page, and the
 * chooser is derived rather than written: every option it offers comes from this file and the roles
 * beside it.
 */
const manifest = parseGameManifest(ORBITALCREW_MANIFEST);

export default function OrbitalCrewPage() {
  return <PreGame manifest={manifest} roles={ORBITAL_CREW_ROLES} />;
}
