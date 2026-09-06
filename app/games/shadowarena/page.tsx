import type { Metadata } from "next";

import { parseGameManifest } from "@101/sdk";

import PreGame from "@/app/components/PreGame";
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

export default function ShadowArenaPage() {
  return <PreGame manifest={manifest} roles={SHADOW_ARENA_ROLES} />;
}
