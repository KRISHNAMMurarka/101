# 101

**One local gaming runtime where almost anything can become a controller.**

101 is an open-source-first, local-first, browser-first gaming platform. Games consume normalized actions such as `move`, `aim`, `slash`, and `pose`; adapters handle keyboards, pointers, gamepads, phones, cameras, watches, and future hardware.

This repository currently contains the **networking foundation and first playable game slice**: the launcher, manifest-driven catalog, core contracts, 101 Input Bus, renderer/physics/audio facades, deterministic generation utilities, Input Lab, an offline WebRTC Network Lab, and Slashstorm 101. It deliberately does not present the remaining nine games, native Link app, vision, watches, automatic LAN discovery, or production reconnect as finished.

![101 social card](public/og.png)

## Run it

Requirements: Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Open the local address printed by the development server. The Input Lab supports:

- WASD or arrow keys to move
- pointer or touch to aim
- click, Space, or gamepad A to trigger
- a same-browser 101 Link controller opened from **Connect device**

Slashstorm 101 is playable from the launcher with pointer/touch, keyboard, gamepad, or the browser Link controller. Its infinite spawn director uses seeded randomness and combines target groups, hazards, armor, bonuses, pacing, and escalating difficulty.

The **Network Lab** creates compressed manual WebRTC offers and answers without a signaling server. It opens a reliable control channel plus an unordered zero-retransmit realtime channel and reports round-trip latency, jitter, loss, candidate path, and bytes transferred. The same-browser controller still uses `BroadcastChannel` as the fastest local test path.

## Verify it

```bash
npm run typecheck
npm test
npm run lint
npm run license:inventory
```

Production build:

```bash
npm run build
```

## Architecture

```text
101 Game
   ↓  @101/sdk
101 Engine ───── renderer / physics / audio facades
   ↓
101 Input Bus   actions · axes · vectors · poses
   ↓
101 Protocol    reliable control + disposable realtime frames
   ↓
Adapters        keyboard · pointer · gamepad · future devices
```

The hard rule is simple: **game code does not import browser or hardware APIs**. A game asks for `ctx.input.vector("move")`; the runtime decides which connected source can provide it.

Key packages:

| Package | Responsibility |
| --- | --- |
| `@101/input` | Frames, normalization, stale-frame rejection, players and adapters |
| `@101/protocol` | Versioned messages, BroadcastChannel and WebRTC transports, offline pairing, compact motion packets |
| `@101/sdk` | Public game lifecycle and manifest types |
| `@101/core` | Runtime lifecycle and seeded procedural utilities |
| `@101/motion` | Quaternion-based smoothing/calibration pipeline |
| `@101/diagnostics` | Input rate, frame age and dropped-frame instrumentation |
| `@101/replay` | Seed, input-frame and deterministic-event recording |
| `@101/render-2d` | Phaser facade with external input disabled |
| `@101/render-3d` | Three.js facade and adaptive pixel-ratio boundary |
| `@101/physics` | Narrow Rapier facade |
| `@101/audio` | Howler-based music/SFX facade |

Read [the architecture guide](docs/architecture.md) for invariants and package boundaries.

## Add a game

Every game owns a `manifest.json`. The launcher discovers manifests at build time; it does not contain a hand-maintained list.

```ts
import { Game101 } from "@101/sdk";

export default Game101.define({
  id: "my-game",
  initialState: () => ({ score: 0 }),
  start(ctx) {
    ctx.input.bind("move");
    ctx.input.bind("trigger");
  },
  update(ctx, delta) {
    const move = ctx.input.vector("move");
    const trigger = ctx.input.action("trigger");
    // gameplay only — no networking, permission, or hardware code
  },
});
```

See [game development](docs/game-development.md) and [adapter development](docs/adapter-development.md).

## Repository map

```text
app/                 launcher and browser-controller surfaces
packages/            versioned 101 runtime boundaries
games/               manifests plus independently playable game code
docs/                architecture, protocol, privacy and contributor guides
tools/               release and license tooling
tests/               production-render smoke tests
```

The root web surface stays at `app/` because the browser-hosting runtime expects it there. Native and desktop application targets will live under `apps/` as they enter their implementation phases.

## Foundation milestones

- [x] Strict TypeScript workspace and browser launcher
- [x] SDK, core runtime and manifest-driven catalog
- [x] Input Bus with keyboard, pointer/touch and Gamepad adapters
- [x] Transport-independent protocol plus fixed-size motion codec
- [x] 2D, 3D, physics and audio facades
- [x] Seeded randomness, replay contract and input diagnostics
- [x] Playable Input Lab and same-browser Link controller
- [x] Strict-local WebRTC control/realtime channels and manual offline pairing
- [x] Network Lab with latency, jitter, loss and connection-path diagnostics
- [x] Slashstorm playable vertical slice with seeded infinite director
- [ ] Automatic LAN discovery, reconnect and QR encoding
- [ ] Native 101 Link sensor and haptic controller
- [ ] Motion Lab and vision playgrounds
- [ ] TiltDrift and BodyDodge vertical slices
- [ ] Tauri Hub, watches and optional hardware adapters

## Privacy and offline behavior

The launcher and game runtime require no account, analytics, database, or cloud gameplay service. Runtime dependencies are bundled. The architecture requires camera, motion, and microphone processing to stay local by default, with clear permission copy and no recording. See [privacy and security](docs/privacy-security.md).

## License

101-authored source is available under the [MIT License](LICENSE). Dependencies retain their own licenses and copyright. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the generated `THIRD_PARTY_LICENSES.json` inventory.
