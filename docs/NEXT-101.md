# 101 next tasks

Working document for whoever picks this up next. Every task is written to be handed to an agent as
its own prompt.

**Repository:** `/Users/km/Desktop/games/101`
**Branch:** `main` — push only to `github.com/KRISHNAMMurarka/101`
**Last commit at time of writing:** `8de58b1`

---

## Read this first — standing rules

These override anything below. They come from the project owner and are not negotiable.

1. **Do not publish or deploy anything.** No hosting, no external sites, no preview URLs, no
   third-party services. Local work and private commits to the repo above, nothing else.
2. **The product is monochrome. The games are not.** Site chrome, chooser, controller, studio: greys
   only. Inside a game's own canvas, colour is fine and wanted.
3. **Player and developer surfaces are separate.**
   - Player: `app/` — the launcher, the chooser, the game pages, `app/controller/`.
     No confidence numbers, no model names, no "loading model", no raw browser error text, no
     percentages that measure software rather than gameplay, no hardcoded counts ("10 games"),
     nothing that assumes the catalogue stays this size or that games stay browser-local.
   - Developer: `app/studio/**`, `app/*-lab` — diagnostics, model names, raw numbers all fine.
4. **Nothing hardcoded that forecloses growth.** Servers, streamed titles, console games and larger
   catalogues must all remain possible. No `id === "..."` special cases.

### The gate — run all four before every commit

```bash
cd /Users/km/Desktop/games/101
npx tsc --noEmit
npm run lint
npm run test:unit
node --test tests/rendered-html.test.mjs
```

Baseline at `8de58b1`: **348 unit tests, 25 route renders, typecheck and lint clean.**
A task is not done until all four pass. Never commit on a red gate.

### Three traps this codebase has sprung repeatedly

- **A new `*.test.ts` file must be added to `test:unit` in `package.json` by hand.** There is a guard
  test for this now (`tests/platform-contracts.test.ts`), but write the file *and* the script entry
  together or the guard is what tells you.
- **Media queries add no specificity.** A later rule in `app/globals.css` silently beats an earlier
  one. Three separate bugs have come from a stale override further down the file. When you change a
  rule, `grep -n` the selector across the whole stylesheet before assuming yours is the one that
  wins.
- **A test that passes proves nothing until you have seen it fail.** Several modules here were fully
  unit-tested and did not run at all, because the fixtures were shaped like what the author expected
  the producer to emit. For any bug fix below: reproduce against the *old* code first, watch the
  test fail, then fix.

### Verification status of the items below

Tasks marked **[verified]** were confirmed by reading the code during this session.
Tasks marked **[reported]** come from an automated review and are probably right but were not
individually confirmed — **check the claim before acting on it**, and if it is wrong, say so rather
than inventing work.

---

## A. Finish the camera setup walkthrough (1–14)

The flow, the placement maths, the error vocabulary and the components exist and are wired into the
chooser. What is missing is the parts that make it actually measure anything.

**1. Write `packages/adapter-camera/src/luma.ts`.** [verified]
Export `meanLuma(imageData)`, `sampleVideoLuma(video, canvas)` returning
`{ luma, subjectLuma }` (whole frame, and the centre third where a person stands), and
`LUMA_LIMITS`. Sample by drawing the video to a small offscreen canvas — 32×24 is enough.
`packages/vision/src/placement.ts` already accepts a `light` sample and raises `too-dark` and
`backlit` from it, and **nothing anywhere produces one**, so those two messages can never appear.
Re-export from `packages/adapter-camera/src/index.ts`. Add `luma.test.ts` and register it in
`test:unit`.

**2. Sample brightness at a low rate, not per frame.** [verified]
In `app/components/camera/CameraSetup.tsx`, call `sampleVideoLuma` about 4 times a second, not on
every inference frame. It is a `drawImage` plus a pixel loop competing with the pose model for the
main thread. Pass the result into `readBodyPlacement(landmarks, { light })`.

