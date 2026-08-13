# Privacy and security

## Pairing data

Automatic pairing uses the local `101 Hub` only to exchange short-lived WebRTC offers and answers. Gameplay input is not intentionally relayed through the Hub. QR tickets contain a LAN endpoint, random join secret, session ID, protocol version, and expiry; they contain no account or player identity. Host, join, and peer authorization secrets are distinct, and targeted controller state is routed only to its registered peer transport.

Treat a pairing QR like a temporary invitation to the room: show it only to intended local players and close/recreate the session if it is exposed. Tickets expire automatically.

The 101 Link service worker never caches requests whose URL contains a pairing ticket. It caches only the neutral controller shell and runtime assets. Installed standalone mode stores a random local device ID; it does not store an account identity.

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

## Local network security

Pairing codes are discovery aids, not long-term authentication secrets. WebRTC sessions should use ephemeral keys, display both devices during confirmation, expire offers, and reject protocol-version mismatches. The Hub must bind only to intended interfaces and clearly show which network transport is active.

Manual offline pairing data can be transferred by QR or code, but must be size-limited and strictly validated before use.

This repository contains no active OpenAI Sites project metadata or packaging plugin. Publishing/deployment requires a separate explicit user action and configuration.

Browser Link role messages are addressed to a concrete device. The controller ignores layouts, live state, and haptics meant for other devices. The session host rejects realtime frames from unassigned device IDs and replaces client-claimed player identity with the authoritative role assignment before forwarding input. This is an isolation boundary for local party play, not a substitute for future authenticated Hub pairing.

## Untrusted game packages

Downloaded games will eventually require signed manifests, declared capabilities, version compatibility checks, content security boundaries, and user confirmation for new permissions. A game manifest cannot grant itself sensor or filesystem access.

## Reporting

See [SECURITY.md](../SECURITY.md) for responsible vulnerability reporting. Do not include personal data, access tokens, private recordings, or production pairing payloads in a report.
