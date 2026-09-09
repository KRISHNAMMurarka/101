# 101

101 is a gaming system that lets a keyboard, phone, gamepad, camera, or supported sensor drive the same game controls. Games ask for actions such as `move`, `jump`, or `slash`; input adapters handle the device details.

The repository contains playable games, the browser launcher and 101 Link controller, a local session Hub, native phone/watch projects, and a shared game SDK. The shipped games run in the browser. Hosted and streamed titles can now describe their launch and input endpoints; a remote runtime and additional game screens are not implemented. See [routing decisions](docs/DEVICE-ROUTING.md).

## Start locally

Use Node.js 22.13 or later. From this directory:

```sh
npm ci
npm run dev
```

Open the local address printed by the server, choose a game, and choose how to play. Every shipped game has conventional controls. Camera setup requests permission only after a click. **Show controls** opens a controller dock on the game's own screen.

Developer tools live at `/studio`: input, motion, camera, pairing, controller layout, hardware, and catalog checks. The player library remains separate.

For a phone on the same network, build and run the local pairing helper:

```sh
npm run build
npm run phone
```

It prints the LAN address and starts the web runtime and Hub. Open that address on the phone and choose **Connect device** on the game screen. This is local testing; this repository must not be published or deployed without a separate owner instruction.

## Verify a change

Read [AGENTS.md](AGENTS.md) first. Build the current source so route tests do not inspect stale output, then run all four commit gates:

```sh
npm run build
npx tsc --noEmit
npm run lint
npm run test:unit
node --test tests/rendered-html.test.mjs
```

The unit runner discovers `*.test.ts` under the application, games, packages, native apps, and tests. Node's type stripping does not compile TSX; extract testable logic into ordinary TypeScript and use rendered/browser checks for components. Bug fixes require evidence that the previous code fails.

The suite covers the real input bus, camera-to-game paths with fake streams, two-person tracking, keyboard-to-game behavior, controller transitions, transport version mismatches, offline cache upgrades, and compressed bundle budgets. Synthetic camera tests do not certify physical cameras, phones, or accessibility software. The current evidence and gaps are in [QA results](docs/QA-2026-09-09.md), [vision validation](docs/VISION-VALIDATION.md), and [release acceptance](docs/RELEASE-ACCEPTANCE.md).

## How the code fits together

```text
Game package: manifest + semantic controls + lifecycle + controller roles
                           ↓
             GameHost101 / Engine101 / SessionHost
                           ↓
          InputBus: actions · axes · vectors · poses
                           ↑
       device adapters and authenticated Link transport
```

| Location | Responsibility |
| --- | --- |
| `games/` | Game manifests, simulation rules, directors, and role definitions |
| `app/` | Launcher, chooser, game views, controller, and shared UI |
| `app/studio/` | Diagnostics and development tools |
| `packages/sdk`, `game-registry`, `game-host`, `core` | Package validation, catalog, composition, and game lifecycle |
| `packages/input`, `adapter-*`, `hardware` | Device-independent controls and device access |
| `packages/protocol`, `pairing`, `session`, `hub-server` | Wire formats, local pairing, identity, roles, and reconnect |
| `packages/vision`, `motion` | Local body/hand interpretation and motion filtering |
| `packages/render-*`, `physics`, `audio` | Rendering, simulation, and sound boundaries |
| `apps/` | Native phone, desktop Hub, and watch projects |
| `schemas/`, `tools/`, `tests/` | Public contracts, local tooling, and integration checks |

Games never import browser device APIs. A component mounts one host; the phone controller and on-screen dock feed that host's existing InputBus. A second game view requires a separate view/snapshot contract, described in the routing document.

## Add a game

```sh
npm run create:game -- my-game "My Game" 2d
```

The launcher discovers manifests at build time. Declare inputs and optional controller roles in the package instead of adding game-id branches to shared UI. Keep game mechanics in `games/` and browser rendering in the view layer. See [game development](docs/game-development.md), [adapter development](docs/adapter-development.md), and the [external package example](examples/external-game/README.md).

The product chrome is monochrome and supports both color schemes. Game canvases may use color. Player instructions explain what to do; model names, raw errors, and diagnostic measurements belong in Studio.

## Native targets and deeper documentation

Native builds use separate toolchains and are not certified by the web gate. Their local build/test commands remain in `package.json` and their guides:

- [Native phone controller](docs/native-link.md), [desktop Hub](docs/desktop-hub.md), [watch companions](docs/watches.md)
- [Architecture](docs/architecture.md), [capabilities](docs/capability-negotiation.md), [protocol](docs/PROTOCOL.md), [pairing](docs/controller-pairing.md)
- [Vision](docs/vision.md), [specialist hardware](docs/hardware.md), [offline controller cache](docs/offline-cache.md)
- [Privacy and security](docs/privacy-security.md), [previous emulator evidence](docs/emulator-qa.md)
- [Backlog disposition](docs/NEXT-101-STATUS.md), [release acceptance](docs/RELEASE-ACCEPTANCE.md)

Camera images are processed on the device and are not recorded. There is no runtime model CDN. Pairing secrets are excluded from the offline cache. Face-camera capture is not offered: no face model or game integration is shipped.

101-authored source uses the [MIT License](LICENSE). Dependency licenses remain in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the generated license inventories.