**3. Write `packages/adapter-camera/src/cameras.ts`.** [verified]
Export `listCameras()` (wrapping `navigator.mediaDevices.enumerateDevices()`, filtered to
`videoinput`), `describeCamera(device)` giving a player-facing name — "Built-in camera",
"External camera", falling back to the device label — and `cameraConstraints(deviceId)`.
Beat one of the walkthrough asks *which camera* and there is currently no way to enumerate them.
Note that labels are empty until permission is granted; handle that, do not show blanks.

**4. Offer the camera choice in the setup's first beat.** [verified]
`app/components/camera/CameraSetup.tsx`. Only show a chooser when `listCameras()` returns more than
one. One camera means no question worth asking.

**5. Add `onCameraLost` to both browser adapters.** [verified]
`packages/adapter-camera/src/index.ts`, on `BrowserCameraAdapter` and `BrowserHandAdapter`. Listen
for `ended` on the stream's tracks and call it. `CameraLostError` already exists in `errors.ts` and
nothing throws it. `app/lib/use-camera-input.ts` has its own copy of this listener — once the
adapter owns it, delete the copy in the hook.

**6. Implement `InputAdapter.available()` on both browser camera adapters.** [verified]
`packages/adapter-camera/src/index.ts`. Neither implements it, so a camera counts as an available
input source the moment it is registered, whether or not the device has one. See
`packages/input/src/index.ts` for the interface and how availability is used.

**7. Stop claiming a camera exists because the API does.** [verified]
`app/lib/local-capabilities.ts:30` and `:51` report `camera-hand`, `camera-pose` and `camera-face`
from `Boolean(navigator.mediaDevices?.getUserMedia)` — the API being present, not a camera being
present. The comment at `:33-38` in that same file argues against exactly this. Use
`listCameras()` from task 3.

**8. Write the camera plan when setup completes.** [verified]
`app/components/camera/CameraSetup.tsx` must call `saveCameraPlan(sessionId, plan)` from
`app/lib/camera-plan.ts` on reaching `ready`, and `rememberCameraSetup(kind)` from
`app/lib/camera-setup.ts`. `app/lib/use-camera-input.ts` already reads the plan and auto-starts the
camera in the game; if nothing writes one, that path is dead.

**9. Validate a remembered `deviceId` before using it.** [verified]
Cameras are unplugged and device ids rotate. In `app/lib/use-camera-input.ts`, if the plan names a
device `listCameras()` no longer reports, fall back to the default camera rather than failing.

**10. Draw the target frame during the check beat.** [verified]
`packages/vision/src/overlay.ts` exports `targetFrame` and `drawTargetFrame` and nothing calls
them. Use them in `CameraSetup.tsx` over the live preview, with `coverTransform` from the same
module so the rectangle sits where the body will be.

**11. Detect the confirming gesture.** [verified]
The `confirm` beat asks for both hands above the head (body) or an open spread hand (hands) and
nothing watches for it. Body: `signals.combat.special` / the rising edge of arms-raised from
`@101/vision`. Hands: `signals.gestures.openPalm`. Dispatch `{ type: "gesture" }` into
`advanceSetup`.

**12. Offer an alternative gesture after 8 seconds.** [verified]
Not everyone can raise both arms. `app/lib/camera-setup.ts` — after 8s in `confirm`, accept a step
to either side as well, and say so on screen. Keep the copy in `SETUP_COPY`.

**13. Make the whole walkthrough keyboard-operable.** [verified]
Every beat needs a focusable control, a visible focus ring, and a skip that reachable by keyboard.
`app/components/camera/CameraSetup.tsx` and `app/globals.css`.

**14. Respect `prefers-reduced-motion` in the placement figure.** [verified]
`app/components/camera/CameraPlacementFigure.tsx`. If it animates, it must stop when the OS asks.

---

## B. Vision correctness (15–30)

