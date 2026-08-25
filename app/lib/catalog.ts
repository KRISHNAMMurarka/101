import { resolveInputManifest, type InputManifest, type InputSource } from "@101/input";
import type { GameManifest } from "@101/sdk";

export const CATALOG_INPUT_PROFILES = [
  { id: "keyboard-only", label: "Keyboard only", sources: ["keyboard"] },
  { id: "keyboard-mouse", label: "Keyboard + mouse", sources: ["keyboard", "mouse"] },
  { id: "gamepad-only", label: "Gamepad only", sources: ["gamepad"] },
  { id: "phone", label: "Phone only", sources: ["touch", "phone-motion"] },
] as const satisfies readonly {
  id: string;
  label: string;
  sources: readonly InputSource[];
}[];

/** Player-facing names shared by catalog cards and normalized search aliases. */
export const CATALOG_INPUT_LABELS: Readonly<Partial<Record<InputSource, string>>> = Object.freeze({
  keyboard: "Keyboard",
  mouse: "Mouse",
  touch: "Touch",
  gamepad: "Gamepad",
  "phone-motion": "Phone motion",
  "watch-motion": "Watch",
  "camera-hand": "Hands",
  "camera-pose": "Body",
  "camera-face": "Head",
  custom: "Custom hardware",
});

export type CatalogInputProfileId = typeof CATALOG_INPUT_PROFILES[number]["id"];
export type CatalogInputFilter = "all" | CatalogInputProfileId;

export interface LauncherCatalogEntry extends GameManifest {
  readonly searchText: string;
  readonly playableWith: Readonly<Record<CatalogInputProfileId, boolean>>;
}

export interface CatalogFilterOptions {
  query?: string;
  input?: CatalogInputFilter;
}

export interface CatalogWindowOptions {
  itemCount: number;
  columns: number;
  rowHeight: number;
  viewportTop: number;
  viewportHeight: number;
  overscanRows?: number;
}

export interface CatalogWindowPlan {
  startIndex: number;
  endIndex: number;
  startRow: number;
  endRow: number;
  totalRows: number;
  totalHeight: number;
  topSpacer: number;
  bottomSpacer: number;
}

export function createLauncherCatalogEntry(
  manifest: GameManifest,
  input: InputManifest,
): LauncherCatalogEntry {
  if (manifest.id !== input.game) {
    throw new Error(`Game manifest ${manifest.id} and input manifest ${input.game} must match`);
  }

  const playableWith = Object.fromEntries(
    CATALOG_INPUT_PROFILES.map((profile) => [
      profile.id,
      resolveInputManifest(input, profile.sources).playable,
    ]),
  ) as Record<CatalogInputProfileId, boolean>;

  return {
    ...manifest,
    searchText: catalogSearchText(manifest),
    playableWith: Object.freeze(playableWith),
  };
}

export function filterCatalog(
  entries: readonly LauncherCatalogEntry[],
  options: CatalogFilterOptions = {},
) {
  const input = options.input ?? "all";
  if (input !== "all" && !CATALOG_INPUT_PROFILES.some((profile) => profile.id === input)) {
    throw new Error(`Unknown catalog input filter ${String(input)}`);
  }
  const tokens = normalizeCatalogText(options.query ?? "").split(" ").filter(Boolean);
  return entries.filter((entry) =>
    (input === "all" || entry.playableWith[input])
    && tokens.every((token) => entry.searchText.includes(token)));
}

