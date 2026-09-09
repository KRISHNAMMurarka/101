import assert from "node:assert/strict";
import test from "node:test";
import { resolveInputManifest, type InputManifest, type InputSource } from "@101/input";
import type { GameManifest } from "@101/sdk";
import {
  catalogLaunchHref,
  createLauncherCatalogEntry,
  createSyntheticCatalog,
  filterCatalog,
  planCatalogWindow,
  type LauncherCatalogEntry,
  playableWithSources,
} from "./catalog.ts";

function game(id: string, name = id, tagline = `${name} tagline`): GameManifest {
  return {
    id,
    name,
    tagline,
    version: "1.0.0",
    engine: "^1",
    renderer: "2d",
    players: { min: 1, max: 1 },
    inputs: ["keyboard", "mouse", "gamepad", "touch", "phone-motion"],
    offline: true,
    procedural: true,
    status: "playable",
    controllers: { basic: ["keyboard"] },
  };
}

function input(gameId: string, control: InputManifest["actions"]): InputManifest {
  return { game: gameId, actions: control };
}

test("catalog compatibility uses the resolver's required, fallback, and optional semantics", () => {
  const fallback = createLauncherCatalogEntry(game("fallback"), input("fallback", {
    move: { recommended: ["touch"], fallback: ["keyboard"] },
    flourish: { recommended: ["camera-pose"], optional: true },
  }));
  // A fallback source satisfies the control, and an optional control never appears at all — an
  // optional requirement that leaked into `requires` would make the game look unplayable everywhere
  // its nice-to-have is absent.
  assert.deepEqual(fallback.requires, [["keyboard", "touch"]]);
  assert.equal(playableWithSources(fallback, ["keyboard"]), true);
  assert.equal(playableWithSources(fallback, ["gamepad"]), false);

  const mouseRequired = createLauncherCatalogEntry(game("mouse-required"), input("mouse-required", {
    aim: { recommended: ["mouse"] },
  }));
  assert.equal(playableWithSources(mouseRequired, ["keyboard"]), false,
    "a keyboard must not quietly include a mouse");
  assert.equal(playableWithSources(mouseRequired, ["keyboard", "mouse"]), true);

  // Two controls, each satisfiable only by a different source: playable with both and neither alone.
  const twoHanded = createLauncherCatalogEntry(game("two-handed"), {
    game: "two-handed",
    actions: { fire: { recommended: ["touch"] } },
    axes: { steer: { recommended: ["phone-motion"] } },
  });
  assert.equal(playableWithSources(twoHanded, ["touch", "phone-motion"]), true);
  assert.equal(playableWithSources(twoHanded, ["touch"]), false);
  assert.equal(playableWithSources(twoHanded, ["phone-motion"]), false);
});

test("the catalog's playability answer is the resolver's, on every device shape", () => {
  /*
   * The catalog cannot ship input manifests — 800 bytes each is 800KB at a thousand games — so it
   * ships a compact form of the same predicate. This is what stops that form drifting from the
   * resolver it summarises, which is the failure that would show up as a filter quietly hiding a
   * game someone can play. Two earlier shapes were rejected by exactly this check.
   */
  const manifests: InputManifest[] = [
    input("a", { move: { recommended: ["keyboard"], fallback: ["touch", "gamepad"] } }),
    { game: "b", actions: { fire: { recommended: ["touch"] } }, axes: { steer: { recommended: ["phone-motion"] } } },
    { game: "c", actions: { go: { recommended: ["keyboard"] }, wave: { recommended: ["camera-hand"], optional: true } } },
    { game: "d", poses: { stance: { recommended: ["camera-pose"], fallback: ["phone-motion"] } },
      actions: { pick: { recommended: ["mouse"], fallback: ["touch"] } } },
    { game: "e", axes: { throttle: { recommended: ["gamepad"], fallback: ["keyboard", "touch"] } } },
  ];
  const POOL: InputSource[] = ["keyboard", "mouse", "touch", "gamepad", "phone-motion", "camera-hand", "camera-pose", "camera-face"];

  let compared = 0;
  for (const manifest of manifests) {
    const entry = createLauncherCatalogEntry(game(manifest.game), manifest);
    for (let mask = 0; mask < (1 << POOL.length); mask++) {
      const sources = POOL.filter((_, index) => mask & (1 << index));
      assert.equal(
        playableWithSources(entry, sources),
        resolveInputManifest(manifest, sources).playable,
        `${manifest.game} disagrees with the resolver for [${sources.join(",")}]`,
      );
      compared++;
    }
  }
  assert.equal(compared, manifests.length * (1 << POOL.length));
});

