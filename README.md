# 101

**One local gaming runtime where almost anything can become a controller.**

101 is an open-source-first, local-first, browser-first gaming platform. Games consume normalized actions such as `move`, `aim`, `slash`, and `pose`; the shipped adapters handle keyboards, pointers, gamepads, phone motion, local cameras, and the native iOS/Android 101 Link app through the same public boundary.

This repository currently contains the **independent Game SDK/package format, registry, universal host, networking, browser and native Link controllers, native Tauri Hub, specialist hardware adapters, motion, local vision, rhythm, physics, deterministic-maze, scalable-swarm, and asymmetric-session foundation plus all ten playable game slices**: the launcher, manifest-driven catalog, core contracts, 101 Input Bus, role-aware session host, JSON-defined controller surfaces, WebHID/Bluetooth/Serial device mapping, renderer/physics/audio facades, deterministic generation utilities, engineering Labs, Slashstorm 101, TiltDrift 101, BodyDodge 101, Orbital Crew 101, BeatForge 101, GravityStack 101, Spellcaster 101, Echo Maze 101, Shadow Arena 101, and Swarm Commander 101. Watch companions remain an active implementation milestone; they are not represented as shipped until their source and tests land.

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

For automatic phone/LAN QR pairing, run the local Hub in another terminal:

```bash
npm run hub
```

Start the web runtime with `npm run dev -- --host 0.0.0.0`, open its LAN address, and choose **Connect device**. The Hub performs authenticated, expiring offer/answer exchange locally; gameplay uses direct WebRTC DataChannels and reconnects without another scan.

The `/controller` surface is an installable **101 Link PWA** with its own manifest, maskable icon, persistent standalone device identity, connection-status UI, pasteable pairing tickets, dynamic controller layouts, and an offline service-worker shell. Pairing URLs are explicitly excluded from caching so temporary join secrets are never persisted there.

`apps/controller-native` is the independently buildable **101 Link native app** for iOS and Android. It scans local pairing QR codes, reconnects with a durable device identity, uses two native WebRTC DataChannels, renders any validated host-supplied controller layout, includes classic/wand/steering/tilt/touch/trigger/motion/sensor-lab presets, performs quaternion calibration and gesture recognition locally, and supports host haptics. It declares no microphone use. See [native Link development](docs/native-link.md).

`apps/watch-ios` and `apps/watch-wear` are the **watch companions**. Each relays wrist motion to 101 Link on its own paired phone, which forwards it through the existing session, so a watch never speaks the 101 protocol or learns which game is running. Both encode the same 53-byte payload that `@101/adapter-watch` decodes into `watch.flick`, `watch.twist`, `watch.strike`, wrist axes, and a bounded crown dial. Because the Wear OS Data Layer may route over the network rather than Bluetooth, locality is reported as `verified-local` only when the OS confirms the node is nearby, and `cloud-possible` otherwise. Neither app requests health data. See [watch companions](docs/watches.md).

`apps/desktop-hub` is the packaged **101 Hub** for macOS, Windows, and Linux. Its native Rust coordinator starts without Node, exposes the same authenticated signaling API, advertises itself through mDNS, shows live sessions/controllers/LAN addresses, and stores settings, replay data, and validated downloaded game packages in the OS application-data directory. See [desktop Hub development](docs/desktop-hub.md).

Slashstorm 101 is playable from the launcher with pointer/touch, keyboard, gamepad, or up to two independent browser Link swords. Its infinite spawn director uses seeded randomness and combines target groups, hazards, armor, bonuses, pacing, and escalating difficulty.

TiltDrift 101 is a playable Three.js racing slice. Use Left/Right or A/D to steer, Space to boost, Down/S to brake, and Shift/X to drift. Its tested road grammar produces continuous, seed-repeatable spline-like segments, bounded widths, changing environments, and traffic combinations.

The **Motion Lab** requests sensor permission only after an explicit click, corrects screen orientation, calibrates a neutral quaternion, filters noisy acceleration/rotation, recognizes gestures with hysteresis, and publishes normalized tilt/steer frames through `@101/adapter-motion`. A keyboard simulation makes the pipeline inspectable on desktops without sensors.

