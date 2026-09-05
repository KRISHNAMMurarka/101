# 101 — completed handoff record and remaining hardware checks

Written 2026-08-16 and completed 2026-08-26. The original diagnoses remain below so the reason for
each change is not lost. Priorities 1–4 are complete; the only remaining checks in this file require
physical hardware and are listed at the end.

## Completion summary

| Priority | Result | Evidence |
| --- | --- | --- |
| P1 | Complete in `9967fcb` | Audio mute ownership is released on unload, BeatForge cues run on an audio-clock lookahead, and haptics use realtime. Regression tests went red against the old paths; the built browser was checked across unload/visibility and frame throttling. |
| P2 | Complete in `5cef6f0` | Browser and native Link render the expanded layout contract and share gesture/stick normalization. Contract, gameplay and native tests cover parity; production browser and native exports were inspected. Independent two-thumb hardware remains unverified below. |
| P3 | Complete in `b3804e7` | A real 1,000-entry catalog route was built and served. Search, empty/reset, keyboard-only filtering, paging/focus continuation and 390/900/1440 px layouts were exercised; only 4/8/12 cards rendered initially with 1/2/3 columns and no horizontal overflow. |
| P4 | Complete | Targeted local controller cues and negotiated 24-byte `input-q1` frames run through browser and native WebRTC. Unit/contract tests cover negotiation, fallback, quantization, routing and stale/malformed drops. In the final production build, two browser tabs paired through the real LAN Hub/WebRTC path; a held scan emitted three 24-byte frames and no JSON, started one controller cue and zero host cues, remained linked beyond the heartbeat window, and logged no browser error. Both final native Expo exports were inspected. Audible real-phone playback remains a hardware check below. |

---

## Prompt for the next agent

> You are working on **Project 101**, a local-first, browser-first gaming platform at
> `/Users/km/Desktop/games/101` where "anything can be a controller". It is a npm-workspace monorepo
> (`apps/*`, `packages/*`, `games/*`), TypeScript strict, tests run on Node with
> `--experimental-strip-types`.
>
> Read `README.md`, then `docs/architecture.md`, `docs/capability-negotiation.md` and
> `docs/offline-cache.md` before changing anything. Priorities 1–4 in this file are a completed build
> record, not an open task list. Work only on the physical-hardware checks at the end unless a new
> task explicitly supersedes this handoff.
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
> `npm test` runs the unit suite plus production-build and server-rendered route checks; do not pin
> this note to a test count, because every completed priority below added coverage.

---

## Priority 1 — bugs with a player-visible effect — complete (`9967fcb`)

### [x] 1.1 A muted tab silences every game that follows
`packages/audio/src/index.ts:96` — `applyMuteState()` calls `Howler.mute(...)`, which is **global and
static**. `unload()` (line 89) clears the sounds and removes the visibilitychange listener but never
restores the flag. Unload a game while the tab is hidden or manually muted and the next game starts
silent, with nothing in its own state explaining why.

**Fix:** `unload()` must release the global mute it took. Consider whether `Audio101` should own a
process-wide flag at all, given two instances can exist during a game transition.
**Verify:** hide the tab, unload a game, restore the tab, start another game, confirm audio plays.

**Completed:** manual and visibility mute state is scoped to each instance's owned Howls; `Audio101`
no longer writes the process-wide `Howler.mute` flag at all. Tests cover hidden/manual mute
transitions, overlapping instances and the next-instance regression; the built browser was exercised
through the visibility/unload sequence.

### [x] 1.2 Rhythm cues ride the frame rate, not an audio clock
`app/components/BeatForgeGame.tsx:70-82` — beat and accent sounds fire from inside the
`requestAnimationFrame` render loop, gated on `state.elapsed`. Frame jitter therefore becomes audible
timing jitter, which is precisely what a rhythm game cannot afford.

**Fix:** schedule cues against `AudioContext.currentTime` with lookahead, independent of rendering.
**Verify:** throttle the frame rate (CPU throttling in devtools) and confirm the beat stays steady.