test("catalog entries reject mismatched game and input contracts", () => {
  assert.throws(
    () => createLauncherCatalogEntry(game("one"), input("two", {
      move: { recommended: ["keyboard"] },
    })),
    /must match/i,
  );
});

test("catalog search normalizes accents, AND-matches tokens, preserves order, and composes with input filters", () => {
  const entries = [
    createLauncherCatalogEntry(game("cafe-racer", "Café Racer", "Téléphone motion racing"), input("cafe-racer", {
      steer: { recommended: ["phone-motion"], fallback: ["keyboard"] },
    })),
    createLauncherCatalogEntry(game("quiet-maze", "Quiet Maze", "A café mystery"), input("quiet-maze", {
      move: { recommended: ["keyboard"] },
    })),
    createLauncherCatalogEntry(game("mouse-art", "Mouse Art"), input("mouse-art", {
      draw: { recommended: ["mouse"] },
    })),
  ];

  assert.deepEqual(
    filterCatalog(entries, { query: "  CAFE   telephone " }).map((entry) => entry.id),
    ["cafe-racer"],
  );
  assert.deepEqual(
    filterCatalog(entries, { query: "cafe" }).map((entry) => entry.id),
    ["cafe-racer", "quiet-maze"],
    "search must preserve manifest order",
  );
  assert.deepEqual(
    filterCatalog(entries, { input: "available", available: ["keyboard"] }).map((entry) => entry.id),
    ["cafe-racer", "quiet-maze"],
  );
  assert.deepEqual(
    filterCatalog(entries, { query: "mouse art", input: "available", available: ["keyboard"] }),
    [],
  );
  // No sources is not "nothing is playable" — it is "we do not know yet", which is the state of the
  // first server-rendered paint, before any probe has run.
  assert.equal(filterCatalog(entries, { input: "available", available: [] }).length, entries.length);
});

test("catalog search accepts every displayed input label and every raw source id", () => {
  const labels: readonly [InputSource, string][] = [
    ["keyboard", "Keyboard"],
    ["mouse", "Mouse"],
    ["touch", "Touch"],
    ["gamepad", "Gamepad"],
    ["phone-motion", "Phone motion"],
    ["watch-motion", "Watch"],
    ["camera-hand", "Hands"],
    ["camera-pose", "Body"],
    ["camera-face", "Head"],
    ["custom", "Custom hardware"],
  ];
  const entries = labels.map(([source]) => createLauncherCatalogEntry({
    ...game(`source-${source}`, `${source} game`),
    inputs: [source],
    controllers: { basic: [source] },
  }, input(`source-${source}`, {
    use: { recommended: [source] },
  })));

  const displayedMatches = Object.fromEntries(labels.map(([, label]) => [
    label,
    filterCatalog(entries, { query: label }).map((entry) => entry.id),
  ]));
  assert.deepEqual(displayedMatches, Object.fromEntries(labels.map(([source, label]) => [
    label,
    [`source-${source}`],
  ])));

  const rawMatches = Object.fromEntries(labels.map(([source]) => [
    source,
    filterCatalog(entries, { query: source }).map((entry) => entry.id),
  ]));
  assert.deepEqual(rawMatches, Object.fromEntries(labels.map(([source]) => [
    source,
    [`source-${source}`],
  ])), "human aliases must augment rather than replace raw source-id search");
});

test("the deterministic 1000-entry fixture makes the final manifest directly searchable", () => {
  const bases = [
    createLauncherCatalogEntry(game("alpha", "Alpha"), input("alpha", {
      move: { recommended: ["keyboard"] },
    })),
    createLauncherCatalogEntry(game("beta", "Beta"), input("beta", {
      move: { recommended: ["gamepad"] },
    })),
  ];

  const first = createSyntheticCatalog(bases, 1_000);
  const second = createSyntheticCatalog(bases, 1_000);
  assert.equal(first.length, 1_000);
  assert.equal(new Set(first.map((entry) => entry.id)).size, 1_000);
  assert.deepEqual(first, second, "the benchmark may not depend on time or randomness");
  const result = filterCatalog(first, { query: "fixture 1000" });
  assert.equal(result.length, 1);
  assert.equal(result[0]?.id, "catalog-fixture-1000-beta");
});