The **Vision Lab** uses bundled MediaPipe code, WASM, and local pose and hand models—there is no runtime CDN. Camera permission follows an explicit click, raw frames remain in the browser, and the 101 classifiers turn 33 body landmarks or 21 hand landmarks into calibrated body actions, stable hand poses, swipes, and circles. Keyboard simulation exercises the identical pose adapter without requesting a camera.

BodyDodge 101 is a playable Three.js survival slice. Move or lean left/right, duck, jump, or raise both arms to pass an infinite deterministic gate grammar. Camera pose is optional; keyboard, gamepad, and a dynamically assigned Link movement panel are available immediately.

Orbital Crew 101 is a playable asymmetric co-op slice. Up to five browser Link devices are assigned pilot, weapons, shields, reactor, and emergency roles, each with a different host-defined panel and live ship readout. A keyboard or gamepad captain can operate every station without any connected device. Its seeded sector director overlaps multi-role threats and schedules deterministic boss encounters.

BeatForge 101 is a playable endless rhythm/movement slice. A reusable `@101/rhythm` clock grades input in time-based windows while the seeded director varies BPM, subdivisions, actions, and compatible two-action chords. Keyboard, gamepad, Link motion, and optional local body pose all reach the same semantic beat actions. Its short cues are generated locally through `@101/audio`, so no remote or licensed music asset is required.

GravityStack 101 is a playable endless variable-gravity tower. Its game module sees only opaque 101 physics handles and normalized `gravity`, `placeX`, and `drop` controls; Rapier remains inside `@101/physics`. A phone can rotate gravity while a conventional player places pieces, or a second Link device can receive a dedicated builder panel.

Spellcaster 101 is a playable seeded survival arena built around a reusable temporal hand classifier. Open palm, pinch, fist, two fingers, swipe, and circle become the same `spell.cast.*` events emitted by phone motion, keyboard, and gamepad adapters. The optional camera uses the bundled hand model locally; conventional controls remain immediately playable.

Echo Maze 101 is a playable endless exploration slice driven by the reusable `@101/maze` perfect-maze generator. An assigned Link scanner receives role-private target bearings, path distance, signal strength, and echo proximity. Without a phone, the required clue appears on the host, so enhanced hardware never gates progress.

Shadow Arena 101 is a playable endless silhouette-combat slice. The reusable pose classifier distinguishes left and right punches, guard, duck, jump, and deliberate two-arm specials, and the camera adapter emits the same `combat.*` vocabulary as Link, keyboard, and gamepad mappings. The body camera remains optional and local.

Swarm Commander 101 is a playable real-time strategy/action slice powered by `@101/swarm`. Spatial-hash separation and instanced rendering keep hundreds of agents responsive across cluster, line, wedge, ring, and grid formations. Mouse or hand pointing sets precise command targets, while separate Link navigator and tactician roles can steer and reshape the same collective.

The **Network Lab** creates compressed manual WebRTC offers and answers without a signaling server. It opens a reliable control channel plus an unordered zero-retransmit realtime channel and reports round-trip latency, jitter, loss, candidate path, and bytes transferred. Normal **Connect device** pairing uses the local Hub, expiring QR tickets, per-peer secrets, multi-controller WebRTC, and generation-based reconnect. BroadcastChannel remains the fastest same-browser test path.

The **Controller Lab** validates editable controller-layout JSON, applies it live to 101 Link, and inspects the normalized actions, axes, and vectors returned by buttons, D-pads, sticks, touch surfaces, sliders, and optional motion mappings.

The **Hardware Lab** connects optional WebHID, Web Bluetooth, and Web Serial devices through one declarative byte mapping. It reports real per-API support, secure-context, and permission state honestly, opens each browser chooser only on an explicit click, and prints the resulting normalized 101 frame. Because all three transports share `@101/hardware`, a mapping authored for a serial prototype keeps working when the same board later enumerates as HID. See [specialist hardware](docs/hardware.md).

## Verify it

