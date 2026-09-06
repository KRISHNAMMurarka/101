import { parseInputManifest } from "@101/input";
import { parseGameManifest } from "@101/sdk";
import { createLauncherCatalogEntry, type LauncherCatalogEntry } from "./lib/catalog";

const manifestModules = import.meta.glob("../games/*/manifest.json", {
  eager: true,
  import: "default",
});

const inputManifestModules = import.meta.glob("../games/*/input.manifest.json", {
  eager: true,
  import: "default",
});

const manifests = Object.values(manifestModules).map((manifest) => parseGameManifest(manifest));
const inputManifests = Object.values(inputManifestModules).map((manifest) => parseInputManifest(manifest));
const inputsByGame = new Map(inputManifests.map((manifest) => [manifest.game, manifest]));

if (new Set(manifests.map((manifest) => manifest.id)).size !== manifests.length) {
  throw new Error("Catalog contains duplicate game manifest ids");
}
if (inputsByGame.size !== inputManifests.length) {
  throw new Error("Catalog contains duplicate input manifest game ids");
}

const manifestIds = new Set(manifests.map((manifest) => manifest.id));
for (const input of inputManifests) {
  if (!manifestIds.has(input.game)) throw new Error(`Input manifest ${input.game} has no game manifest`);
}

export const gameCatalog: LauncherCatalogEntry[] = manifests
  // Input Lab is a diagnostic with its own featured card, not a game package. It intentionally has
  // no semantic input manifest, so it stays outside compatibility filtering and windowing.
  .filter((manifest) => manifest.surface !== "tool")
  .map((manifest) => {
    const input = inputsByGame.get(manifest.id);
    if (!input) throw new Error(`Game ${manifest.id} has no input manifest`);
    return createLauncherCatalogEntry(manifest, input);
  })
  .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name));
