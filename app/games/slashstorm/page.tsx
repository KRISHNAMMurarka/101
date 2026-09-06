import type { Metadata } from "next";

import { parseInputManifest } from "@101/input";
import { parseGameManifest } from "@101/sdk";

import PreGame from "@/app/components/PreGame";
import { createLauncherCatalogEntry } from "@/app/lib/catalog";
import SLASHSTORM_INPUT from "@/games/slashstorm/input.manifest.json";
import SLASHSTORM_MANIFEST from "@/games/slashstorm/manifest.json";
import { SLASHSTORM_ROLES } from "@/games/slashstorm/src/roles";

export const metadata: Metadata = {
  title: "Slashstorm 101",
  description: "Slice an endless storm of shapes. Play with a keyboard, a gamepad, or by swinging your phone.",
};

/*
 * Parsed once at module scope, so a malformed manifest fails the build rather than the page, and the
 * chooser is derived rather than written: every option it offers comes from this file and the roles
 * beside it.
 */
const manifest = parseGameManifest(SLASHSTORM_MANIFEST);
/* What the game needs, as the source groups the resolver itself uses — so the chooser can say when
   this device cannot serve one of them, rather than offering a Start that leads nowhere. */
const { requires } = createLauncherCatalogEntry(manifest, parseInputManifest(SLASHSTORM_INPUT));

export default function SlashstormPage() {
  return <PreGame manifest={manifest} requires={requires} roles={SLASHSTORM_ROLES} />;
}
