import type { Metadata } from "next";

import { parseInputManifest } from "@101/input";
import { parseGameManifest } from "@101/sdk";

import PreGame from "@/app/components/PreGame";
import { createLauncherCatalogEntry } from "@/app/lib/catalog";
import ORBITALCREW_INPUT from "@/games/orbitalcrew/input.manifest.json";
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
/* What the game needs, as the source groups the resolver itself uses — so the chooser can say when
   this device cannot serve one of them, rather than offering a Start that leads nowhere. */
const { requires } = createLauncherCatalogEntry(manifest, parseInputManifest(ORBITALCREW_INPUT));

export default function OrbitalCrewPage() {
  return <PreGame manifest={manifest} requires={requires} roles={ORBITAL_CREW_ROLES} />;
}