**15. Return every person the model finds.** [verified]
`packages/adapter-camera/src/index.ts:253` passes `numPoses: maxPeople` (clamped 1–4) and `:271`
then returns `result.landmarks[0]` only. Multi-person tracking is configured, paid for on every
frame, and discarded. Widen `PoseVisionBackend.detect` to return an array, update
`PoseInputAdapter`, and feed `PersonTracker` from `packages/vision/src/people.ts`.
This is the load-bearing task for playing together — 16, 17 and 18 all depend on it.

**16. Give each tracked person a colour and a slot in the games.** [verified]
`packages/vision/src/people.ts` exports `playerColour` and `PLAYER_COLOURS`, and nothing uses them.
Wire into `ShadowArenaGame.tsx` and `BodyDodgeGame.tsx` so two people are visibly two people.

**17. Let the chooser offer more than one body.** [verified]
`app/components/PreGame.tsx` — "With other people" is currently inert. It should be able to mean two
players in front of one camera, not only two devices.

**18. Test `PersonTracker` against a real two-person frame shape.** [verified]
`packages/vision/src/people.test.ts`. The fixture was rewritten to stop inventing absolute room
coordinates; extend it now to cover people crossing, one leaving and returning, and a third
arriving mid-game.

**19. Mirror the metric landmarks, or stop shipping them mirrored.** [reported]
`packages/vision/src/index.ts:257-259`: `mirrorPose` flips image-space `x` and leaves `world`
untouched, and `mirror` defaults to true (`packages/adapter-camera/src/index.ts:49`). So image space
and metric space disagree about left and right. Anything reading `SkeletonSignals.facing` gets the
mirror image of what the player sees. **Verify first**, then either mirror `world.x` too or document
that `world` is camera-space and never mirrored.

**20. Carry `world` and `presence` across the wire, or drop them from the type.** [reported]
`packages/vision/src/index.ts:245-255`. `flattenPose` emits 4 numbers per landmark and
`unflattenPose` reconstructs 4, so a pose that crosses the network loses metric geometry. Either
widen the format or state the limitation in the type. Add a round-trip fidelity test —
`vision.test.ts:76-82` only checks the array length.

**21. Populate `presence` or delete it.** [reported]
`packages/vision/src/index.ts:8` declares it, `:298` forwards it, and no producer sets it. MediaPipe
exposes a presence score. Either read it in the backend or remove the field — a type that advertises
data nothing supplies is how the last four of these bugs happened.

**22. Fix the anisotropic hand distances.** [reported]
`packages/vision/src/index.ts` — `palmSize` (~:465), pinch (~:594), swipe (~:524), circle (~:537)
all mix normalized `x` (fraction of width) with normalized `y` (fraction of height), so every hand
threshold changes with the camera's aspect ratio and with how the hand is turned.
`readHandPlacement` in `placement.ts` already solves this by scaling the `x` term by frame aspect —
apply the same correction here and add a test that the same gesture reads identically on a 4:3 and a
16:9 stream.

**23. Reconcile BeatForge's chart with the punch cooldown.** [reported]
`packages/vision/src/index.ts:112` sets `gestureCooldownMs` to 340 by default and
`BeatForgeGame.tsx` passes no override, while the chart can demand punches closer together than
that. Verify by reading the chart's minimum interval, then either lower the cooldown for that game
or cap the chart's density.

**24. Decide what happens to face tracking.** [verified]
`packages/vision/src/face.ts` is complete and tested. `MediaPipeFaceBackend` in
`packages/adapter-camera/src/index.ts` now requires an explicit `modelPath` because
`face_landmarker.task` is not in `public/models`. **Nothing constructs the class at all.** Either
add the asset and wire a game to it, or delete the backend and say why in the commit. Do not leave a
third state.

**25. Make the tracking-quality tier reachable.** [verified]
`packages/vision/src/quality.ts` (`recommendQuality`, `readDeviceHints`, `resolvePoseModel`,
`TRACKING_PROFILES`) is exported from the package index now and still has no callers. Use it to pick
the model in `BrowserCameraAdapter`, defaulting to `COMMITTED_POSE_MODELS`. If the higher tiers are
never going to ship their assets, cut them to one tier.

