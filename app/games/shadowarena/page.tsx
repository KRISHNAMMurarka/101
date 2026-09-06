import type { Metadata } from "next";

import { parseInputManifest } from "@101/input";
import { parseGameManifest } from "@101/sdk";

import PreGame from "@/app/components/PreGame";
import { createLauncherCatalogEntry } from "@/app/lib/catalog";
import SHADOWARENA_INPUT from "@/games/shadowarena/input.manifest.json";
import SHADOWARENA_MANIFEST from "@/games/shadowarena/manifest.json";
import { SHADOW_ARENA_ROLES } from "@/games/shadowarena/src/roles";

export const metadata: Metadata = {
  title: "Shadow Arena 101",
  description: "Your silhouette steps into the arena. Fight with your body, or with a controller.",
};

/*
 * Parsed once at module scope, so a malformed manifest fails the build rather than the page, and the
 * chooser is derived rather than written: every option it offers comes from this file and the roles
 * beside it.
 */
const manifest = parseGameManifest(SHADOWARENA_MANIFEST);
/* What the game needs, as the source groups the resolver itself uses — so the chooser can say when
   this device cannot serve one of them, rather than offering a Start that leads nowhere. */
const { requires } = createLauncherCatalogEntry(manifest, parseInputManifest(SHADOWARENA_INPUT));

export default function ShadowArenaPage() {
  return <PreGame manifest={manifest} requires={requires} roles={SHADOW_ARENA_ROLES} />;
}
