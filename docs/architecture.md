# 101 architecture

## Product boundary

101 separates **intent** from **hardware**. A game consumes a stable input vocabulary. Adapters translate physical devices into that vocabulary. Network transports move frames, but neither a game nor the Input Bus depends on a particular transport.

```text
Game definition
  └─ @101/sdk
      └─ @101/core
          ├─ @101/input
          │   └─ adapters
          ├─ @101/session
          │   └─ capability roles + controller layouts
          ├─ renderer facade
          ├─ physics facade
          ├─ audio facade
          ├─ rhythm clock
          ├─ maze + swarm simulation utilities
          ├─ replay
          └─ diagnostics

101 Link / hardware
  └─ LinkTransport
      └─ @101/protocol
          └─ @101/input InputFrame
```

## Non-negotiable invariants

1. A game never calls `navigator.getGamepads()`, sensor APIs, camera APIs, HID, Bluetooth, Serial, WebSocket, or WebRTC directly.
2. Adapters emit `InputFrame`; they do not own game rules.
3. Realtime frames are ordered by `deviceId` and `sequence`. The Input Bus rejects stale frames.
4. Control messages are reliable and versioned. High-frequency sensor frames are disposable.
5. Every enhanced or immersive action has a conventional keyboard, pointer, touch, or gamepad fallback where practical.
6. Runtime assets, models, WASM and dependencies are bundled for installed/offline play.
7. Camera, microphone and motion processing remain on the source device unless a user explicitly opts into a documented exception.

## Runtime lifecycle

`Engine101` constructs a game-owned state object and exposes the narrow SDK context. It caps large delta values so timing is not tied to frame count. The host owns adapters and supplies an `InputBus`; the game can bind and read controls but cannot register hardware.

## Input resolution

Frames are stored per player and device. Reads choose the newest device that contains the requested control. Actions, axes, vectors, and compact pose arrays share the same sequencing and stale-frame rejection path. This allows a keyboard to provide movement while a phone supplies aim, or a camera pose adapter to provide `dodgeX` and `duck`.

`@101/session` owns capability-aware asymmetric assignment. A host publishes ordered role definitions with required/preferred capabilities and JSON controller layouts. The session preserves stable matches when possible, selects stronger capability matches when a new device joins, targets configuration to one device, expires missing heartbeats, and overwrites the `deviceId` and `playerId` claimed by every accepted realtime frame. Game code still sees only normalized player input.

## Rendering, physics, audio, and rhythm

Phaser, Three.js, Rapier and Howler are imported only by facade packages. Phaser's own input and audio modules are disabled in the facade configuration so games cannot accidentally bypass 101 Input or 101 Audio. These wrappers are intentionally small and replaceable.

`@101/physics` returns opaque numeric body/collider handles, not Rapier objects. It owns initialization, bounded substeps, runtime gravity, state snapshots, impulses, transforms, raycasts, and cleanup. GravityStack therefore demonstrates a real physics game without importing the implementation engine into its game code.

`@101/audio` owns Howler instances, category/master volumes, panning, pooling, background mute state, and cleanup. It can generate short PCM tone assets locally for diagnostics and included game cues. `@101/rhythm` is engine-independent: beat conversion, quantization, and symmetric timing judgments use seconds rather than rendered frames.

## Procedural play

`SeededRandom` guarantees that the same seed produces the same random sequence. `difficultyAt()` combines density, speed, reaction time, simultaneous threats, and modifier chance with explicit safety caps. Each game adds a validator that rejects impossible generated segments before they enter play. BeatForge advances pressure by generated phrase count so denser subdivisions cannot slow their own progression; GravityStack generates bounded shapes/materials before creating physics bodies. `@101/maze` carves reciprocal passages, validates full connectivity, exposes shortest paths and bearings, and lets Echo Maze vary floor size, themes, fragments, hazards, and modifiers without game-specific pathfinding. `@101/swarm` keeps formation assignment deterministic, centers and rotates slots without changing agent identity, and uses a spatial hash for local separation rather than an all-pairs loop. Swarm Commander combines it with a separately seeded wave/terrain director.

## Phase boundaries

The same-browser controller remains a fast diagnostic transport and streams calibrated phone motion when the user grants permission. Its UI is rendered from the targeted `ControllerLayout`: Orbital Crew uses five ship stations, BeatForge uses one motion performer, GravityStack can split gravity/building across two devices, Spellcaster maps motion gestures to semantic spells, Echo Maze targets private scanner readouts to one role, Shadow Arena assigns a combat panel, and Swarm Commander divides vector steering from formation tactics without reconnecting or adding networking to game code. Vision Lab and camera-enabled games use bundled pose and hand models locally; face/head tasks and worker-based inference remain later vision phases. WebRTC provides reliable control and disposable realtime channels behind `LinkTransport`, including a fully offline manual pairing flow. Automatic LAN discovery, reconnect, native sensor collection, Tauri Hub and specialist hardware adapters remain separate phases.