**Completed:** BeatForge now feeds a lookahead scheduler tied to `AudioContext.currentTime`; rAF only
observes game state. Timeline and cue-scheduler tests cover late frames, accents, pause/resume and
deduplication, and the production game stayed on-clock under frame throttling.

### [x] 1.3 Haptics arrive late rather than not at all
`packages/session/src/index.ts:325` — `haptic()` uses `sendReliable`, an ordered retransmitting
channel. A dropped packet produces a buzz that lands after the moment it described. For feedback tied
to an instant, late is worse than absent.

**Fix:** send haptics on the realtime (unordered, zero-retransmit) channel, as input frames already
are.
**Verify:** a test asserting the haptic message takes the realtime path; ideally confirm on a phone
over a lossy link.

**Completed:** the session sends targeted haptics through `sendRealtime`; browser and native Link
listen on that channel. The transport-path regression test fails if the call returns to reliable.
A controlled lossy real-phone pass is still useful but is not required to re-open the bug.

---

## Priority 2 — the controller can express a real gamepad — complete (`5cef6f0`)

The layout schema in `packages/protocol/src/index.ts` supports exactly five element types:
`button`, `dpad`, `joystick`, `slider`, `touch-surface`. Verified by enumeration.

### [x] 2.1 No shoulder or trigger, and no analog button
A pressure-sensitive trigger cannot be expressed, even though the pipeline already carries analog
values — `ControllerActions.action(name, value: boolean | number)` accepts a number today.

**Completed:** `shoulder`, `trigger` and `analog-button` are validated, rendered and normalized in
both Link clients; triggers and analog buttons remain numeric from press through release.

### [x] 2.2 No placement or handedness hints
Verified: zero occurrences of `side`, `zone` or `handedness` in the protocol. A game can say *what* a
control is but never *where* it belongs, so the controller guesses. Suggested additions, all optional
and advisory so the renderer may still reflow: `side` (left/right/center), `zone`
(thumb/shoulder/index/edge), `size`, `span`, `priority`, plus a top-level `handedness` the player can
override.

**Completed:** all suggested hints landed as advisory layout fields. Authored handedness can arrange
the initial surface, while a player override mirrors left/right placement without moving centered
controls. Browser Link saves that preference locally; native Link applies it to the current layout.

### [x] 2.3 No hold, double-tap, toggle or chord semantics
Every game re-implements them, or does without. These belong in the controller, next to the existing
gesture recognition.

**Completed:** shared controller semantics emit hold, double-tap, toggle and chord actions in both
renderers. Chord members land atomically in one frame, and ownership prevents releasing one physical
control from cancelling the same action held by another.

### [x] 2.4 Sticks have no dead zone, sensitivity curve or radial clamp
`apps/controller-native/src/controls.tsx` clamps each axis independently, so a diagonal reaches ~1.41×
the magnitude of a cardinal. Add per-stick dead zone and response curve to the schema.

**Verify for all of 2.x:** extend `schemas/controller-layout.schema.json`, render the new elements in
both `apps/controller-native/src/controls.tsx` and `app/controller/Controller.tsx`, and confirm the
native and web controllers agree — there is a contract test for layout parity.

**Completed:** layouts carry bounded `deadZone` and `responseCurve` values. One shared radial
normalizer removes the dead zone, applies the curve and clamps magnitude, so diagonals no longer
outrun cardinals. Schema, parser, browser/native parity, interaction and game simulation tests all
fail against the old five-element contract.

---

## Priority 3 — the catalog scales beyond a handful of games — complete (`b3804e7`)

`app/Launcher.tsx:180` renders `catalog.map(...)` over every entry. Verified: **no search, no filter,
no pagination, no virtualisation.** Lazy loading was fixed (homepage JS is flat at ~462 KB regardless
of catalog size), but the *grid* is still linear.

**Build:** search, filtering by input requirement (e.g. "works with just a keyboard" — the data for
this already exists via `resolveInputManifest`), and windowed rendering.
**Verify:** generate 1000 synthetic manifests, load the launcher, confirm interaction stays smooth
and first paint does not regress.

