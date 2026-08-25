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
4. Control messages are reliable and versioned. High-frequency input and moment-bound feedback
   such as haptics and controller-speaker cues are disposable; delivering either feedback late is
   worse than dropping it.
5. Every enhanced or immersive action has a conventional keyboard, pointer, touch, or gamepad fallback where practical.
6. Runtime assets, models, WASM and dependencies are bundled for installed/offline play.
7. Camera, microphone and motion processing remain on the source device unless a user explicitly opts into a documented exception.

## Runtime lifecycle

`Engine101` constructs a game-owned state object and exposes the narrow SDK context. It caps large delta values so timing is not tied to frame count. The host owns adapters and supplies an `InputBus`; the game can bind and read controls but cannot register hardware.

`@101/sdk` is the public developer boundary. `Game101.package()` combines and validates the game lifecycle, launcher manifest, semantic input contract, and universal controller roles. `@101/game-registry` owns installation/catalog state, while `@101/game-host` composes the runtime, adapters, session and transport so a third-party game never needs infrastructure imports. JSON Schemas under `schemas/` support editors and other languages; runtime parsers remain authoritative at the trust boundary.

## Input resolution

Frames are stored per player and device. Reads combine simultaneous devices: active actions win over neutral actions, while the strongest live axis/vector intent wins with deterministic recency tie-breaking. Actions, axes, vectors, and compact pose arrays share the same sequencing and stale-frame rejection path. This prevents a newly polled neutral gamepad from masking a held keyboard key while still allowing a keyboard to provide movement and a phone to provide aim.

`@101/session` owns capability-aware asymmetric assignment. A host publishes ordered role definitions with required/preferred capabilities and JSON controller layouts. The session preserves stable matches when possible, selects stronger capability matches when a new device joins, targets configuration to one device, expires missing heartbeats, evicts that device's retained input frames, and overwrites the `deviceId` and `playerId` claimed by every accepted realtime frame. Game code still sees only normalized player input.

The controller advertises optional wire features in `hello`, separately from hardware capabilities.
When it offers `input-q1` and the assigned layout fits safely, the host selects that format in
`controller.configure`. Both ends derive the same ordered lane profile from the validated layout,
revision and assignment, so no action names travel in each frame. Pre-configuration frames, pose
frames, oversized layouts and layouts that reuse an action with incompatible shapes stay as JSON.
This keeps feature negotiation backwards-compatible and never truncates a controller to make it fit.

## Rendering, physics, audio, and rhythm

Phaser, Three.js, Rapier and Howler are imported only by facade packages. Phaser's own input and audio modules are disabled in the facade configuration so games cannot accidentally bypass 101 Input or 101 Audio. These wrappers are intentionally small and replaceable. The 3D facade probes WebGL capability and supplies a non-crashing canvas fallback if GPU rendering is unavailable; simulation and normalized input continue instead of taking down the launcher.

`@101/physics` returns opaque numeric body/collider handles, not Rapier objects. It owns initialization, bounded substeps, runtime gravity, state snapshots, impulses, transforms, raycasts, and cleanup. GravityStack therefore demonstrates a real physics game without importing the implementation engine into its game code.

`@101/audio` owns Howler instances, category/master volumes, panning, pooling, background mute state,
cleanup and the audio-clock timeline used by BeatForge. Manual and visibility mute state is applied
only to sounds owned by that instance; it never writes Howler's process-wide mute flag, so a hidden
or muted game cannot silence the one launched after it.
Short PCM tone assets are generated locally for diagnostics and included browser cues. BeatForge
schedules its metronome ahead against `AudioContext.currentTime`; rendering observes the rhythm
clock but no longer decides when a beat becomes audible. `@101/rhythm` remains engine-independent:
beat conversion, quantization, and symmetric timing judgments use seconds rather than rendered
frames.

Controller-speaker audio is a different boundary from host audio. The host sends a targeted
`speaker.cue` containing only a local cue id, pitch and volume on the disposable realtime channel;
it never streams sound or sends a remote asset URL. Browser Link requires an explicit player action
to move its advertised audio state from `locked` to `ready`, then synthesizes the pulse locally.
Native Link reuses one bundled WAV through Expo Audio and explicitly disables microphone,
recording, background-recording and background-playback permissions. Each controller rejects stale
cue sequences; native Link also prevents an older asynchronous seek from overtaking a newer cue.

## Procedural play

