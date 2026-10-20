# 101 Games

101 is a collection of games controlled with a keyboard, phone, gamepad or camera. Games receive actions such as move, jump and slash from a mapping layer. Device discovery, acquisition, permissions, connections and native agents belong to [Uynis Connect](../uynis-connect/README.md).

This repository owns the ten playable games, game SDK and host, rendering and physics, launcher, browser Link controller and console receiver. The approved ownership map and history-preserving move are in [BOUNDARY.md](docs/platform/BOUNDARY.md); current execution evidence is in [MOVE-STATUS.md](docs/platform/MOVE-STATUS.md). Earlier combined-platform acceptance records retain their original scope and do not certify either new product.

## Start locally

Keep the two repositories next to each other. Build the platform first:

```sh
cd ../uynis-connect
npm ci
npm run build
cd ../101
npm ci
npm run dev
```

Use Node.js 24 or later. The development dependency is `@uynis-connect/connect` at `file:../uynis-connect/sdk/connect`. It exposes the platform's compiled public package; games do not import adapter or transport implementations. Rebuild the SDK after changing it. A versioned package will replace the local link later.

Open the address printed by the server and choose a game. All shipped games have conventional controls. Camera setup requests permission after a click. **Show controls** opens the game's controller dock. The build copies checksummed model/runtime assets supplied by the SDK into generated `public/connect-assets/`; it does not download models at runtime.

Games developer tools at `/studio` cover input, controller layout and the catalog. Device and connection routes redirect to the Connect console, whose default port is 3001. Set `NEXT_PUBLIC_CONNECT_CONSOLE_URL` before building to use another console origin; run `npm start` in Connect to serve it.

For local phone testing, build Games and run `npm run phone`. The helper starts the game web server and the platform's Hub CLI and prints the LAN address. Pair through the game's full connection link and explicit review. Physical-phone and target-OS qualification remain separate from browser checks.

## Verify a change

Read [AGENTS.md](AGENTS.md), build the current source, and run:

```sh
npm run build
npx tsc --noEmit
npm run lint
npm run test:unit
node --test tests/rendered-html.test.mjs
```

The bounded unit runner discovers source tests under app, apps, games, packages and tests. Browser journeys use real game rendering. Software device fixtures and synthetic camera inference do not qualify physical devices. Existing release gates remain open until their own evidence is complete.

## Code ownership

| Location | Responsibility |
| --- | --- |
| `games/` | Manifests, simulation rules, procedural content and controller roles |
| `app/` | Launcher, chooser, game views, browser controller and presentation |
| `packages/input` | Device observations mapped to semantic game actions and scoped input contributions |
| `packages/game-host`, `core`, `sdk`, `game-registry` | Game lifecycle, assignments, package validation and catalog |
| `packages/link-controller` | Game layouts, presets and application payload interpretation |
| `packages/render-*`, `physics`, `maze`, `rhythm`, `swarm` | Game rendering and simulation |
| `apps/console-receiver` | Game receiver using the public platform SDK |
| `../uynis-connect` | Device SDK, adapters, transports, processors, service host, console and native agents |

Input flows from the platform SDK through the game mapping layer into the game host. Source loss, disconnect and close retire the corresponding game contributions. Game rules never call device adapters or transports.

## Add a game

```sh
npm run create:game -- my-game "My Game" 2d
```

The launcher discovers manifests. Declare inputs and roles instead of adding game-ID branches to shared UI. See [game development](docs/game-development.md) and the [external game example](examples/external-game/README.md). Product chrome is monochrome; game canvases may use colour. Player instructions explain what to do, while diagnostics belong in Studio.

Source uses the [MIT License](LICENSE). Dependency notices and licences are retained in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the generated inventories. No publication or target qualification is implied by a local build.