**Completed:** search and input-source filters operate over the whole catalog, while page-sized
windowing and bounded server/hydration output prevent `catalog.map` from mounting every card. The
`?catalog=1000` route passes a real 1,000-entry serialized catalog rather than cloning entries after
load. Runtime checks covered search, empty/reset, the 900-of-1,000 phone filter, pointer and keyboard
continuation with stable focus/scroll, and 390/900/1440 px layouts. Initial rendering stayed at
4/8/12 cards in 1/2/3 columns with no horizontal overflow.

---

## Priority 4 — features from the original brief — complete

### [x] 4.1 Audio out to the controller's own speaker
Requested and never built. `packages/audio` is host-only; the protocol has no message for playing a
cue on a paired device. Design decisions needed: latency versus the TV's own audio, echo when both
sound at once, and whether it is per-role private audio (a clue only one player hears) — which is the
genuinely novel use, and fits Echo Maze's existing private-clue channel.

**Completed:** `speaker.cue` is targeted to the device currently assigned to a role and travels on
the disposable realtime channel. It names one local `pulse-v1` plus bounded pitch and volume; no
audio stream or remote asset crosses the network. Browser Link explicitly advertises
`speakerAudio: locked` until **Enable private audio** resumes audio, then re-announces `ready` and
synthesizes the pulse locally. Native Link plays a bundled WAV and explicitly disables microphone,
recording, background recording and background playback. Both reject stale sequences; native Link
also prevents an older asynchronous seek from overtaking a newer cue. Echo Maze sends its scan cue
privately and plays the host fallback only when the controller is absent or not ready, preventing
intentional TV/phone echo.

**Evidence:** protocol/session/game-host/browser/native tests cover negotiation, device routing,
autoplay readiness, stale/reordered cues and fallback. In the final production browser, separate host
and controller tabs paired through the LAN Hub and direct WebRTC. A held scan after locked→ready
started one controller audio source and zero host sources, updated the host field log, did not replay,
remained linked beyond the heartbeat window and emitted no browser error; the 390 × 844 controller
also had no horizontal overflow. Fresh iOS and Android Hermes exports contain the final
speaker/binary paths and the byte-identical bundled WAV without recording or background permissions.
Audible playback over a real phone remains unverified below.

### [x] 4.2 Binary realtime wire format
Measured this session: an `InputFrame` is **336 bytes of JSON**; a quantized binary form is **24
bytes**. At 60 Hz × 4 controllers that is 645 kbit/s versus 46 kbit/s.

**Read this before starting:** it is *not* a latency fix. Serialization costs ~2 µs against a 16.7 ms
frame budget, and the whole input path measured 0.002–0.005 ms per frame. Do it for bandwidth,
battery and weak wifi — not for lag. `packages/protocol` already has `encodeMotionPacket` and a
48-byte layout to build on, and `packages/adapter-watch` has a working 53-byte binary payload as
precedent.

**Completed:** controllers offer `input-q1` in `hello`; the host selects it per assignment in
`controller.configure` only when the validated layout produces a complete, safely representable
twelve-lane profile. The 24-byte packet carries protocol/source tags, layout revision, sequence,
timestamp and twelve
layout-derived lanes: digital, unsigned analog and signed axis/vector values. Browser and native
WebRTC use it after negotiation. JSON remains accepted and is required pre-configuration, for poses,
for layouts over twelve lanes, for names reused with incompatible shapes, and whenever a particular
frame carries values outside the negotiated profile. That per-frame fallback preserves the old
panel's release during a layout transition. Malformed, wrong-version and stale-revision binary
packets are dropped before a game sees them.

**Evidence:** codec and transport tests cover an exact 24-byte Pro Gamepad round trip, quantization,
typed-array slices, WebRTC negotiation in both directions, JSON fallback and malformed/stale drops;
session and platform contracts prove the advertised feature has production callers in both Link
clients. The final held production-browser scan sent three 24-byte realtime frames and no JSON frame
over the negotiated DataChannel. The value remains bandwidth/battery: 336 bytes representative JSON
versus 24 quantized, not a latency claim.

---

## Closed on 2026-08-16

Every P1–P4 item was built by the previous agent and independently verified as genuinely wired.
The defects found in that work, and the gaps the verification pass left, are now closed:

