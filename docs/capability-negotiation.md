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

## Known gaps

- `GameHost101` computes readiness and exposes `onInputReadiness`, but nothing in the app uses
  `GameHost101` — each game component wires its own `Engine101` and `SessionHost` — so that path is
  still unexercised outside tests. The duplication across ten components is the real thing to fix.
- Camera capability maps to all three camera sources at once. A device that can see a hand is
  assumed able to see a pose, which is true of the current adapters but is an assumption.
- The notice is advisory only. Nothing yet refuses to start a genuinely blocked game, because no
  shipped game is blocked on a keyboard; the `playable` flag exists for when one is.
