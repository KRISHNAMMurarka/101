import type { Metadata } from "next";

import { parseGameManifest } from "@101/sdk";

import PreGame from "@/app/components/PreGame";
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

export default function GravityStackPage() {
  return <PreGame manifest={manifest} roles={GRAVITYSTACK_ROLES} />;
}