| Was | Now |
| --- | --- |
| Cue scheduler pinned its clock mapping, desyncing audio permanently after any frame over 100 ms | Re-anchored every tick; a stall shifts cues together instead of leaving them early forever |
| Speaker-sequence test asserted `+1` against the wall clock and flaked | Clock pinned; the assertion is a property of the code, not of machine speed |
| `audit:production` crashed on a network timeout, indistinguishable from a real failure | Exits 2 with the reason; "could not check" no longer looks like "nothing found" |
| Two unreviewed advisories failing the gate | Reviewed as build-tooling with paths, reachability and expiry |
| Native 120 ms staleness guard survived deletion with every test green | Three tests drive an injected clock; removing either check fails two of them |
| Browser speaker could never recover from a silent playback failure | `Audio101.onPlaybackError` demotes it to locked and re-announces, once |
| `enable()` claimed readiness a suspended audio context disproved | Believes the engine where it can answer; proceeds only where it genuinely cannot |
| BeatForge haptics fired at the strike line with no lead for the network hop | Dispatched `HAPTIC_LEAD_SECONDS` early, documented as an estimate |
| The two renderers ordered the same layout differently | One `orderControllerElements` in `@101/protocol`; neither keeps a copy |
| Catalog shipped every manifest field, including ones no card reads | Narrowed to the nine it renders — homepage 50 KB to 32.5 KB, benchmark 864 KB to 748 KB |

### Why the controller tests are regexes, and what to do about it

Worth writing down, because it looks like laziness and is not: **`node --experimental-strip-types`
cannot import a `.tsx` file**. There is no JSX transform in the test path, so a test physically
cannot render a component. That is the entire reason those assertions read source text.

Two honest ways forward, in order of preference:

1. **Keep moving logic out of the components.** Anything worth asserting belongs in a `.ts` module
   both sides import — which is what `app/lib/catalog.ts` and now `orderControllerElements` are.
   This needs no tooling and removes duplication as a side effect.
2. **Add a JSX-capable test path** (vitest, or a Node loader) if component rendering itself must be
   covered. That is a real dependency decision, not a cleanup.

Still regex-bound today: the speaker wiring tests and the gamepad element contract tests. They
assert a component *mentions* the right call. Treat them as reminders, not as proof.

### Catalog payload, and where it now stands

Every field the catalog can derive or does not read has been removed from the wire shape:
`searchText` (28% of an entry, derivable from `id`/`name`/`tagline`/`inputs`, now built once on the
client by `buildCatalogSearchIndex`) and the full `controllers` arrays (120 bytes to answer the two
yes/no questions a card asks, now two booleans).

| | Homepage | 1000-entry benchmark |
| --- | --- | --- |
| Originally | 50,083 B | 864,336 B |
| After narrowing the entry | 32,500 B | 747,762 B |
| After dropping derived fields | **30,232 B** | **478,962 B** |

Verified in a browser, not only by byte count: searching `camera` still matches 6 of 10 games,
nonsense matches 0, clearing restores 10, and the Enhanced/Immersive badge counts (8 and 6) match
what the manifests actually declare.

What remains is genuine per-entry data. Going further means server-side search and pagination —
sending a page instead of a catalog — which is an architecture decision, not a cleanup, and which no
player reaches today with ten games. It is deliberately not built.

### Needs hardware, cannot be closed from a workstation

- **Audible playback on a real phone.** The path is wired end to end and tested at every seam, but
  nobody has heard it.
- **Two-thumb play.** The React Native single-responder fix is reasoned from RN's source and locked
  by a test; simulators synthesise only mirrored pinch, never two independent touch points.

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
- **Private controller audio over WebRTC.** Browser opt-in/readiness, targeted routing, stale-cue
  rejection, the bundled native asset and both Expo exports are verified, but simulator ICE cannot
  complete a real LAN session. On one physical phone, pair Echo Maze, enable private audio if using
  browser Link, scan repeatedly, confirm the pulse comes from the phone without a simultaneous host
  echo, then create network loss and confirm an old pulse never arrives late.
