import type { GameManifest } from "@101/sdk";

const manifestModules = import.meta.glob("../games/*/manifest.json", {
  eager: true,
  import: "default",
});

export const gameCatalog = Object.values(manifestModules)
  .filter((manifest): manifest is GameManifest => {
    const candidate = manifest as Partial<GameManifest>;
    return Boolean(candidate.id && candidate.name && candidate.version);
  })
  .sort((a, b) => a.name.localeCompare(b.name));
