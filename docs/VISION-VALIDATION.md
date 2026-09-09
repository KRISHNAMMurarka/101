# Vision producer and fixture validation

Audited locally on 9 September 2026 against installed `@mediapipe/tasks-vision` **1.0.1**, Node **v24.14.0**, and the working tree for `NEXT-101` item 85. This records producer compatibility and deterministic test evidence. It does not claim a physical two-person or device-performance trial.

## Producer boundaries

The installed package's `vision.d.ts` is authoritative for the JavaScript result shape: `PoseLandmarkerResult` at line 2725, `HandLandmarkerResult` at 1038, `NormalizedLandmark` at 2425, `Landmark` at 2141, `Category` at 99, and `Matrix` at 2175. The bundled `vision_bundle.mjs` conversion functions were also inspected: normalized/world landmark objects copy x, y, z and visibility, without presence.

- A pose result contains `landmarks: NormalizedLandmark[][]` and `worldLandmarks: Landmark[][]`. The outer index identifies the corresponding detection in this result, not a persistent person. Each detected body has 33 points. Image x/y use different image edges as units; image z is hip-relative depth in roughly x units. World x/y/z are metres relative to that body's hip midpoint, so two people do **not** acquire different world origins merely by standing apart. These conventions are documented by the [producer's pose guide](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js#handle_and_display_results).
- The guide's generic output example includes `presence`, but the installed web types and bundle do not expose it. `PoseLandmark` therefore does not invent or serialize per-joint presence. The `minPosePresenceConfidence` model option is a detection threshold, not a per-joint output field.
- A hand result contains parallel `landmarks`, `worldLandmarks` and `handedness` arrays; handedness contains category arrays. Each hand has 21 points. Image z is wrist-relative; metric coordinates are relative to the hand's geometric centre. See the [producer's hand guide](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/web_js#handle_and_display_results). The 101 backend takes the first handedness category, lowercases Left/Right, and retains the matching world points. Its `confidence` and synthesized hand-point `visibility` use the **handedness category score**, which is a proxy, not independently measured per-joint visibility or a calibrated probability that a finger is visible.
- Backend `detect` is synchronous and returns `[]` for an empty result. A stub backend must return an array of people or tracked hands, never one flattened person at the outer boundary. Browser detection supplies increasing millisecond timestamps and the real video aspect ratio.
- Native `MediaStreamTrack.stop()` sets the track to ended without dispatching an `ended` event. External termination is a separate event. The fake track now follows that distinction; duplicate external callbacks remain an explicit robustness case. See the [capture specification](https://w3c.github.io/mediacapture-main/#dom-mediastreamtrack-stop).

## Complete fixture inventory

All twelve `*.test.ts` files under the two packages were read. Compact point arrays that test arithmetic are intentionally simplified bodies/hands, not recordings of an inference run. Unused joints have neutral/low-visibility values; missing arrays, malformed tuples and missing landmarks are explicitly robustness inputs.

| File | Producer/consumer and audit result |
| --- | --- |
| `packages/vision/src/vision.test.ts` | 33-point pose and 21-point hand classifier inputs. Image and metric spaces are separate. Corrected the smoothing fixture's world origin to the hip midpoint on all three axes, and kept the swipe path inside the image. World-only wire preservation and 4:3/16:9 gesture timing are asserted. Sparse serialization examples test the codec, not full model output. |
| `packages/vision/src/people.test.ts` | Unordered 33-point person arrays, hip-relative world coordinates. Replaced older negative/out-of-frame visible hip positions with in-frame trajectories. Corrected occlusion to complete points with visibility .05; the absent-index case is now separately named malformed input. Crossings assert whose position each identity follows, not merely that two IDs survive. |
| `packages/vision/src/skeleton.test.ts` | Known metre-space joint configurations for standing, sitting, crouching, lying, facing and reach. Corrected image fields that previously copied metres directly; they now use a simple orthographic projection while world values retain the hip origin. This tests geometry, not physical recognition accuracy. |
| `packages/vision/src/placement.test.ts` | Image-space pose and hand arrays plus normalized light samples. Corrected ordinary ankles to remain in frame and lowered visibility for deliberately out-of-frame joints. Tests isolate placement, optional leg requirements, aspect-correct hand size, darkness/backlight, and hold/grace timing. |
| `packages/vision/src/overlay.test.ts` | Stream/box dimensions are DOM geometry inputs, not model results. Includes real 4:3 and 16:9 ratios, zero metadata, cover cropping and mirroring. `createSimulatedPose` is explicitly a simulation source. |
| `packages/vision/src/quality.test.ts` | Synthetic `DeviceHints` and provisioned-model sets, matching browser hint units. These test a recommendation policy and fallback selection; they are not speed, battery or accuracy benchmarks. |
| `packages/vision/src/face.test.ts` | Pure utility inputs: category name/score subsets and explicit 16-scalar rotation matrices. Empty/partial categories and short matrices are intentional. There is no shipped face backend, asset or gameplay consumer; these tests do not validate live face tracking or a complete face-result boundary. |
| `packages/adapter-camera/src/adapter.test.ts` | Camera-independent ingestion of normalized 33/21-point arrays. These exercise the supported no-world input path and semantic frame publication/release, not the MediaPipe wrapper. |
| `packages/adapter-camera/src/browser.test.ts` | Fake media/video lifecycle plus stub detection. The wrapper result is typed against the installed `PoseLandmarkerResult` fields. Corrected world arrays to use separate hip-centred bodies with different shoulder spans, so matching the wrong result index fails. Fake stop and external ended events are separate. Permission, delayed initialization, reconnect, duplicate callbacks, quality and per-player device IDs are checked. |
| `packages/adapter-camera/src/cameras.test.ts` | `MediaDeviceInfo` objects include deviceId, groupId, kind, label and toJSON; blank pre-permission labels and microphones are intentional. Enumeration rejection/absent API are browser-boundary failures. |
| `packages/adapter-camera/src/luma.test.ts` | `Uint8ClampedArray` RGBA pixels with ImageData dimensions/colorSpace; partial data-only values exercise the accepted `meanLuma` input. A minimal canvas/video double supplies only methods read by the sampler. It does not reproduce browser color management or actual lighting. |
| `packages/adapter-camera/src/errors.test.ts` | Uses actual `DOMException` for named capture failures and `TypeError` for an absent callable API. Legacy error names and unknown values are intentional classifier-compatibility cases. Previously its comment incorrectly said this runtime had no DOMException. |

The corrected low-visibility fixture exposed a real bug: `PersonTracker` previously required hip objects to exist but did not require them to be visible. It now applies `PLACEMENT_LIMITS.seen` (0.5) to **both** hips. An unseen pose cannot create an identity or refresh its last-seen time. An existing identity retains its original position and timestamp through the configured grace period, then expires normally. A returning visible body can retain the slot within that period.

## Compatibility and geometry receipts

`flattenPose` keeps legacy 4-tuples `(x,y,z,visibility)` when world data is absent. Rich poses use `[-101,1,...]` followed by 8-tuples `(x,y,z,visibility,hasWorld,worldX,worldY,worldZ)`. `unflattenPose` validates tuple length, version, finite scalars and world flags, and reads both forms. Rich transport preserves world geometry; it does not promise presence or any unknown future model field. See [the protocol contract](PROTOCOL.md). Hands still use 3-tuples and do not transmit their world geometry.

Mirroring changes image x to `1-x` and metric x to `-x`. Hand distances, classification geometry and temporal x histories use x multiplied by `videoWidth/videoHeight`; output pointers stay image-normalized. Identical physical geometry and swipe trajectories produce the same gestures/timing at 4:3 and 16:9. `readHandPlacement` uses the same frame aspect convention.

`PersonTracker` follows image-space hip motion with a short prediction capped at 120 ms. It is positional association, not biometric identity or a guarantee through prolonged total occlusion. The adapters publish independent device IDs and stable `player-N` slots, neutralize missing players immediately, and preserve identity only for the tracker's grace period. BodyDodge and ShadowArena consume two independent slots and render their numbers; the default remains one person.

The light sampler reads a 32×24 RGBA image, with subject brightness from x=11 through x=20 (the central vertical third rounded to ten columns). It uses normalized perceptual RGB luma. Placement shares the exact constants: minimum luma 0.16, backlight difference 0.45, body fill 0.22–0.72, visibility 0.5, and minimum hand size 0.08. No available image yields `undefined`, not a black-room reading. The central strip is a framing heuristic, not segmentation of an actual person.

The camera adapter's default model set contains only `/models/pose_landmarker_lite.task` (5,777,746 bytes on disk). The hand asset is 7,819,105 bytes. Full/heavy files are absent in this checkout. `recommendQuality(readDeviceHints())` reaches the selection path; `resolvePoseModel` steps down to bundled lite unless the caller supplies a provisioned-model set. GPU creation is attempted first with CPU fallback. WebGL2 availability is only a hint that delegate creation might work; policy tests are not performance evidence. The optional fetch script remains available, including an unconsumed face entry; it was not run.

BeatForge's director caps tempo at 158 BPM and can schedule half beats, giving a shortest chart interval of `0.5 × 60 / 158 = 0.189873… s`. The default body gesture cooldown is 340 ms. BeatForge now supplies 150 ms, below that interval while retaining the shared default for other games. This resolves the arithmetic conflict; physical punch timing, smoothing and inference latency still need a person to test them.

## Evidence and remaining physical checks

Adding coordinate/origin/native-stop assertions against the previous fixtures produced **13 failing tests**, before fixture correction. Replacing the invented missing-hip case with a faithful low-visibility pose then failed against the existing tracker; the visibility fix made it pass. The additional grace regression verifies identity retention without refreshing unseen observations.

The full package selector is:

```sh
node --experimental-strip-types --test \
  packages/vision/src/vision.test.ts packages/vision/src/people.test.ts \
  packages/vision/src/placement.test.ts packages/vision/src/skeleton.test.ts \
  packages/vision/src/face.test.ts packages/vision/src/quality.test.ts \
  packages/vision/src/overlay.test.ts packages/adapter-camera/src/adapter.test.ts \
  packages/adapter-camera/src/browser.test.ts packages/adapter-camera/src/cameras.test.ts \
  packages/adapter-camera/src/errors.test.ts packages/adapter-camera/src/luma.test.ts
```

After the final visibility edit, the complete package selector above passed **91/91**. The changed-scope selector including `tests/camera-game.test.ts` also passed **48/48**. That integration fixture uses a fake stream and stub backend with two complete MediaPipe-shaped body arrays to drive the actual adapter → InputBus → BodyDodge/ShadowArena update path. It proves independent movement, gate results, punches, targeted defense and departure release. It is not a test that two real bodies were inferred successfully. Root release gates validate the integrated candidate separately.

The coordinating browser check started the actual built-in camera, saw partial-body framing and advanced the setup using the keyboard alternative. It did not complete a deliberate physical confirmation pose or a real two-person run. Still requiring physical evidence: people entering/crossing/leaving in poor lighting and partial occlusion, left/right handedness expectations with a mirrored preview, full-body framing at different camera angles, and performance on lower-powered/mobile devices. No recorded camera frames or new model assets were produced by this audit.

## Item 48: sensor/suit chooser contract

No shipped `games/*/manifest.json` declares `hid`, `bluetooth` or `serial`; the SDK currently carries source names but has no game-specific hardware profile binding. Item 47 adds opaque `poses` to `HardwareDecodedState` and forwards them through `HardwareFrameEmitter`; the HID test proves report → InputBus → disconnect release. That does **not** make an arbitrary suit's skeleton compatible with a shipped game's semantic controls. The chooser should continue to omit unmapped hardware.

A minimal future integration should bind a versioned, reviewed profile to a `GamePackage`, validated alongside its input manifest. The profile needs a stable ID and player-facing label, transport, assigned player/role, emitted control names, and exactly one existing mapping or custom decoder. Pose-producing profiles must also state the tuple schema/version, joint order, units, origin, handedness and calibration requirements. A suit cannot supply camera-style `body` coordinates by merely renaming its packet.

Use existing adapter options rather than a second hardware framework:

| Transport | Required profile data and user action |
| --- | --- |
| WebHID | Explicit vendor/product/usage filters and mapping or decoder; call `WebHIDAdapter.requestDevice()` from the connect button. |
| Web Bluetooth | Service UUID, characteristic UUID, explicit device filters, optional services, and mapping or decoder; call `WebBluetoothAdapter.requestDevice()`. Avoid advertising arbitrary devices via acceptAllDevices. |
| Web Serial | Explicit port filters, baud/open options, bounded framing appropriate to the actual protocol, and mapping or decoder; call `WebSerialAdapter.requestPort()`. A binary suit must not silently inherit the default newline framer. |

Only offer the profile when the game declares its source **and** its profile resolves to these concrete settings **and** the relevant API is available in a secure context. Availability means the browser can offer connection, not that a compatible suit is present. Display connected only after adapter status and a valid decoded input agree. Register with the existing host input bus; release/unregister on cancellation, disconnect, replacement and unmount. Keep the camera and conventional alternatives available. Before adding a profile to the player chooser, test a documented real packet fixture through decoder → bus → actual game behavior, plus unplug/reconnect and neutral release, then perform a physical-device trial. No game-ID branch or speculative “connect a suit” button is warranted by the current manifests.
