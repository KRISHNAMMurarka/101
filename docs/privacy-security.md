# Privacy and security

## Pairing data

Automatic pairing uses the local `101 Hub` only to exchange short-lived WebRTC offers and answers. Gameplay input is not intentionally relayed through the Hub. QR tickets contain a LAN endpoint, random join secret, session ID, protocol version, and expiry; they contain no account or player identity. Host, join, and peer authorization secrets are distinct, and targeted controller state is routed only to its registered peer transport.

Treat a pairing QR like a temporary invitation to the room: show it only to intended local players and close/recreate the session if it is exposed. Tickets expire automatically.

The 101 Link service worker never caches requests whose URL contains a pairing ticket. It caches only the neutral controller shell and runtime assets. Installed standalone mode stores a random local device ID; it does not store an account identity.

Native 101 Link stores only its random device ID and optional last local pairing ticket in the platform secure store. QR camera access is requested only when **Scan QR** is selected. Motion permission is requested only when a motion layout is active and the user selects **Enable Motion**. The native configuration removes Android audio recording permission and contains no iOS microphone usage description. The app does not record camera, audio, or sensor history and has no telemetry SDK.

Desktop 101 Hub stores settings, explicitly saved replay data, and imported game packages only in its OS application-data directory. It has no account or telemetry client. LAN advertisement can be disabled. Signaling state and its bearer secrets remain in memory; the Hub does not persist offers, answers, pairing invitations, or controller sensor frames.

## Defaults

- No account is required.
- No analytics or telemetry is enabled.
- No recording is enabled.
- No camera, microphone, or motion permission is requested before a selected controller role needs it.
- Raw camera frames remain local; normal network payloads contain only landmarks, gestures, or normalized actions.
- Face landmarks may control a game but are never used to identify a person.
- Health data is outside normal game operation.

## Permission copy

Permission screens should name the capability and the immediate purpose:

- **Camera:** Control this game using your hands or body. Video is processed on this device and is not recorded.
- **Motion sensors:** Use this phone as a steering wheel or motion controller.
- **Microphone:** Detect sound for this optional mode. Audio is processed locally and is not recorded.

Denial must return the user to a conventional fallback mapping.

The browser Motion Lab and Link implementation follow this rule today: sensor listeners live in `@101/adapter-motion`, permission follows a user gesture, calibration/filtering occurs locally, and only compact normalized frames are offered to a connected host. The Motion Lab does not connect or transmit samples.

Vision Lab, BodyDodge, Spellcaster, Shadow Arena, and Swarm Commander follow the same boundary. `@101/adapter-camera` requests video only after the user selects a camera mode, explicitly requests no audio, runs the bundled pose or hand model in the browser, and stops media tracks on teardown. Raw frames are neither recorded nor sent to the Input Bus; only landmarks and derived actions are accepted. Camera denial leaves the conventional controls active.

BeatForge reuses that exact optional camera boundary for movement controls. It does not request microphone access, and its included rhythm cues are generated offline by `@101/audio`. GravityStack requests no media capability; phone tilt arrives only as a normalized gravity vector after the controller user explicitly enables motion. Echo Maze also makes no microphone request: its assigned companion receives only tiny, targeted clue/status messages and normalized controls.

Specialist hardware follows the same lazy, explicit boundary. `@101/adapter-hid`, `@101/adapter-bluetooth`, and `@101/adapter-serial` never enumerate or scan for devices in the background: the browser's own chooser, opened from a click, is the permission boundary, and each adapter constrains that chooser with its declared filters. Web Bluetooth connects to exactly one declared service and characteristic rather than requesting broad GATT access. Devices already granted in a previous visit are matched through `getDevices()`/`getPorts()` so reconnect needs no new prompt and grants no new access. Only decoded numeric actions, axes, and vectors enter the Input Bus — never device serial numbers or raw descriptors — and the Hardware Lab reports unsupported APIs plainly instead of presenting controls that silently do nothing.

Native 101 Link blocks health permissions its own sensor library would otherwise contribute. `expo-sensors` bundles a pedometer, so `ACTIVITY_RECOGNITION` arrives through Android manifest merging even though 101 reads only accelerometer, gyroscope, magnetometer, and device motion. That permission and `BODY_SENSORS` are blocked explicitly, a test keeps them blocked, and the built APK was verified to declare neither. The watch bridge adds no permission of its own: Watch Connectivity and the Wearable Data Layer need none.

Watch companions collect wrist movement and nothing else. The watchOS app never imports HealthKit and requests no health authorization; the Wear OS app declares no `BODY_SENSORS`, `ACTIVITY_RECOGNITION`, `RECORD_AUDIO`, `CAMERA` or location permission, and its built APK is verified to declare zero permissions. Emitted frames carry motion quantities only — no wearer identity, serial numbers, or heart rate — and a test asserts that no frame key contains health or identity terms. Because the Wear OS Data Layer may route over the network rather than Bluetooth, `@101/adapter-watch` reports `verified-local` only when the OS confirms a nearby node and `cloud-possible` otherwise, so a strict-local promise is never made on an unproven route. See [watch companions](watches.md).

## Dependency security

`npm run audit:production` is the release gate. A plain `npm audit --omit=dev` cannot tell code that ships to a player from build tooling that only runs on a developer machine, because Expo declares its CLI, Metro bundler and Xcode project tooling as production dependencies of the native app. Deleting the check would hide real risk; leaving it permanently red would train everyone to ignore it.

The gate therefore separates root-cause advisories from the "depends on a vulnerable package" entries that resolve with them, and requires every root cause to be individually reviewed in [`security/build-tooling-advisories.json`](../security/build-tooling-advisories.json) with its dependency path, a justification, whether the vulnerable code path is actually reachable, and an expiry date. It fails on anything unreviewed, any review past its date, and any allowlist entry that no longer matches a reported advisory. A new advisory can never be absorbed silently, and an accepted one cannot be forgotten.

Only `surface: "build-tooling"` may be accepted. Anything reaching the web runtime or the shipped iOS/Android bundle must be fixed, not reviewed. The player-facing runtime dependencies — Phaser, Three.js, Rapier, Howler, React, MediaPipe tasks-vision and the QR encoder — currently carry no advisories.

## Local network security

Pairing codes are discovery aids, not long-term authentication secrets. WebRTC sessions should use ephemeral keys, display both devices during confirmation, expire offers, and reject protocol-version mismatches. The Hub must bind only to intended interfaces and clearly show which network transport is active.

Manual offline pairing data can be transferred by QR or code, but must be size-limited and strictly validated before use.

This repository contains no active OpenAI Sites project metadata or packaging plugin. Publishing/deployment requires a separate explicit user action and configuration.

Browser Link role messages are addressed to a concrete device. The controller ignores layouts, live state, and haptics meant for other devices. The session host rejects realtime frames from unassigned device IDs and replaces client-claimed player identity with the authoritative role assignment before forwarding input. This is an isolation boundary for local party play, not a substitute for future authenticated Hub pairing.

## Untrusted game packages

The desktop package importer requires a valid offline/procedural 101 manifest, rejects symbolic links and traversal, bounds file count and total size, and copies content into a dedicated package directory before serving it. Imported content receives no native filesystem or sensor authority. Cryptographic publisher signatures and a sandboxed downloaded-code execution policy are still required before the launcher may execute untrusted packages automatically; storage/serving alone is not execution approval. A game manifest cannot grant itself sensor or filesystem access.

## Reporting

See [SECURITY.md](../SECURITY.md) for responsible vulnerability reporting. Do not include personal data, access tokens, private recordings, or production pairing payloads in a report.
