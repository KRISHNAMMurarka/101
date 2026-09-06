import type { Metadata } from "next";

import { parseGameManifest } from "@101/sdk";

import PreGame from "@/app/components/PreGame";
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

export default function TiltDriftPage() {
  return <PreGame manifest={manifest} roles={TILTDRIFT_ROLES} />;
}
