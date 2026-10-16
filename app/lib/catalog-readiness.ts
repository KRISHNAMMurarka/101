import type { InputSource } from "@101/input";
import { CATALOG_INPUT_LABELS, playableWithSources, type LauncherCatalogEntry } from "./catalog.ts";

export function catalogReadiness(game: LauncherCatalogEntry, local: readonly InputSource[]): { ok: boolean; text: string } {
  if (game.status !== "playable") return { ok: false, text: "Coming soon" };
  if (local.length === 0) return { ok: false, text: "Checking…" };
  if (playableWithSources(game, local)) return { ok: true, text: "Ready on this device" };
  const missing = game.requires.filter((group) => !group.some((source) => local.includes(source)));
  const groups = missing.map((group) => {
    const names = group.map((source) => CATALOG_INPUT_LABELS[source]).join(" or ") || "another controller";
    return missing.length > 1 && group.length > 1 ? `(${names})` : names;
  });
  return { ok: false, text: `Needs ${groups.join(" and ")}` };
}