`SeededRandom` guarantees that the same seed produces the same random sequence. `difficultyAt()` combines density, speed, reaction time, simultaneous threats, and modifier chance with explicit safety caps. Each game adds a validator that rejects impossible generated segments before they enter play. BeatForge advances pressure by generated phrase count so denser subdivisions cannot slow their own progression; GravityStack generates bounded shapes/materials before creating physics bodies. `@101/maze` carves reciprocal passages, validates full connectivity, exposes shortest paths and bearings, and lets Echo Maze vary floor size, themes, fragments, hazards, and modifiers without game-specific pathfinding. `@101/swarm` keeps formation assignment deterministic, centers and rotates slots without changing agent identity, and uses a spatial hash for local separation rather than an all-pairs loop. Swarm Commander combines it with a separately seeded wave/terrain director.

## Implementation boundaries

The same-browser controller remains a fast diagnostic transport. Automatic LAN QR pairing adds a local authenticated signaling broker, one WebRTC peer per controller, generation-based reconnect, and a multiplex transport retained across game switches. An authenticated browser reload rotates its origin-local host bearer without changing the controller invitation; an unauthenticated duplicate request receives no authority. The Desktop Hub hands that bearer to the browser only in a session- and loopback-Hub-bound URL fragment; the launcher erases it immediately and rotates it into same-origin storage, so it never enters the query, controller QR, or saved Desktop settings. Sessions and peers are capped, inactive peer leases are reaped or explicitly deleted, and a controller with a still-valid ticket rejoins after that cleanup. Host and controller retain a requested generation reset across a temporary Hub outage instead of publishing or accepting the obsolete generation, and host teardown waits for any reset already in flight. A malformed controller answer drops and resets only that peer, allowing later peers in the same host poll to keep negotiating. The Hub exchanges only offers/answers; gameplay stays on reliable control and disposable realtime DataChannels. At the multiplex boundary, each authenticated peer is assigned a host-canonical route, so a copied controller-local device id cannot overwrite or impersonate another peer's input or targeted feedback. Manual two-way offer/answer transfer remains available when absolutely no signaling service is desired. `@101/hub-server` provides the Node development implementation, while `apps/desktop-hub` implements the same API in Rust and packages it with Tauri. The desktop coordinator advertises through mDNS and owns bounded local settings, replay, and downloaded-package storage.

Realtime WebRTC input uses negotiated `input-q1` in both browser and native Link. Its fixed 24-byte
packet carries protocol/source tags, controller revision, sequence, timestamp and twelve quantized
layout-derived lanes. Digital actions use one byte, analog actions use unsigned 8-bit values, and
axes/vector components use signed 8-bit values. A malformed packet, a packet for an old layout
revision or binary received before negotiation is dropped at the transport boundary; valid JSON
input remains accepted. Frames with unprofiled values—including an old panel's release during a
layout transition—use that JSON path rather than silently omitting controls. The measured benefit is
bandwidth and controller battery use (336 bytes of representative JSON versus 24 bytes quantized),
not latency: serialization and the whole input path were already tiny compared with a 16.7 ms frame.

Link UI is rendered from the targeted `ControllerLayout`: Slashstorm assigns two independent swords, TiltDrift assigns a driver, BodyDodge assigns a movement panel, Orbital Crew uses five ship stations, BeatForge uses one motion performer, GravityStack can split gravity/building across two devices, Spellcaster maps motion gestures to semantic spells, Echo Maze targets private scanner readouts and an optional private pulse to one role, Shadow Arena assigns a combat panel, and Swarm Commander divides vector steering from formation tactics. Echo Maze plays its scan pulse on the host only when the assigned controller cannot accept it, so the same event never intentionally echoes from both devices. Cross-game transitions first release every old action/axis/vector, surplus devices receive explicit standby state, and heartbeat expiry automatically promotes a waiting controller when a role opens.

Vision Lab and camera-enabled games use bundled pose and hand models locally. Face/head tasks and worker-based inference are separate vision work. Browser, native, and desktop targets consume one protocol and controller-layout contract.

Specialist hardware demonstrates that the boundary holds. `@101/hardware` converts a declared byte layout into normalized actions, axes, and vectors, and `@101/adapter-hid`, `@101/adapter-bluetooth`, and `@101/adapter-serial` supply bytes from three unrelated transports. No game imports any of them; a mapped board reaches gameplay as ordinary `InputFrame` data alongside keyboard and gamepad. Watches can therefore add sources the same way, without changing game code.
