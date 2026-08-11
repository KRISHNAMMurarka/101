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

## Rendering and physics

Phaser, Three.js, Rapier and Howler are imported only by facade packages. Phaser's own input and audio modules are disabled in the facade configuration so games cannot accidentally bypass 101 Input or 101 Audio. These wrappers are intentionally small and replaceable.

## Procedural play

`SeededRandom` guarantees that the same seed produces the same random sequence. `difficultyAt()` combines density, speed, reaction time, simultaneous threats, and modifier chance with explicit safety caps. Each game should add a validator that rejects impossible generated segments before they enter play.

## Phase boundaries

The same-browser controller remains a fast diagnostic transport and streams calibrated phone motion when the user grants permission. Its UI is now rendered from the targeted `ControllerLayout`, which Orbital Crew uses for pilot, weapons, shields, reactor, and emergency stations. Vision Lab and BodyDodge use a bundled single-person pose model locally; hand/face tasks and worker-based inference remain later vision phases. WebRTC provides reliable control and disposable realtime channels behind `LinkTransport`, including a fully offline manual pairing flow. Automatic LAN discovery, reconnect, native sensor collection, Tauri Hub and specialist hardware adapters remain separate phases.