**26. Report a camera failure once.** [reported]
`packages/adapter-camera/src/index.ts:411-413`: `start()` calls `this.onError?.(error)` and then
throws the same error, so a caller wired to both shows the message twice.
`app/lib/use-camera-input.ts` is wired to both. Pick one channel.

**27. Stop reallocating the overlay canvas every frame.** [reported]
`app/studio/vision/VisionLab.tsx:59-79` resizes the backing store and calls
`getBoundingClientRect()` inside the per-frame effect, forcing synchronous layout on every inference
frame. Size on resize only.

**28. Clear the lab's error when the camera recovers.** [reported]
`app/studio/vision/VisionLab.tsx:114-115` — once `onError` fires from the running loop, `error`
sticks, and the state badge says healthy while the message says broken.

**29. Fix the stale closure in the lab's simulator.** [reported]
`app/studio/vision/VisionLab.tsx:146-150` — `simulate()` captures `visionState` in a 500 ms timer.

**30. Remove the dead guard in `startSimulation`.** [reported]
`app/studio/vision/VisionLab.tsx:127-129` — unreachable, and on the path it guards it leaves
`adapterRef` pointing at a stopped adapter.

---

## C. The controller (31–41)

**31. Draw the remaining glyphs.** [verified]
`app/controller/Controller.tsx`. The d-pad now uses the icon set's chevron. Check the other controls
— shoulder, trigger, slider — for stray Unicode characters and replace them from
`app/components/Icon.tsx`.

**32. Give every control a press state.** [verified]
The d-pad has `[data-active]`. Buttons use `:active` plus `[data-active="true"]`. Make it one
mechanism across all control types in `app/globals.css`.

**33. Distinguish haptic patterns.** [verified]
`app/controller/Controller.tsx:365` — every local press is `navigator.vibrate(20)`. A d-pad step, a
button press and a trigger release should not feel identical.

**34. Unify the two ways chrome folds.** [verified]
`app/globals.css` has `[data-phase="play"]` rules (added this session) and a separate
`@media (orientation: landscape) and (max-height: 560px)` block that hides an overlapping set of
elements. Two mechanisms, one job. Fold on phase; let the media query handle only what is genuinely
about the viewport.

**35. Make the deck keyboard-operable.** [verified]
`app/controller/Controller.tsx`. The d-pad cells take space and enter. Joystick and touch-surface
take arrow keys. Sliders and triggers need equivalents, and everything needs a visible focus ring.

**36. Test the deck plan at more shapes.** [verified]
`packages/link-controller/src/deck.test.ts` plans every shipped role. Add: eight buttons one side,
a layout with only centre controls, and a layout with two pads on the same side.

**37. Controller overlay on the game's own screen.** [verified] — *this is item 6 of the owner's list*
A player using one device should be able to put the controls over the game rather than on a second
device. New component under `app/components/`, reusing `planControllerDeck` from
`@101/link-controller` so the overlay and the phone agree on layout. Must not cover the play area —
overlay along the bottom edge, and it has to work in both orientations.

**38. Let one device be both controller and screen.** [verified] — *item 8, currently blocked*
The blocker: the renderer lives outside the game packages, so a game cannot be mounted twice. Start
by reading `packages/game-host/src/index.ts` and `packages/render-3d/src/index.ts` and writing down
what actually prevents a second view. Do not build until that is written down.

**39. Selective input/output routing.** [verified]
The owner asked for a device to be able to act as controller, or screen, or both, with several
devices sharing in different combinations at once. This needs a routing model in
`packages/session/src/index.ts` before any UI. Design first, in a document.

**40. Fix `--acid` and `--orange` aliasing to `--paper`.** [reported]
`app/globals.css:90-96` and `881-883` — the developer vision surface's error state renders
identically to its healthy state because both tokens resolve to the same colour. Monochrome does not
mean one grey; use weight, border or fill to separate states.

