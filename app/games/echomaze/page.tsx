import type { Metadata } from "next";

import { parseInputManifest } from "@101/input";
import { parseGameManifest } from "@101/sdk";

import PreGame from "@/app/components/PreGame";
import { createLauncherCatalogEntry } from "@/app/lib/catalog";
import ECHOMAZE_INPUT from "@/games/echomaze/input.manifest.json";
import ECHOMAZE_MANIFEST from "@/games/echomaze/manifest.json";
import { ECHO_MAZE_ROLES } from "@/games/echomaze/src/roles";

export const metadata: Metadata = {
  title: "Echo Maze 101",
  description: "Explore a maze in the dark while a second screen shows you what it hides.",
};

/*
 * Parsed once at module scope, so a malformed manifest fails the build rather than the page, and the
 * chooser is derived rather than written: every option it offers comes from this file and the roles
 * beside it.
 */
const manifest = parseGameManifest(ECHOMAZE_MANIFEST);
/* What the game needs, as the source groups the resolver itself uses — so the chooser can say when
   this device cannot serve one of them, rather than offering a Start that leads nowhere. */
const { requires } = createLauncherCatalogEntry(manifest, parseInputManifest(ECHOMAZE_INPUT));

export default function EchoMazePage() {
  return <PreGame manifest={manifest} requires={requires} roles={ECHO_MAZE_ROLES} />;
}
