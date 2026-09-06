import type { Metadata } from "next";

import { parseInputManifest } from "@101/input";
import { parseGameManifest } from "@101/sdk";

import PreGame from "@/app/components/PreGame";
import { createLauncherCatalogEntry } from "@/app/lib/catalog";
import TILTDRIFT_INPUT from "@/games/tiltdrift/input.manifest.json";
import TILTDRIFT_MANIFEST from "@/games/tiltdrift/manifest.json";
import { TILTDRIFT_ROLES } from "@/games/tiltdrift/src/roles";

export const metadata: Metadata = {
  title: "TiltDrift 101",
  description: "Take every corner at speed. Steer with a keyboard, a gamepad, or by tilting your phone.",
};

/*
 * Parsed once at module scope, so a malformed manifest fails the build rather than the page, and the
 * chooser is derived rather than written: every option it offers comes from this file and the roles
 * beside it.
 */
const manifest = parseGameManifest(TILTDRIFT_MANIFEST);
/* What the game needs, as the source groups the resolver itself uses — so the chooser can say when
   this device cannot serve one of them, rather than offering a Start that leads nowhere. */
const { requires } = createLauncherCatalogEntry(manifest, parseInputManifest(TILTDRIFT_INPUT));

export default function TiltDriftPage() {
  return <PreGame manifest={manifest} requires={requires} roles={TILTDRIFT_ROLES} />;
}