**41. Reconcile the two label roles.** [reported]
`app/globals.css:361-367` versus `1939-1945` — `.eyebrow` and the other label role disagree on
weight, with no rule stating which applies where.

---

## D. Protocol and extensibility (42–52)

These matter most before anything ships to a real device, because each one gets more expensive once
controllers are installed on people's phones.

**42. Add `runtime` to `GameManifest`.** [verified]
`packages/sdk/src/index.ts:16`. Every package is assumed to be a local JavaScript `update()` loop.
A streamed or server-hosted title cannot be described at all. Add
`runtime?: "local" | "hosted" | "streamed"`, default `"local"`, and make the launcher read it
instead of assuming.

**43. Widen `RendererKind`.** [verified]
`packages/sdk/src/index.ts:14` is `"2d" | "3d"`. A streamed title renders neither way.

**44. Add `display` and `audioOut` to `DeviceCapabilities`.** [verified]
`packages/protocol/src/index.ts:76-80`. No device can currently describe itself as a screen, which
blocks tasks 38 and 39 entirely.

**45. Make the binary lanes fail legibly.** [verified]
`packages/protocol/src/index.ts:618/641` and `778/797` compare a version byte exactly. That is
correct — a fixed-layout packet really is unreadable at the wrong version — but they throw bare
errors. Use `ProtocolVersionError` from the same file so the message names which device is behind.

**46. Negotiate the input packet format.** [verified]
`INPUT_Q1_FORMAT` is the only format and `LinkFeatures.inputFormats` is an array that nothing
negotiates over. Either negotiate, or collapse the array to a single value.

**47. Carry a skeleton from hardware.** [verified] — *item 7*
`packages/hardware/src/index.ts:26` — `HardwareDecodedState` has `actions`, `axes` and `vectors`,
and no `poses`. A motion-capture suit can send buttons and sticks but not a body.
`InputFrame` already has `poses` (`packages/input/src/index.ts:35`) and `InputManifest` already has
a `poses` group (`:57`), so the gap is only in the hardware decoder. Add it, then wire one of
`packages/adapter-hid`, `adapter-bluetooth` or `adapter-serial` end to end.

**48. Sensor and suit connectivity in the walkthrough.** [verified]
The owner asked for suits and sensors to be offered the same way a phone is. Once 47 lands, the
camera walkthrough's first beat should offer them where the game declares support.

**49. Version the pairing ticket separately from the protocol.** [reported]
`packages/protocol/src/index.ts:1197` ties ticket validity to `PROTOCOL_VERSION`, so a protocol bump
invalidates every outstanding pairing link.

**50. Make the session survive a protocol upgrade mid-game.** [verified]
`packages/session/src/index.ts` — decide what happens when a v2 controller and a v3 host meet
halfway through a session, and write it down before implementing.

**51. Document the wire format.** [verified]
There is no single document describing the handshake, the lanes, the packet layouts or the version
policy. Write `docs/PROTOCOL.md` from the code, not from memory.

**52. Decide the input-format story for streamed games.** [verified]
Depends on 42. A streamed title's input goes somewhere else entirely; make sure the manifest can say
so.

---

## E. Player surface polish (53–64)

**53. Sweep every player-facing string.** [verified]
`app/` excluding `app/studio/**`. Look for: percentages measuring software, model names, "local",
"bundled", "landmark", "adapter", "diagnostics", raw browser error text, and SHOUTING CAPS on
anything that is a sentence rather than a label. The camera surfaces were cleaned this session; the
rest were not audited.

**54. Consider a copy guard test.** [verified]
`tests/` — the pattern used in `packages/vision/src/placement.test.ts` and
`packages/adapter-camera/src/errors.test.ts` (regex over a copy table, banning developer
vocabulary) could be extended across the player components. Judge whether it is worth the false
positives before building it.

**55. Make "With other people" do something.** [reported]
`app/components/PreGame.tsx:119-128` — it is the only option in the chooser with no control of any
kind.

