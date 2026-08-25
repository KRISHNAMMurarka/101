# 101 Hub desktop application

`apps/desktop-hub` is a self-contained Tauri 2 application. Its Rust process starts the local session coordinator automatically; a packaged build does not need Node.js to keep the Hub online.

## Responsibilities

- bind the authenticated protocol-v2 signaling API to the configured local port;
- report reachable IPv4 LAN interfaces;
- advertise `_oneohone._tcp.local.` through mDNS/DNS-SD when enabled;
- issue expiring tickets with independent join, host, and peer secrets;
- maintain connected peers and reconnect generations without relaying gameplay frames;
- store Hub settings, deterministic replay JSON, and downloaded game packages under the OS application-data directory;
- validate and copy developer game packages without following symbolic links;
- serve installed package assets from `/games/{gameId}/...` with path-containment and size checks;
- open the separately running browser launcher at the user-configured local URL.

When the dashboard creates an invitation, **Open this session** adds the selected session and loopback Hub endpoint to the launcher query. Its one-time host authority travels separately in a session- and Hub-bound URL fragment. The browser removes that fragment immediately, claims and rotates the authority into same-origin storage, then begins WebRTC offer generation. The bearer never enters the query, controller QR, saved Desktop settings, or browser history, and a controller may scan before or after the game screen opens.

The desktop dashboard calls the same `@101/protocol` ticket encoder as the web and native clients. There is no desktop-only pairing format.

## Development

Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for the target OS, then run:

```bash
npm install
npm run desktop:dev
```

Verification:

```bash
npm run desktop:check
npm run desktop:test
npm run desktop:app
```

`desktop:app` produces the platform application bundle without creating a public release. `desktop:build` produces all installer targets configured for the current OS. Distribution signing and notarization remain platform-owner operations; the source does not embed signing credentials.

## HTTP contract

The Rust server matches `@101/hub-server`:

- `GET /v1/health`
- `POST /v1/sessions`
- authenticated host peer list, offer, and reconnect routes;
- authenticated controller join, leave, offer, answer, and reconnect routes;
- `GET /v1/games`
- `GET /games/{gameId}/{asset}`

Request bodies are capped, session and device identifiers are validated, pairing descriptions are bounded, invitation lifetimes are clamped, live session/peer counts are capped, inactive peers and expired sessions are reaped, and authorization tokens are compared in constant time. Repeating session creation without the current host bearer returns no authority; authenticated reload rotates that bearer while preserving the controller invitation. A malformed answer is isolated to its peer and cannot prevent later peers from receiving offers. The Hub permits CORS because browser launchers on the same LAN use a different local origin; all state-changing signaling routes after initial invitation creation require an ephemeral bearer secret.

The zero-configuration listener is a trusted-private-LAN feature, not a hostile-network protocol. It uses HTTP, so another device able to observe or modify LAN traffic can capture signaling bearers or SDP despite the route-level authorization checks. Account-free session creation can also consume the bounded global pool. Use an isolated/private network (or manual offline pairing) rather than public Wi-Fi, and bind/advertise the Hub only on interfaces intended for play.

## Local storage

The dashboard shows the exact application-data path. Settings are written atomically. Replays are limited to 16 MB each. Imported game packages are limited to 250 MB and 20,000 files, reject symbolic links, and require the 101 offline/procedural manifest fields. Importing stores content; it does not grant filesystem, sensor, camera, microphone, or native-code authority to the game.
