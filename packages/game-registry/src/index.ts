import { engineSupportsVersion, type GameRuntime, type RendererKind, type GamePackage } from "@101/sdk";

export type GameInstallSource =
  | { kind: "bundled" }
  | { kind: "local"; path: string }
  | { kind: "download"; url: string; integrity?: string };

export interface InstalledGame {
  package: GamePackage<unknown>;
  source: GameInstallSource;
  installedAt: number;
}

export interface GameCatalogEntry {
  id: string;
  name: string;
  version: string;
  renderer: RendererKind;
  runtime: GameRuntime;
  players: { min: number; max: number };
  offline: boolean;
  procedural: boolean;
  inputs: readonly string[];
  source: GameInstallSource["kind"];
}

export class GameRegistry {
  private readonly records = new Map<string, InstalledGame>();
  private readonly engineMajor: number;

  constructor(engineMajor = 1) {
    this.engineMajor = engineMajor;
  }

  install(gamePackage: GamePackage<unknown>, source: GameInstallSource = { kind: "bundled" }, installedAt = Date.now()) {
    if (!engineSupportsVersion(gamePackage.manifest.engine, this.engineMajor)) {
      throw new Error(`${gamePackage.manifest.name} requires engine ${gamePackage.manifest.engine}`);
    }
    const existing = this.records.get(gamePackage.manifest.id);
    if (existing && compareVersions(gamePackage.manifest.version, existing.package.manifest.version) < 0) {
      throw new Error(`Refusing to downgrade ${gamePackage.manifest.id} without uninstalling it first`);
    }
    const record: InstalledGame = Object.freeze({ package: gamePackage, source: { ...source }, installedAt });
    this.records.set(gamePackage.manifest.id, record);
    return record;
  }

  uninstall(gameId: string) {
    return this.records.delete(gameId);
  }

  get(gameId: string) {
    return this.records.get(gameId);
  }

  list() {
    return [...this.records.values()].sort((left, right) =>
      (left.package.manifest.order ?? Number.MAX_SAFE_INTEGER) - (right.package.manifest.order ?? Number.MAX_SAFE_INTEGER)
      || left.package.manifest.name.localeCompare(right.package.manifest.name));
  }

  catalog(): GameCatalogEntry[] {
    return this.list().map(({ package: gamePackage, source }) => ({
      id: gamePackage.manifest.id,
      name: gamePackage.manifest.name,
      version: gamePackage.manifest.version,
      renderer: gamePackage.manifest.renderer,
      runtime: gamePackage.manifest.runtime ?? "local",
      players: { ...gamePackage.manifest.players },
      offline: gamePackage.manifest.offline,
      procedural: gamePackage.manifest.procedural,
      inputs: [...gamePackage.manifest.inputs],
      source: source.kind,
    }));
  }
}

export function compareVersions(left: string, right: string) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function versionParts(version: string) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new Error(`Invalid semantic version ${version}`);
  return match.slice(1).map(Number);
}
