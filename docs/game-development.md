# Game development

## Start with intent

Define actions in game language: `slash`, `steer`, `spell.cast`, `reactor.route`, `formation`, not hardware language such as `gyroscopeY` or `gamepadButton0`.

Each game needs:

1. `manifest.json` for launcher discovery and capability matching.
2. A `Game101.define()` export.
3. Conventional fallback mappings.
4. A seeded generator and validation strategy when procedural play is enabled.

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

## Runtime rules

- Bind semantic controls in `start()`.
- Read controls during `update()`.
- Use `deltaSeconds`; never tie movement to rendered frame count.
- Keep rendering, physics and audio behind 101 facades.
- Do not request permissions or discover devices inside game code.
- Record deterministic decisions that cannot be reproduced from the seed and input stream alone.

## Controller presets

Publish basic, enhanced and immersive presets. The launcher must always expose a playable conventional preset. Enhanced hardware improves the experience; it does not gate entry.

Asymmetric games may additionally publish `SessionRole` definitions outside the gameplay module. Each role declares its normalized `playerId`, capability preferences, and a JSON `ControllerLayout`. The platform host owns transport, registration, identity enforcement, layout delivery, and haptics. The `Game101.define()` module continues to read only actions, axes, vectors, and poses for the role player IDs.

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