**56. Remove the dead `needs-device` class.** [reported]
`app/components/PreGame.tsx:105` — no rule matches it.

**57. Audit the game over panels.** [verified]
Five games have their own. Check alignment, focus order after a run ends, and that "Play again"
takes focus.

**58. Empty and loading states across the launcher.** [verified]
`app/Launcher.tsx`, `app/loading.tsx`, `app/not-found.tsx`, `app/error.tsx`. Check each renders
something deliberate, and that nothing hardcodes a catalogue size.

**59. Check the catalogue scales.** [verified]
`app/lib/catalog.ts` and `app/Launcher.tsx` with 50 fake entries. Grid, pager and search must hold.

**60. Search and filter the catalogue.** [verified]
There is a `search` icon in `app/components/Icon.tsx` and no search. Either build it or drop the
icon.

**61. Make the studio explicable.** [verified]
The owner said "studio is a lil bit heavy to understand". `app/studio/` — the entry point needs to
say what it is for in one sentence a non-developer understands, or be renamed.

**62. Add a developer entry point to the main surface.** [verified]
The owner asked for a developer/studio button on the main game page. It must read as a separate
place, not a game.

**63. Consistent back buttons.** [verified]
`app/globals.css` declares `.back-button` twice, 1457 lines apart. Consolidate, then check every
page that uses it.

**64. Fullscreen inside the game frame.** [verified]
`app/components/FullscreenButton.tsx` exists. Confirm it targets the game frame rather than the
document on every game page, and that the control is in the frame.

---

## F. Design system hygiene (65–74)

**65. Delete or use the seven orphan tokens.** [reported]
`app/globals.css:115,116,120,138,127,128,173` — `--type-display-size`, `--type-display-line`,
`--type-action-*` and others have zero `var()` references.

**66. Delete the dead diagram block.** [reported]
`app/globals.css:411-427` — no file outside the stylesheet mentions any of those class names.

**67. Reconcile the spacing scale with the native app.** [reported]
`app/globals.css:102-110` versus `apps/controller-native/src/theme.ts:91` — the scales are claimed to
be shared and the *names* are off by one step, so porting a value by name silently changes it.

**68. Extend the stylesheet contract test.** [verified]
`tests/stylesheet-contract.test.ts` currently guards self-referential tokens, the light/dark palette
cycle, and safe-area padding on the controller. Add: no colour defined only inside a media or
`[data-theme]` block, and no duplicate selector declared twice in the file.

**69. Audit light mode.** [verified]
It has broken twice. Walk every page in both themes and confirm nothing borrows the other theme's
ground.

**70. Check every page at 320px.** [verified]
The narrow breakpoint is `430px`; below that is untested.

**71. Check every page at 2560px.** [verified]
`--shell-max` bounds the shell; confirm nothing stretches badly outside it.

**72. Reduced motion across the product.** [verified]
Grep for `transition` and `animation` in `app/globals.css` and confirm a `prefers-reduced-motion`
block covers them.

**73. Print stylesheet, or explicitly none.** [verified]
Decide and record the decision.

**74. Favicon and app icons.** [verified]
`public/` — check what exists and whether the manifest references real files.

---

## G. Tests and CI (75–86)

**75. Add a real end-to-end camera test.** [verified]
Everything camera-related is unit-tested against synthetic landmarks. There is no test that a camera
actually drives a game. Use a fake `MediaStream` and a stub backend.

**76. Test the five games' input paths.** [verified]
`games/*/src/director.test.ts` covers game logic. Nothing covers a keypress reaching the director.

**77. Snapshot the rendered chooser.** [verified]
`tests/rendered-html.test.mjs` renders 25 routes. Add assertions about the chooser's option count
being derived rather than fixed.

**78. Test the controller at every shipped layout in both orientations.** [verified]
`packages/link-controller/src/deck.test.ts` — plans exist; add assertions about reach and overlap.

