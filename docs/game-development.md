# Game development

## Start with intent

Define actions in game language: `slash`, `steer`, `spell.cast`, `reactor.route`, `formation`, not hardware language such as `gyroscopeY` or `gamepadButton0`.

Each game package needs:

1. `manifest.json` for launcher discovery and capability matching.
2. `input.manifest.json` for semantic actions, axes, vectors, and poses.
3. A `Game101.define()` gameplay lifecycle.
4. Optional universal Link roles expressed as JSON layouts.
5. One `Game101.package()` export that validates all of the above together.
6. Conventional fallback mappings.
7. A seeded generator and validation strategy when procedural play is enabled.

Create that structure with:

```bash
npm run create:game -- meteor-dash "Meteor Dash" 2d
```

The generator refuses to overwrite an existing directory. The result contains a package export, manifests, controller role, lifecycle, test, and README. `schemas/` contains JSON Schemas for editor completion and non-TypeScript tooling.

## Manifest

```json
{
  "id": "slashstorm",
  "name": "Slashstorm 101",
  "version": "0.1.0",
  "engine": "^1",
  "renderer": "2d",
  "players": { "min": 1, "max": 2 },
  "inputs": ["keyboard", "mouse", "gamepad", "phone-motion", "camera-hand"],
  "offline": true,
  "procedural": true,
  "controllers": {
    "basic": ["keyboard", "mouse", "gamepad"],
    "enhanced": ["phone-motion"],
    "immersive": ["camera-hand"]
  }
}
```

The launcher discovers `games/*/manifest.json` during its build. Adding a manifest does not require editing the launcher catalog.

## Package export

```ts
import { Game101 } from "@101/sdk";
import manifest from "../manifest.json" with { type: "json" };
import input from "../input.manifest.json" with { type: "json" };
import game from "./game.ts";
import { controllerRoles } from "./roles.ts";

export default Game101.package({
  manifest,
  input,
  controllers: controllerRoles,
  game,
});
```

`Game101.package()` is the trust boundary. It rejects incompatible engine versions, mismatched IDs, invalid sources, missing conventional presets, duplicate roles/player channels, unsupported capabilities, malformed controller JSON, and controller elements that target undeclared inputs. The result is deeply frozen before a registry or host accepts it.

Use `@101/game-registry` to install bundled, local, or downloaded packages and generate a launcher catalog. Use `@101/game-host` to launch one: it owns the Input Bus, adapters, session, role assignment, controller reconfiguration, frame identity enforcement, and game runtime. A developer game does not construct a transport or handle permissions.

## Runtime rules

- Bind semantic controls in `start()`.
- Read controls during `update()`.
- Use `deltaSeconds`; never tie movement to rendered frame count.
- Keep rendering, physics and audio behind 101 facades.
- Do not request permissions or discover devices inside game code.
- Record deterministic decisions that cannot be reproduced from the seed and input stream alone.

## Controller presets

Publish basic, enhanced and immersive presets. The launcher must always expose a playable conventional preset. Enhanced hardware improves the experience; it does not gate entry.

Asymmetric games publish `GameControllerRole` definitions outside the gameplay module. Each role declares its normalized `playerId`, capability preferences, and a JSON `ControllerLayout`. The platform host owns transport, registration, identity enforcement, layout delivery, and haptics. The `Game101.define()` module continues to read only actions, axes, vectors, and poses for the role player IDs.

Games that use a private companion display should keep clue calculation in deterministic game state, then let the host route a minimal `controller.state` readout to a role. Do not import a transport into the game module. Required information must remain available through a conventional host-screen fallback when no companion is assigned.

## Rhythm and physics boundaries

Use `@101/rhythm` when note timing matters. Store target times in seconds, derive them from beats/BPM, and judge offsets through declared windows. Do not advance a song clock by frame count, and keep procedural difficulty independent from any subdivision that would accidentally slow its own progression.

Use `@101/physics` for bodies, colliders, impulses, velocities, transforms, raycasts, and runtime gravity. Game state may retain `PhysicsBody101` handles and plain `BodyState101` snapshots; it must not retain or import Rapier classes. The renderer should consume the plain snapshots, keeping simulation and display replaceable.

## Infinite directors

Use this pipeline:

```text
seed → difficulty profile → grammar → content selection
     → modifiers → spawn director → validator → playable segment
```

Difficulty should combine several bounded pressures. Every generator needs tests proving seed repeatability and validators proving required routes, reaction windows, and resources remain possible.

Use `@101/maze` when a game needs a connected grid. It provides deterministic carving, reciprocal wall validation, legal travel, shortest routes, bearings, and compass labels; games add their own content and difficulty rules without duplicating traversal infrastructure.

Use `@101/swarm` when many 2D agents need one command intent. It provides deterministic centered slots for cluster, line, wedge, ring, and grid formations; bounded acceleration/speed; spatial-hash neighbor separation; selection by radius; and centroid queries. The package mutates agent state in place to avoid hundreds of per-frame allocations. Games still own combat, economy, terrain, rendering, and seeded encounter direction.