```bash
npm run typecheck
npm test
npm run lint
npm run license:inventory
npm run audit:production
npm run native:test
npm run native:typecheck
npm run native:doctor
npm run native:export
npm run desktop:check
npm run desktop:test
npm run desktop:app
npm run watch:ios:test
npm run watch:ios:check
npm run watch:wear:test
npm run watch:wear:build
```

Production build:

```bash
npm run build
```

The unit suite includes seeded full-loop simulations for all ten games, controller-role/input-manifest contract checks, session failover tests, and focused engine/adapter tests. `npm test` then creates a production build and server-renders the launcher, every standalone game, the Link surface, and all engineering Labs.

`npm run audit:production` gates production dependencies. It separates root-cause advisories from propagated ones and requires each root cause to be reviewed in [`security/build-tooling-advisories.json`](security/build-tooling-advisories.json) with a dependency path, justification and expiry date, so a new advisory can never pass unnoticed and an accepted one cannot be forgotten. Only developer build tooling may be accepted; anything reaching the web runtime or a shipped mobile bundle must be fixed. See [privacy and security](docs/privacy-security.md).

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
Adapters        keyboard · pointer · gamepad · motion · camera pose/hand · future devices
```

The hard rule is simple: **game code does not import browser or hardware APIs**. A game asks for `ctx.input.vector("move")`; the runtime decides which connected source can provide it.

Key packages:

| Package | Responsibility |
| --- | --- |
| `@101/input` | Frames, normalization, stale-frame rejection, players and adapters |
| `@101/protocol` | Versioned messages, BroadcastChannel and WebRTC transports, offline pairing, compact motion packets |
| `@101/pairing` | Expiring LAN tickets, authenticated signaling, multi-peer WebRTC negotiation and reconnect |
| `@101/hub-server` | Real local HTTP signaling service shared by development and the desktop Hub contract |
| `@101/session` | Capability-aware role assignment, targeted controller layouts, heartbeats and host-side frame identity enforcement |
| `@101/link-controller` | Shared browser/native Link input state, neutral role transitions, and stale-control prevention |
| `@101/sdk` | Public game lifecycle and manifest types |
| `@101/game-registry` | Version-aware installation state and launcher catalog for bundled, local and downloaded packages |
| `@101/game-host` | Turnkey Input Bus, adapter, session, transport, controller-role and game lifecycle composition |
| `@101/devkit` | Safe external-game scaffold generator and templates |
| `@101/core` | Runtime lifecycle and seeded procedural utilities |
| `@101/motion` | Quaternion-based smoothing/calibration pipeline |
| `@101/adapter-motion` | Lazy browser permission, device orientation correction, gestures and normalized frames |
| `@101/vision` | Pose calibration plus hand landmark smoothing and temporal gesture state machines |
| `@101/adapter-camera` | Lazy local capture plus replaceable bundled MediaPipe pose/hand inference |
| `@101/hardware` | Declarative byte-to-frame mapping, serial framers and shared specialist-device frame emission |
| `@101/adapter-hid` | Filtered WebHID chooser, already-granted reconnect, mapped input reports and output reports |
| `@101/adapter-bluetooth` | Single-service BLE GATT notifications, optional writes and range-loss release |
| `@101/adapter-serial` | Framed serial reads with bounded buffering, host writes and unplug release |
| `@101/adapter-watch` | Wrist gestures, crown dial, shared watch wire format and honest transport locality |
| `@101/diagnostics` | Input rate, frame age and dropped-frame instrumentation |
| `@101/replay` | Seed, input-frame and deterministic-event recording |
| `@101/rhythm` | Frame-rate-independent beat/time conversion, quantization and timing judgments |
| `@101/maze` | Deterministic connected maze generation, reciprocal walls, routing and bearings |
| `@101/swarm` | Centered formation grammars, spatial-hash separation, bounded steering and precision selection |
| `@101/render-2d` | Phaser facade with external input disabled |
| `@101/render-3d` | Three.js facade and adaptive pixel-ratio boundary |
| `@101/physics` | Opaque handles, world stepping, runtime gravity and narrow Rapier operations |
| `@101/audio` | Howler-based music/SFX facade plus generated offline tone cues |

Read [the architecture guide](docs/architecture.md) for invariants and package boundaries.

## Add a game

Generate a complete independent package. The launcher discovers manifests at build time; it does not contain a hand-maintained list.

```bash
npm run create:game -- my-game "My Game" 2d
```

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

The public package boundary also has machine-readable [game manifest](schemas/game-manifest.schema.json), [input manifest](schemas/input-manifest.schema.json), and [controller layout](schemas/controller-layout.schema.json) schemas. [Meteor Dash](examples/external-game/README.md) demonstrates a game authored as if it lived in another repository. `Game101.package()` validates the complete contract, `GameRegistry` installs it, and `GameHost101` runs it without game-specific controller or networking code.

## Repository map

```text
app/                 launcher and browser-controller surfaces
packages/            versioned 101 runtime boundaries
games/               manifests plus independently playable game code
examples/            external-developer package examples
schemas/             public JSON contracts for games and Link layouts
docs/                architecture, protocol, privacy and contributor guides
tools/               release and license tooling
tests/               production-render smoke tests
```

The root web surface stays at `app/` because the browser runtime expects it there. Native and desktop targets live under `apps/`. OpenAI Sites metadata and its build-packaging plugin have been removed; this repository is not configured to publish there.

## Foundation milestones

- [x] Strict TypeScript workspace and browser launcher
- [x] SDK, core runtime and manifest-driven catalog
- [x] Independent game package contract, registry, generic host, JSON Schemas and scaffolding CLI
- [x] Input Bus with keyboard, pointer/touch and Gamepad adapters
- [x] Transport-independent protocol plus fixed-size motion codec
- [x] 2D, 3D, physics and audio facades
- [x] Seeded randomness, replay contract and input diagnostics
- [x] Playable Input Lab and same-browser Link controller
- [x] Strict-local WebRTC control/realtime channels and manual offline pairing
- [x] Network Lab with latency, jitter, loss and connection-path diagnostics
- [x] Slashstorm playable vertical slice with seeded infinite director
- [x] Calibrated Motion Lab with raw/filtered diagnostics and keyboard simulation
- [x] Dynamic browser Link roles that switch sword/classic/steering panels without reconnecting
- [x] TiltDrift playable 3D slice with a continuous seeded road director
- [x] Bundled local MediaPipe pose adapter and Vision Lab with simulated fallback
- [x] Pose landmarks available through `ctx.input.pose()` and semantic body actions
- [x] BodyDodge playable 3D slice with a validated seeded gate grammar
- [x] Protocol v2 with targeted JSON controller layouts and live role state
- [x] Capability-aware session roles with stable assignment and host-verified frame identity
- [x] Orbital Crew asymmetric slice with five Link roles and a seeded infinite sector director
- [x] Controller Lab for validated custom layouts and live normalized-frame inspection
- [x] Frame-rate-independent rhythm package and BeatForge endless movement slice
- [x] Opaque Rapier handles, rotating gravity, and GravityStack two-role physics slice
- [x] Bundled local hand landmarks, temporal gesture state machine, and switchable Vision Lab
- [x] Spellcaster slice with identical semantic spells from camera, phone motion, keyboard, and gamepad
- [x] Deterministic `@101/maze` generator and Echo Maze private companion-display slice
- [x] Reusable combat-pose vocabulary and Shadow Arena camera/Link/conventional-control slice
- [x] Scalable `@101/swarm` formations, spatial steering, and Swarm Commander specialist-role slice
- [x] Seeded full-loop simulations and manifest/controller contracts for all ten games
- [x] Browser Link watchdog, automatic role failover, standby state, and neutral cross-game transitions
- [x] Graceful 3D fallback when WebGL is unavailable while gameplay/input keep running
- [x] Automatic LAN QR signaling, multi-peer WebRTC, targeted private routing and transport reconnect
- [x] Installable offline 101 Link PWA with transport selection and secret-safe caching
- [x] Native iOS/Android 101 Link with QR, dynamic layouts, motion calibration, gestures, haptics and native WebRTC
- [x] Native Tauri 101 Hub with authenticated signaling, mDNS discovery, local settings/replays/packages and a packaged desktop dashboard
- [x] Declarative WebHID/Web Bluetooth/Web Serial adapters, Hardware Lab and surprise-disconnect input release
- [x] Apple Watch and Wear OS companions with a shared wire format and honest transport-locality reporting
- [ ] Face/head landmark adapter plus richer multi-hand gesture vocabularies
- [x] Phone-side watch bridge as a local Expo module, compiled into both native builds, with health permissions blocked
- [x] Emulator verification: Android Link, Wear OS Link, Hub signaling and LAN WebRTC pairing all run and connect
- [x] iOS 101 Link launches and runs — Expo precompiled modules broke module registration; the app now builds them from source ([details](docs/native-link.md#ios-expo-modules-must-build-from-source))
- [x] Signaling failures report connection state instead of raising unhandled promise rejections
- [x] iOS pairing works — a keychain exception was silently disabling identity, the launch URL and Connect ([details](docs/native-link.md#solved-ios-pairing-and-why-it-looked-like-three-separate-bugs))
- [x] Monochrome, scheme-aware design system across native, browser controller and launcher
- [ ] On-wrist hardware testing and a signed watchOS app target

## Packaging

```bash
npm run package:release
```

Collects the distributable artifacts under `release/` and writes `release/manifest.json`. The targets need genuinely different toolchains — Node for the web build, Rust and Tauri for the desktop Hub, the Android SDK and JDK 21 for the Wear OS watch — so each is attempted independently and anything skipped is named along with the reason. A skipped target is never silently omitted, because "we shipped everything" and "we shipped what this machine could build" are different claims. Pass target names (`web`, `hub`, `link`, `wear`) to build a subset.

Apple installables are deliberately absent. An iOS or watchOS build needs a provisioning profile tied to a registered Apple Developer account, so no repository can produce one on your behalf; [native Link](docs/native-link.md) and [watch companions](docs/watches.md) give the signing steps instead.

## Documentation

| Document | Covers |
| --- | --- |
| [Architecture](docs/architecture.md) | Package boundaries and why game code never touches a device API |
| [Game development](docs/game-development.md) | Writing a game against the SDK, in this repository or your own |
| [Adapter development](docs/adapter-development.md) | Turning a new input source into `InputFrame` |
| [Capability negotiation](docs/capability-negotiation.md) | How a game's declared input needs are matched against the hardware actually present |
| [Protocol](docs/protocol.md) | Versioned message contract, control and realtime channels |
| [Controller pairing](docs/controller-pairing.md) | Every pairing mode, from same-browser to offline manual WebRTC |
| [Native Link](docs/native-link.md) | The iOS and Android controller app |
| [Desktop Hub](docs/desktop-hub.md) | The packaged Tauri session coordinator |
| [Watch companions](docs/watches.md) | Apple Watch and Wear OS, and honest transport locality |
| [Specialist hardware](docs/hardware.md) | WebHID, Web Bluetooth and Web Serial mapping |
| [Vision](docs/vision.md) | Local pose and hand landmark pipelines |
| [Privacy and security](docs/privacy-security.md) | Local-first guarantees and the dependency gate |
| [Offline cache](docs/offline-cache.md) | What the installed controller stores, and why the build is pinned to its source |
| [Emulator QA](docs/emulator-qa.md) | What has actually been *run*, per target, and what has not |

## Privacy and offline behavior

The launcher and game runtime require no account, analytics, database, or cloud gameplay service. Runtime dependencies are bundled. The architecture requires camera, motion, and microphone processing to stay local by default, with clear permission copy and no recording. See [privacy and security](docs/privacy-security.md).

## License

101-authored source is available under the [MIT License](LICENSE). Dependencies retain their own licenses and copyright. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the generated `THIRD_PARTY_LICENSES.json` and `THIRD_PARTY_RUST_LICENSES.json` inventories.
