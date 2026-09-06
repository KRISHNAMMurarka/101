import type { Metadata } from "next";

import { parseInputManifest } from "@101/input";
import { parseGameManifest } from "@101/sdk";

import PreGame from "@/app/components/PreGame";
import { createLauncherCatalogEntry } from "@/app/lib/catalog";
import SWARMCOMMANDER_INPUT from "@/games/swarmcommander/input.manifest.json";
import SWARMCOMMANDER_MANIFEST from "@/games/swarmcommander/manifest.json";
import { SWARM_COMMANDER_ROLES } from "@/games/swarmcommander/src/roles";

export const metadata: Metadata = { title: "Swarm Commander 101", description: "Command hundreds of units with one gesture, and hold a line that keeps moving." };

/*
 * Parsed once at module scope, so a malformed manifest fails the build rather than the page, and the
 * chooser is derived rather than written: every option it offers comes from this file and the roles
 * beside it.
 */
const manifest = parseGameManifest(SWARMCOMMANDER_MANIFEST);
/* What the game needs, as the source groups the resolver itself uses — so the chooser can say when
   this device cannot serve one of them, rather than offering a Start that leads nowhere. */
const { requires } = createLauncherCatalogEntry(manifest, parseInputManifest(SWARMCOMMANDER_INPUT));

export default function SwarmCommanderPage() {
  return <PreGame manifest={manifest} requires={requires} roles={SWARM_COMMANDER_ROLES} />;
}
