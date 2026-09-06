import type { Metadata } from "next";

import { parseInputManifest } from "@101/input";
import { parseGameManifest } from "@101/sdk";

import PreGame from "@/app/components/PreGame";
import { createLauncherCatalogEntry } from "@/app/lib/catalog";
import BEATFORGE_INPUT from "@/games/beatforge/input.manifest.json";
import BEATFORGE_MANIFEST from "@/games/beatforge/manifest.json";
import { BEATFORGE_ROLES } from "@/games/beatforge/src/roles";

export const metadata: Metadata = {
  title: "BeatForge 101",
  description: "Hit the beat with a keyboard, a gamepad, or the movement of your whole body.",
};

/*
 * Parsed once at module scope, so a malformed manifest fails the build rather than the page, and the
 * chooser is derived rather than written: every option it offers comes from this file and the roles
 * beside it.
 */
const manifest = parseGameManifest(BEATFORGE_MANIFEST);
/* What the game needs, as the source groups the resolver itself uses — so the chooser can say when
   this device cannot serve one of them, rather than offering a Start that leads nowhere. */
const { requires } = createLauncherCatalogEntry(manifest, parseInputManifest(BEATFORGE_INPUT));

export default function BeatForgePage() {
  return <PreGame manifest={manifest} requires={requires} roles={BEATFORGE_ROLES} />;
}