**79. Guard against re-introducing per-game camera code.** [verified]
`tests/platform-contracts.test.ts` — a test that no game component imports `BrowserCameraAdapter` or
`BrowserHandAdapter` directly now that `app/lib/use-camera-input.ts` exists.

**80. Make `test:unit` self-maintaining.** [verified]
The guard test catches an unregistered file. Consider globbing instead, if the runner allows it.

**81. Add a bundle size check.** [verified]
No budget exists. Set one and fail the gate on a large regression.

**82. Run the gate in CI.** [verified]
There is no CI configuration. Add one that runs exactly the four gate commands.

**83. Test the service worker's cache behaviour.** [verified]
`tests/pwa-contract.test.ts` exists; confirm it covers a version bump not orphaning a cached
controller.

**84. Test protocol version negotiation across a real transport.** [verified]
`packages/protocol/src/protocol.test.ts` covers the pure functions. Add a `MultiplexLinkTransport`
case with mismatched peers.

**85. Fixture review.** [verified]
Every `*.test.ts` fixture in `packages/vision/` and `packages/adapter-camera/` should be checked
against what the real producer emits. Two were wrong and both hid real bugs.

**86. Document the testing constraint.** [verified]
`node --experimental-strip-types` cannot import `.tsx`, which is why logic lives in packages. Write
this in `AGENTS.md` or `CLAUDE.md` so the next person does not rediscover it.

---

## H. Performance (87–92)

**87. Measure the pose pipeline.** [verified]
No frame budget is recorded anywhere. Measure on a laptop and a phone, write the numbers down.

**88. Check the camera pipeline against a slow device.** [verified]
Throttle the CPU 4× and confirm the walkthrough still completes.

**89. Model loading is 5.8MB on first use.** [verified]
`public/models/pose_landmarker_lite.task`. There is no progress indication beyond "Starting…".
Decide whether that is acceptable on a slow connection.

**90. Audit `requestAnimationFrame` loops.** [verified]
Several components run their own. Confirm each cancels on unmount.

**91. Check for layout thrash.** [verified]
`getBoundingClientRect()` inside animation frames — task 27 is one instance; look for others.

**92. Lighthouse pass on the launcher.** [verified]
Record the numbers; do not optimise blind.

---

## I. Accessibility (93–97)

**93. Keyboard-only pass over every route.** [verified]
Including the controller and the camera walkthrough.

**94. Screen reader pass over the chooser and the walkthrough.** [verified]
The walkthrough describes physical positioning, which is the hardest thing here to convey without
sight. It may be right to hide the camera option when a screen reader is in use — think about it
rather than assuming.

**95. Colour contrast audit in both themes.** [verified]
Monochrome makes this easy to get wrong.

**96. Focus visibility everywhere.** [verified]
Grep for `outline: none` and justify each one.

**97. Captions and labels on every media element.** [verified]
The `<video>` elements are camera previews with `aria-label`s; confirm they are accurate.

---

## J. Finishing (98–101)

**98. Write `AGENTS.md`.** [verified]
Repository conventions: the gate, the player/developer split, the monochrome rule, the test-runner
constraint, the `test:unit` registration requirement, the media-query trap.

**99. Write `README.md` for a developer arriving cold.** [verified]
What this is, how to run it, how the packages relate.

**100. Full manual pass.** [verified]
Every game, both themes, both orientations, phone and desktop, with and without a camera. Record
what breaks; do not fix as you go.

**101. Decide what "done" means and write it down.** [verified]
There is no definition of the first release. Without one this list regenerates itself forever.

---

## Suggested order

Do **42, 44, 45** first — the protocol changes get more expensive every day, and once a controller is
installed on a phone, cross-version negotiation cannot be fixed without breaking it.

Then **1–14**, which finish a feature that is currently 80% built and 0% usable: the placement check
cannot see light, the camera chooser cannot list cameras, and nothing writes the plan the game reads.

Then **15**, which unblocks 16, 17 and 18 together.

Leave **37, 38, 39** until last. They need a design pass before any code, and 38 is blocked on
something nobody has written down yet.
