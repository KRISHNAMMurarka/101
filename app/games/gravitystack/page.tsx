import type { Metadata } from "next";

import { parseInputManifest } from "@101/input";
import { parseGameManifest } from "@101/sdk";

import PreGame from "@/app/components/PreGame";
import { createLauncherCatalogEntry } from "@/app/lib/catalog";
import GRAVITYSTACK_INPUT from "@/games/gravitystack/input.manifest.json";
import GRAVITYSTACK_MANIFEST from "@/games/gravitystack/manifest.json";
import { GRAVITYSTACK_ROLES } from "@/games/gravitystack/src/roles";

export const metadata: Metadata = {
  title: "GravityStack 101",
  description: "Stack a tower upward while gravity keeps changing which way down is.",
};

/*
 * Parsed once at module scope, so a malformed manifest fails the build rather than the page, and the
 * chooser is derived rather than written: every option it offers comes from this file and the roles
 * beside it.
 */
const manifest = parseGameManifest(GRAVITYSTACK_MANIFEST);
/* What the game needs, as the source groups the resolver itself uses — so the chooser can say when
   this device cannot serve one of them, rather than offering a Start that leads nowhere. */
const { requires } = createLauncherCatalogEntry(manifest, parseInputManifest(GRAVITYSTACK_INPUT));

export default function GravityStackPage() {
  return <PreGame manifest={manifest} requires={requires} roles={GRAVITYSTACK_ROLES} />;
}
