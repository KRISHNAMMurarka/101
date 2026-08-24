# 101 — what is left to build

Written 2026-08-16. Every item below was verified against the source on that date, not inferred.
Where something is unverified or environment-limited it says so.

---

## Prompt for the next agent

> You are working on **Project 101**, a local-first, browser-first gaming platform at
> `/Users/km/Desktop/games/101` where "anything can be a controller". It is a npm-workspace monorepo
> (`apps/*`, `packages/*`, `games/*`), TypeScript strict, tests run on Node with
> `--experimental-strip-types`.
>
> Read `README.md`, then `docs/architecture.md`, `docs/capability-negotiation.md` and
> `docs/offline-cache.md` before changing anything. Work through the task list in `HANDOFF.md`,
> highest priority first, and treat each task's "Verify" line as the definition of done.
>
> **House rules, learned the hard way — do not skip these:**
>
> 1. **Verify at runtime, not by reading.** This codebase repeatedly passed every test while doing
>    nothing: three SDK layers shipped with no caller, seven status bars claimed a gamepad that was
>    not plugged in, and a game's controls silently did nothing because a manifest was never read.
>    Build it, serve it, and look at the running thing.
> 2. **Every new test must fail without its fix.** Break the fix, watch the test go red, restore it.
>    A test that passes both ways is decoration.
> 3. **`npm run dev` / `npm start` refuse to run if the port is taken.** That guard exists because a
>    different project on this machine bound `[::1]:3000` while 101 bound `*:3000`, and every
>    `localhost:3000` request went to the other app for hours. If you see "Refusing to start", read
>    the pid it names. Use `PORT=3001 npm start`.
> 4. **The site is monochrome; the games are not.** Black, white and greys for anything that frames
>    the product — launcher, controller, labs, HUD panels, buttons. Game play fields keep their
>    colour. State is expressed by weight and edge, never by hue. A test enforces both halves.
> 5. **Never publish or deploy anywhere.** Local work plus commits to the private GitHub repo
>    `KRISHNAMMurarka/101` only.
> 6. **Pushing:** if `git push` fails with "Repository not found", the `gh` active account has
>    reverted to `edilec`. Run `gh auth switch --user KRISHNAMMurarka` and push again. The repo is
>    private, so GitHub 404s rather than 403s.
>
> **The gate that must be green before any commit:**
> ```
> npm run typecheck && npm run native:typecheck && npm run lint && npm test && npm run audit:production
> ```
> `npm test` runs 155 unit tests plus 17 server-rendered route checks.

---

## Priority 1 — bugs with a player-visible effect

### 1.1 A muted tab silences every game that follows
`packages/audio/src/index.ts:96` — `applyMuteState()` calls `Howler.mute(...)`, which is **global and
static**. `unload()` (line 89) clears the sounds and removes the visibilitychange listener but never
restores the flag. Unload a game while the tab is hidden or manually muted and the next game starts
silent, with nothing in its own state explaining why.

**Fix:** `unload()` must release the global mute it took. Consider whether `Audio101` should own a
process-wide flag at all, given two instances can exist during a game transition.
**Verify:** hide the tab, unload a game, restore the tab, start another game, confirm audio plays.

### 1.2 Rhythm cues ride the frame rate, not an audio clock
`app/components/BeatForgeGame.tsx:70-82` — beat and accent sounds fire from inside the
`requestAnimationFrame` render loop, gated on `state.elapsed`. Frame jitter therefore becomes audible
timing jitter, which is precisely what a rhythm game cannot afford.

**Fix:** schedule cues against `AudioContext.currentTime` with lookahead, independent of rendering.
**Verify:** throttle the frame rate (CPU throttling in devtools) and confirm the beat stays steady.

### 1.3 Haptics arrive late rather than not at all
`packages/session/src/index.ts:325` — `haptic()` uses `sendReliable`, an ordered retransmitting
channel. A dropped packet produces a buzz that lands after the moment it described. For feedback tied
to an instant, late is worse than absent.

**Fix:** send haptics on the realtime (unordered, zero-retransmit) channel, as input frames already
are.
**Verify:** a test asserting the haptic message takes the realtime path; ideally confirm on a phone
over a lossy link.

