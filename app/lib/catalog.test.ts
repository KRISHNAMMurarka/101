import assert from "node:assert/strict";
import test from "node:test";
import type { InputManifest, InputSource } from "@101/input";
import type { GameManifest } from "@101/sdk";
import {
  createLauncherCatalogEntry,
  createSyntheticCatalog,
  filterCatalog,
  planCatalogWindow,
  type LauncherCatalogEntry,
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
  assert.deepEqual(fallback.playableWith, {
    "keyboard-only": true,
    "keyboard-mouse": true,
    "gamepad-only": false,
    phone: true,
  });

  const mouseRequired = createLauncherCatalogEntry(game("mouse-required"), input("mouse-required", {
    aim: { recommended: ["mouse"] },
  }));
  assert.equal(mouseRequired.playableWith["keyboard-only"], false,
    "keyboard-only must not quietly include a mouse");
  assert.equal(mouseRequired.playableWith["keyboard-mouse"], true);

  const phoneRequired = createLauncherCatalogEntry(game("phone-required"), {
    game: "phone-required",
    actions: { fire: { recommended: ["touch"] } },
    axes: { steer: { recommended: ["phone-motion"] } },
  });
  assert.equal(phoneRequired.playableWith.phone, true,
    "a phone profile provides both touch and motion");
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
    filterCatalog(entries, { input: "keyboard-only" }).map((entry) => entry.id),
    ["cafe-racer", "quiet-maze"],
  );
  assert.deepEqual(
    filterCatalog(entries, { query: "mouse art", input: "keyboard-only" }),
    [],
  );
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
