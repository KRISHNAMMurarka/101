import type { Metadata } from "next";

import { parseInputManifest } from "@101/input";
import { parseGameManifest } from "@101/sdk";

import PreGame from "@/app/components/PreGame";
import { createLauncherCatalogEntry } from "@/app/lib/catalog";
import BODYDODGE_INPUT from "@/games/bodydodge/input.manifest.json";
import BODYDODGE_MANIFEST from "@/games/bodydodge/manifest.json";
import { BODYDODGE_ROLES } from "@/games/bodydodge/src/roles";

export const metadata: Metadata = {
  title: "BodyDodge 101",
  description: "Move your body to slip through walls that keep coming. Uses your camera, or ordinary controls.",
};

/*
 * Parsed once at module scope, so a malformed manifest fails the build rather than the page, and the
 * chooser is derived rather than written: every option it offers comes from this file and the roles
 * beside it.
 */
const manifest = parseGameManifest(BODYDODGE_MANIFEST);
/* What the game needs, as the source groups the resolver itself uses — so the chooser can say when
   this device cannot serve one of them, rather than offering a Start that leads nowhere. */
const { requires } = createLauncherCatalogEntry(manifest, parseInputManifest(BODYDODGE_INPUT));

export default function BodyDodgePage() {
  return <PreGame manifest={manifest} requires={requires} roles={BODYDODGE_ROLES} />;
}
