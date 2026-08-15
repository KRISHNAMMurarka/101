# Capability negotiation

How 101 answers the question every game asks differently: *what can this player actually play me
with?*

## The contract

Each game ships an `input.manifest.json` next to its `manifest.json`, declaring per control the
sources it was designed around and the ones it will accept instead:

```json
{
  "game": "slashstorm",
  "actions": {
    "slash": {
      "recommended": ["phone-motion", "camera-hand", "mouse"],
      "fallback": ["touch", "gamepad", "keyboard"],
      "description": "Slice through a target using a blade gesture."
    },
    "celebrate": { "recommended": ["camera-pose"], "optional": true }
  }
}
```

`recommended` is preference order, and it is honoured literally. Nothing scores devices behind the
author's back — a game that lists `camera-hand` first means it, and a resolver that silently
reordered would be harder to reason about than one that does as it is told.

`optional` is how a game says a control is an enhancement rather than a requirement. It defaults to
required, because that is the safe reading of a control someone bothered to declare.

## What resolution returns

`resolveInputManifest(manifest, available)` reports four things, not one:

| Field | Meaning |
| --- | --- |
| `mappings` | control → the source that will actually serve it |
| `degraded` | served, but by a `fallback` rather than a `recommended` source |
| `missing` | nothing available can serve it |
| `blocking` | the subset of `missing` the game declared it needs |
| `playable` | `blocking` is empty |

The distinction between `missing` and `blocking` is the whole point. A game with an unserved
optional pose control is not broken; a game with an unserved required control is, and only the
manifest knows which is which.

## What counts as "available"

Two sources, deliberately separate:

- **Local adapters** on the input bus — keyboard, pointer, gamepad, camera, HID, Bluetooth, serial.
- **Paired devices**, via `sessionSources()`. A phone on the LAN registers no adapter on the host,
  so it is only visible through the capabilities it announced when it joined.

**Registration is not availability.** A `GamepadAdapter` is constructed and polling from the moment
a game starts, with or without a controller plugged in. Counting it as an available source told
games their `gamepad` requirement was satisfied on machines with no gamepad. Adapters therefore
expose `available`, and hardware-gated ones report honestly; adapters that are always there
(keyboard, pointer) leave it undefined, which reads as available.

Capability mapping is conservative on purpose: `phone-motion` requires a **gyroscope**, not merely
an accelerometer. Tilt without rotation cannot serve a manifest written for motion, and claiming
otherwise produces a game that starts and then does not respond.

## Why this needed building at all

`resolveInputManifest` shipped a long time ago and had exactly two call sites, both test files.
Every game declared its needs, the suite validated the declarations, and the runtime ignored them.
`GameHost101` — the one component that would have consumed them — had no callers either, because
each game component wires its own `Engine101` and `SessionHost` directly.

So the manifests were documentation that the tests kept honest and the product never read. Two
contract tests now fail if that regresses, since a resolver with no production caller passes every
other test in this repository.

## Using it in a game

```tsx
import { describeReadiness, resolveGameInput } from "@/app/lib/input-readiness";
import GAME_INPUT from "@/games/<id>/input.manifest.json";

const host = new SessionHost({
  // …
  onChange: (snapshot) => setReadiness(resolveGameInput(GAME_INPUT, engine.inputBus, snapshot)),
});
setReadiness(resolveGameInput(GAME_INPUT, engine.inputBus));
```

Recomputing on `onChange` is what makes pairing a phone clear the notice immediately.

## What the player sees

Seven of the ten games printed a fixed `KEYBOARD · GAMEPAD` (Slashstorm printed
`POINTER · TOUCH · GAMEPAD · KEYBOARD`, SwarmCommander added `MOUSE`), claiming a gamepad whether or
not one existed. Every status bar now reports the sources that actually resolved — `KEYBOARD` on a
plain laptop — and adds one actionable line when there is something worth saying.

The line names a **device**, not control names. "aim, slash, trigger have no input" is accurate and
useless; a player can act on "pair a phone". The device is derived from the `recommended` sources of
the controls that did not resolve, so the advice fits the game:

| Game | Notice on a bare laptop |
| --- | --- |
| BodyDodge, ShadowArena, Spellcaster | Playable now. **Enable the camera** for the controls this game was designed around. |
| Slashstorm, TiltDrift, BeatForge, GravityStack, EchoMaze, OrbitalCrew, SwarmCommander | Playable now. **Pair a phone** for the controls this game was designed around. |

Telling a camera game's player to pair a phone would be confidently wrong, which is worse than
saying nothing.

There are three display states for the source list, deliberately distinct. A server render has
measured nothing, so it prints `DETECTING INPUT` — printing `NO INPUT` there would swap one false
claim for another. `NO INPUT` is reserved for measured-and-genuinely-empty.

## What this found in the shipped manifests

BodyDodge declared its body pose as `"fallback": []` with the description *"Optional flattened
33-point body pose"*. The prose said optional; the schema had no way to express it. Resolution
therefore did the correct thing with the information available — treated it as required and reported
the game unplayable on a laptop, which it plainly is not.

The manifest now declares `optional: true` and says why. A test resolves every shipped game against
a keyboard-only setup and fails if any is blocked, so the next manifest that says one thing in prose
and another in schema is caught immediately.

## The app runs on its own SDK

Three layers used to ship with no callers at all. `resolveInputManifest` was reachable only from
tests, `defineGamePackage` from nothing, and `GameHost101` from nothing — while all ten game
components hand-assembled an `Engine101`, a `LocalSession` and a `SessionHost` themselves. The path a
third-party developer is told to build on was the one path nothing exercised.

Every game now goes through `useGameHost`, which owns transport, session, adapters, engine, readiness
and teardown:

```tsx
const { linked, readiness } = useGameHost<SlashstormState>({
  sessionId,
  deps: [run],
  build: () => defineGamePackage({ manifest, input, controllers: ROLES, game: createGame(seed) }),
  adapters: () => [new KeyboardAdapter(), new PointerAdapter(canvas), new GamepadAdapter()],
  onReady: ({ context }) => { /* views, draw loop, HUD timers */ return () => { /* teardown */ }; },
});
```

Ten copies of the same twenty lines became one, and the net change was **737 lines deleted against
662 added**. `GameHost101` also delegates `haptic` and `sendControllerState` rather than making games
reach through `host.session` for them — a half-façade is its own kind of duplication.

## Readiness does not wait for the network

Whether a game is playable on this machine is answerable from the local adapters alone, so the first
reading is taken the moment they register — before the transport connects. It used to be computed
only after `connect()` resolved, which on a memory transport is a tick and on a slow LAN is seconds
of a status bar reading `DETECTING INPUT` while the answer was already known.

Measured against a transport that takes 600 ms to connect, the first reading now arrives at 0 ms.
Unchanged readings are not re-announced, so device liveness beats do not re-render every subscriber.

Setting the active package before connecting means a failed launch could leave a game advertised
with no engine behind it, so `launch` clears both the package and its readiness if the transport
throws. A test covers that path.

## What dogfooding the SDK immediately caught

`defineGamePackage` validates that a controller role only references controls the input manifest
declares. The moment a real game ran through it, TiltDrift threw:

```text
Error: Controller role driver uses undeclared steer
```

**The game was right and the validator was wrong.** TiltDrift renders a `steer` wheel and reads
`input.axis("steer")`; `ControllerInputModel.setVector` writes `axes[action] = vector.x` alongside
`axes[actionX]` and `axes[actionY]`, so a pad legitimately satisfies an axis declaration. The
validator did not know about that aliasing and demanded a vector declaration the runtime never
required. The repository's own contract test had always treated axes and vectors as interchangeable
here, so the two disagreed and only the lax one ever ran.

This is the expensive kind of bug: the validation is the gate every third-party package passes
through, so an over-strict rule there refuses correct games rather than catching broken ones — and
nothing would have revealed it until an outside developer hit it. A test now runs all ten games
through `defineGamePackage`; reverting the fix fails it with the exact error above.

## Known gaps

- The notice is advisory only. Nothing yet refuses to start a genuinely blocked game, because no
  shipped game is blocked on a keyboard; the `playable` flag exists for when one is.
- Readiness for a *paired* device still cannot be known before that device joins, which is inherent:
  the host learns what a phone offers from the `hello` it sends.
