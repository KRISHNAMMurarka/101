import type { Metadata } from "next";

import { parseGameManifest } from "@101/sdk";

import PreGame from "@/app/components/PreGame";
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

export default function SlashstormPage() {
  return <PreGame manifest={manifest} roles={SLASHSTORM_ROLES} />;
}