export function createSyntheticCatalog(
  entries: readonly LauncherCatalogEntry[],
  count = 1_000,
) {
  if (!Number.isInteger(count) || count < 0 || count > 10_000) {
    throw new Error("Synthetic catalog count must be an integer from 0 to 10000");
  }
  if (count > 0 && entries.length === 0) {
    throw new Error("Synthetic catalog needs at least one source entry");
  }
  const width = Math.max(4, String(count).length);
  return Array.from({ length: count }, (_, index) => {
    const source = entries[index % entries.length]!;
    const sequence = String(index + 1).padStart(width, "0");
    const prefix = `catalog-fixture-${sequence}-`;
    const id = `${prefix}${source.id}`.slice(0, 128);
    const name = `Catalog Fixture ${sequence}: ${source.name}`.slice(0, 80);
    const fixture: GameManifest = {
      ...source,
      id,
      name,
      order: index + 1,
      players: { ...source.players },
      inputs: [...source.inputs],
      ...(source.controllers ? {
        controllers: {
          basic: [...source.controllers.basic],
          ...(source.controllers.enhanced ? { enhanced: [...source.controllers.enhanced] } : {}),
          ...(source.controllers.immersive ? { immersive: [...source.controllers.immersive] } : {}),
        },
      } : {}),
    };
    return {
      ...fixture,
      playableWith: Object.freeze({ ...source.playableWith }),
      searchText: catalogSearchText(fixture),
    };
  });
}

export function planCatalogWindow(options: CatalogWindowOptions): CatalogWindowPlan {
  assertNonNegativeInteger(options.itemCount, "itemCount");
  assertPositiveInteger(options.columns, "columns");
  assertPositiveFinite(options.rowHeight, "rowHeight");
  assertFinite(options.viewportTop, "viewportTop");
  assertNonNegativeFinite(options.viewportHeight, "viewportHeight");
  const overscanRows = options.overscanRows ?? 2;
  assertNonNegativeInteger(overscanRows, "overscanRows");

  const totalRows = Math.ceil(options.itemCount / options.columns);
  const totalHeight = totalRows * options.rowHeight;
  if (totalRows === 0) {
    return {
      startIndex: 0,
      endIndex: 0,
      startRow: 0,
      endRow: 0,
      totalRows: 0,
      totalHeight: 0,
      topSpacer: 0,
      bottomSpacer: 0,
    };
  }

  // Treat a viewport above the grid as its top and one below the grid as its bottom. Besides making
  // the planner total for all page-scroll positions, the latter matters after a deep catalog is
  // narrowed to one result: a stale scroll offset must show that result rather than an empty gap.
  const maximumViewportTop = Math.max(0, totalHeight - options.viewportHeight);
  const viewportTop = Math.min(maximumViewportTop, Math.max(0, options.viewportTop));
  const visibleStartRow = Math.min(totalRows - 1, Math.floor(viewportTop / options.rowHeight));
  const visibleEndRow = Math.min(
    totalRows,
    Math.max(
      visibleStartRow + 1,
      Math.ceil((viewportTop + options.viewportHeight) / options.rowHeight),
    ),
  );
  const startRow = Math.max(0, visibleStartRow - overscanRows);
  const endRow = Math.min(totalRows, visibleEndRow + overscanRows);

  return {
    startIndex: startRow * options.columns,
    endIndex: Math.min(options.itemCount, endRow * options.columns),
    startRow,
    endRow,
    totalRows,
    totalHeight,
    topSpacer: startRow * options.rowHeight,
    bottomSpacer: (totalRows - endRow) * options.rowHeight,
  };
}

function catalogSearchText(manifest: GameManifest) {
  return normalizeCatalogText([
    manifest.id,
    manifest.name,
    manifest.tagline ?? "",
    ...manifest.inputs,
    ...manifest.inputs.map((input) => CATALOG_INPUT_LABELS[input] ?? input),
  ].join(" "));
}

function normalizeCatalogText(value: string) {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function assertFinite(value: number, label: string) {
  if (!Number.isFinite(value)) throw new Error(`Catalog window ${label} must be finite`);
}

function assertPositiveFinite(value: number, label: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Catalog window ${label} must be positive and finite`);
  }
}

function assertNonNegativeFinite(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Catalog window ${label} must be non-negative and finite`);
  }
}

function assertPositiveInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Catalog window ${label} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Catalog window ${label} must be a non-negative integer`);
  }
}
