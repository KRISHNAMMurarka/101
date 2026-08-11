# 101

**One local gaming runtime where almost anything can become a controller.**

101 is an open-source-first, local-first, browser-first gaming platform. Games consume normalized actions such as `move`, `aim`, `slash`, and `pose`; adapters handle keyboards, pointers, gamepads, phones, cameras, watches, and future hardware.

This repository currently contains the **Phase 1 foundation**: the launcher, manifest-driven catalog, core contracts, 101 Input Bus, protocol codecs, renderer/physics/audio facades, deterministic generation utilities, diagnostics, and a playable Input Lab. It deliberately does not present the ten planned games, native Link app, vision, watches, or WebRTC LAN pairing as finished.

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

The controller preview uses a `BroadcastChannel` transport so the protocol boundary can be tested without a server. Cross-device LAN and offline QR pairing belong to the networking phase and are not claimed by this preview.

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
| `@101/protocol` | Versioned messages, transport contract, compact motion packets |
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
- [ ] WebRTC control/realtime channels, reconnect and LAN pairing
- [ ] Native 101 Link sensor and haptic controller
- [ ] Motion Lab and vision playgrounds
- [ ] Slashstorm, TiltDrift and BodyDodge vertical slices
- [ ] Tauri Hub, watches and optional hardware adapters

## Privacy and offline behavior

The Phase 1 launcher and game runtime require no account, analytics, database, or cloud gameplay service. Runtime dependencies are bundled. The architecture requires camera, motion, and microphone processing to stay local by default, with clear permission copy and no recording. See [privacy and security](docs/privacy-security.md).

## License

101-authored source is available under the [MIT License](LICENSE). Dependencies retain their own licenses and copyright. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the generated `THIRD_PARTY_LICENSES.json` inventory.