---

## Priority 2 — the controller cannot express a real gamepad

The layout schema in `packages/protocol/src/index.ts` supports exactly five element types:
`button`, `dpad`, `joystick`, `slider`, `touch-surface`. Verified by enumeration.

### 2.1 No shoulder or trigger, and no analog button
A pressure-sensitive trigger cannot be expressed, even though the pipeline already carries analog
values — `ControllerActions.action(name, value: boolean | number)` accepts a number today.

### 2.2 No placement or handedness hints
Verified: zero occurrences of `side`, `zone` or `handedness` in the protocol. A game can say *what* a
control is but never *where* it belongs, so the controller guesses. Suggested additions, all optional
and advisory so the renderer may still reflow: `side` (left/right/center), `zone`
(thumb/shoulder/index/edge), `size`, `span`, `priority`, plus a top-level `handedness` the player can
override.

### 2.3 No hold, double-tap, toggle or chord semantics
Every game re-implements them, or does without. These belong in the controller, next to the existing
gesture recognition.

### 2.4 Sticks have no dead zone, sensitivity curve or radial clamp
`apps/controller-native/src/controls.tsx` clamps each axis independently, so a diagonal reaches ~1.41×
the magnitude of a cardinal. Add per-stick dead zone and response curve to the schema.

**Verify for all of 2.x:** extend `schemas/controller-layout.schema.json`, render the new elements in
both `apps/controller-native/src/controls.tsx` and `app/controller/Controller.tsx`, and confirm the
native and web controllers agree — there is a contract test for layout parity.

---

## Priority 3 — the catalog assumes a handful of games

`app/Launcher.tsx:180` renders `catalog.map(...)` over every entry. Verified: **no search, no filter,
no pagination, no virtualisation.** Lazy loading was fixed (homepage JS is flat at ~462 KB regardless
of catalog size), but the *grid* is still linear.

**Build:** search, filtering by input requirement (e.g. "works with just a keyboard" — the data for
this already exists via `resolveInputManifest`), and windowed rendering.
**Verify:** generate 1000 synthetic manifests, load the launcher, confirm interaction stays smooth
and first paint does not regress.

---

## Priority 4 — features from the original brief, never started

### 4.1 Audio out to the controller's own speaker
Requested and never built. `packages/audio` is host-only; the protocol has no message for playing a
cue on a paired device. Design decisions needed: latency versus the TV's own audio, echo when both
sound at once, and whether it is per-role private audio (a clue only one player hears) — which is the
genuinely novel use, and fits Echo Maze's existing private-clue channel.

### 4.2 Binary realtime wire format
Measured this session: an `InputFrame` is **336 bytes of JSON**; a quantized binary form is **24
bytes**. At 60 Hz × 4 controllers that is 645 kbit/s versus 46 kbit/s.

**Read this before starting:** it is *not* a latency fix. Serialization costs ~2 µs against a 16.7 ms
frame budget, and the whole input path measured 0.002–0.005 ms per frame. Do it for bandwidth,
battery and weak wifi — not for lag. `packages/protocol` already has `encodeMotionPacket` and a
48-byte layout to build on, and `packages/adapter-watch` has a working 53-byte binary payload as
precedent.

---

## Known limits — do not treat these as bugs

- **Emulators cannot complete WebRTC.** Android and iOS simulators cannot finish ICE through their
  NAT. Signalling, offer/answer and gathering all succeed; connectivity does not. Confirming a full
  pair needs a real phone on the LAN.
- **The watchOS app target must be created and signed in Xcode.** An Apple requirement; no repository
  can do it for you. Neither watch app has run on physical hardware.
- **The build is byte-reproducible and must stay that way.** `next.config.ts` pins `deploymentId` and
  `generateBuildId` to a hash of the source. Removing either makes every release evict every user's
  cache and makes builds unverifiable. A test guards it.

## Unverified on hardware

- **Two-thumb play.** The fix for the React Native single-responder bug is reasoned from RN's source
  and locked by a test, but simulators synthesise only mirrored pinch, not two independent touch
  points. Needs one pass on a real phone: hold a stick, press a button, confirm the stick holds.
