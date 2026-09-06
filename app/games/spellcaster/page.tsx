import type { Metadata } from "next";

import { parseGameManifest } from "@101/sdk";

import PreGame from "@/app/components/PreGame";
import SPELLCASTER_MANIFEST from "@/games/spellcaster/manifest.json";
import { SPELLCASTER_ROLES } from "@/games/spellcaster/src/roles";

export const metadata: Metadata = {
  title: "Spellcaster 101",
  description: "Draw a shape in the air and it becomes a spell. Cast with your hands, your phone, or a pad.",
};

/*
 * Parsed once at module scope, so a malformed manifest fails the build rather than the page, and the
 * chooser is derived rather than written: every option it offers comes from this file and the roles
 * beside it.
 */
const manifest = parseGameManifest(SPELLCASTER_MANIFEST);

export default function SpellcasterPage() {
  return <PreGame manifest={manifest} roles={SPELLCASTER_ROLES} />;
}
