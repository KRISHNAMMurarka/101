export interface GameScaffoldOptions {
  id: string;
  name: string;
  renderer?: "2d" | "3d";
  description?: string;
}

export function createGameScaffold(options: GameScaffoldOptions): Readonly<Record<string, string>> {
  const id = gameId(options.id);
  const name = displayName(options.name);
  const renderer = options.renderer ?? "2d";
  const description = options.description?.trim() || `${name}, built for the 101 Engine.`;
  const manifest = {
    id, name, tagline: description, version: "0.1.0", engine: "^1", renderer,
    players: { min: 1, max: 1 }, inputs: ["keyboard", "touch", "gamepad"],
    offline: true, procedural: true, status: "playable", accent: "#50e3ff",
    controllers: { basic: ["keyboard", "touch", "gamepad"] },
  };
  const input = {
    game: id,
    actions: { trigger: { recommended: ["touch", "gamepad"], fallback: ["keyboard"], description: "Perform the primary action." } },
    vectors: { move: { recommended: ["gamepad", "touch"], fallback: ["keyboard"] } },
  };
  return Object.freeze({
    "package.json": `${JSON.stringify({ name: `@games/${id}`, version: "0.1.0", private: true, type: "module", dependencies: { "@101/sdk": "^0.1.0" } }, null, 2)}\n`,
    "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "input.manifest.json": `${JSON.stringify(input, null, 2)}\n`,
    "src/game.ts": gameSource(id),
    "src/roles.ts": rolesSource(),
    "src/index.ts": indexSource(),
    "src/game.test.ts": testSource(id),
    "README.md": readme(name, id),
  });
}

function gameSource(id: string) {
  return `import { Game101 } from "@101/sdk";\n\nexport default Game101.define({\n  id: "${id}",\n  initialState: () => ({ score: 0 }),\n  start(ctx) {\n    ctx.input.bind("move");\n    ctx.input.bind("trigger");\n  },\n  update(ctx, deltaSeconds) {\n    const move = ctx.input.vector("move");\n    const trigger = Boolean(ctx.input.action("trigger"));\n    if (trigger) ctx.state.score += Math.max(1, Math.round(deltaSeconds * 60));\n    void move; // Feed this normalized vector into gameplay.\n  },\n});\n`;
}

function rolesSource() {
  return `import type { GameControllerRole } from "@101/sdk";\n\nexport const controllerRoles = [{\n  id: "player-one",\n  label: "Player One",\n  playerId: "player-1",\n  requiredCapabilities: ["touch"],\n  preferredCapabilities: ["haptics"],\n  layout: {\n    title: "Player One",\n    accent: "#50e3ff",\n    layout: [\n      { type: "joystick", action: "move", label: "MOVE" },\n      { type: "button", action: "trigger", label: "ACTION", emphasis: "primary" },\n    ],\n  },\n}] as const satisfies readonly GameControllerRole[];\n`;
}

function indexSource() {
  return `import { Game101 } from "@101/sdk";\nimport manifest from "../manifest.json" with { type: "json" };\nimport input from "../input.manifest.json" with { type: "json" };\nimport game from "./game.ts";\nimport { controllerRoles } from "./roles.ts";\n\nexport default Game101.package({ manifest, input, controllers: controllerRoles, game });\n`;
}

function testSource(id: string) {
  return `import assert from "node:assert/strict";\nimport test from "node:test";\nimport gamePackage from "./index.ts";\n\ntest("${id} exports a valid 101 package", () => {\n  assert.equal(gamePackage.manifest.id, "${id}");\n  assert.ok(gamePackage.manifest.controllers?.basic.length);\n});\n`;
}

function readme(name: string, id: string) {
  return `# ${name}\n\nGenerated with \`npm run create:game -- ${id} "${name}"\`.\n\nThe exported package contains its lifecycle, manifests, and universal Link layout. Games read only semantic 101 inputs; \`@101/game-host\` owns adapters, sessions, transport, role assignment, and controller reconfiguration.\n`;
}

function gameId(value: string) {
  const result = value.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result) || result.length > 64) throw new Error("Game id must be lowercase kebab-case");
  return result;
}

function displayName(value: string) {
  const result = value.trim();
  if (!result || result.length > 80) throw new Error("Game name must contain 1-80 characters");
  return result;
}