test("the row window stays bounded and complete at the top, middle, and end for 1/2/3 columns", () => {
  const itemCount = 1_000;
  const rowHeight = 400;
  const viewportHeight = 850;
  const overscanRows = 2;

  for (const columns of [1, 2, 3]) {
    const totalRows = Math.ceil(itemCount / columns);
    const totalHeight = totalRows * rowHeight;
    const positions = [0, totalHeight / 2 + 37, totalHeight + 10_000];
    for (const viewportTop of positions) {
      const plan = planCatalogWindow({
        itemCount,
        columns,
        rowHeight,
        viewportTop,
        viewportHeight,
        overscanRows,
      });
      assert.equal(plan.startIndex % columns, 0);
      assert.ok(plan.endIndex === itemCount || plan.endIndex % columns === 0);
      assert.ok(plan.startIndex >= 0 && plan.startIndex < plan.endIndex);
      assert.ok(plan.endIndex <= itemCount);
      assert.equal(plan.totalRows, totalRows);
      assert.equal(plan.totalHeight, totalHeight);
      assert.equal(plan.topSpacer, plan.startRow * rowHeight);
      assert.equal(plan.bottomSpacer, (plan.totalRows - plan.endRow) * rowHeight);
      assert.equal(
        plan.topSpacer + (plan.endRow - plan.startRow) * rowHeight + plan.bottomSpacer,
        plan.totalHeight,
      );
      const effectiveTop = Math.min(
        Math.max(0, totalHeight - viewportHeight),
        Math.max(0, viewportTop),
      );
      const visibleRow = Math.min(totalRows - 1, Math.floor(effectiveTop / rowHeight));
      assert.ok(plan.startRow <= visibleRow && plan.endRow > visibleRow,
        `column count ${columns} omitted the row at ${viewportTop}`);
      const maximumRows = Math.ceil(viewportHeight / rowHeight) + 1 + overscanRows * 2;
      assert.ok(plan.endRow - plan.startRow <= maximumRows,
        `column count ${columns} rendered an unbounded window`);
    }

    const top = planCatalogWindow({ itemCount, columns, rowHeight, viewportTop: 0, viewportHeight });
    assert.equal(top.startIndex, 0);
    assert.ok(top.endIndex < itemCount);
    const end = planCatalogWindow({ itemCount, columns, rowHeight, viewportTop: totalHeight + 1, viewportHeight });
    assert.equal(end.endIndex, itemCount, "the last partial row must remain reachable");
    assert.ok(end.startIndex <= itemCount - 1);
  }

  assert.deepEqual(planCatalogWindow({
    itemCount: 0,
    columns: 3,
    rowHeight,
    viewportTop: 0,
    viewportHeight,
  }), {
    startIndex: 0,
    endIndex: 0,
    startRow: 0,
    endRow: 0,
    totalRows: 0,
    totalHeight: 0,
    topSpacer: 0,
    bottomSpacer: 0,
  });
});

// Keeps test fixtures honest when helper signatures evolve.
const _entryTypecheck: readonly LauncherCatalogEntry[] = [];
void _entryTypecheck;

test("fifty titles retain search results and bounded paging", () => {
  const entries = createSyntheticCatalog([createLauncherCatalogEntry(game("seed"), input("seed", {}))], 50);
  assert.equal(entries.length, 50);
  assert.equal(filterCatalog(entries, { query: "0050" }).length, 1);
  const plan = planCatalogWindow({ itemCount: 50, columns: 2, rowHeight: 400, viewportTop: 8_000, viewportHeight: 800, overscanRows: 1 });
  assert.ok(plan.endIndex <= 50);
  assert.ok(plan.endIndex - plan.startIndex <= 8);
});


test("runtime routing keeps hosted titles out of local game paths", () => {
  const local = createLauncherCatalogEntry(game("local"), input("local", {}));
  assert.equal(catalogLaunchHref(local), "/games/local");
  const hosted = createLauncherCatalogEntry({ ...game("hosted"), runtime: "hosted", launchUrl: "https://example.test/play" }, input("hosted", {}));
  assert.equal(catalogLaunchHref(hosted), "https://example.test/play");
  const streamed = createLauncherCatalogEntry({ ...game("streamed"), runtime: "streamed", renderer: "video" }, input("streamed", {}));
  assert.equal(catalogLaunchHref(streamed), undefined);
});
