# Vision foundation

101 bundles MediaPipe Tasks Vision 1.0.1, its WebAssembly runtime, the Apache-2.0 BlazePose GHUM Lite task model, and the Apache-2.0 Hand Landmarker task model. Installed gameplay does not fetch code, WASM, or model weights from a CDN.

```text
local camera frame
  → MediaPipePoseBackend / MediaPipeHandBackend
  → 33 body landmarks / 21 landmarks per hand
  → 101 calibration, smoothing, hysteresis and temporal classifiers
  → PoseInputAdapter / HandInputAdapter
  → InputFrame actions, axes, vectors and compact poses
  → 101 game
```

`@101/vision` owns 101-specific interpretation. The body path computes neutral-relative position, shoulder-to-hip lean, crouch and lift amounts, then derives stateful `duck`, `jump`, `leanLeft`, `leanRight`, `stepLeft`, `stepRight`, `armsRaised`, and temporal `punch` actions.

The hand path smooths a 21-landmark hand, requires static poses to remain stable across frames, and keeps timestamped palm/pointer histories for gestures that cannot be recognized safely from one frame. It derives `openPalm`, `fist`, `pinch`, `point`, `twoFingers`, `grab`, directional swipes, and closed circles. `HandInputAdapter` maps them to generic `hand.*` events and the shared `spell.cast.*` vocabulary demonstrated by Spellcaster. Phone motion, keyboard, and gamepad adapters can emit those same spell events.

`@101/adapter-camera` owns browser capture and replaceable inference backends. `BrowserCameraAdapter.start()` and `BrowserHandAdapter.start()` are called only after an explicit user action. They request video with `audio: false`, process at a bounded rate, publish compact numerical input, and stop every media track in `stop()`. Games do not import MediaPipe or camera APIs.

Vision Lab exposes both production paths:

- **Body** displays the mirrored 33-point pose overlay and supports deterministic keyboard simulation through `PoseInputAdapter` without opening a camera.
- **Hands** displays up to two mirrored 21-point hand overlays and the stabilized/static and temporal actions emitted by `HandInputAdapter`.

The current MediaPipe Web API runs video detection synchronously. The adapters cap inference frequency to protect rendering responsiveness. Moving inference to a worker is a later performance-hardening task; this limitation is not hidden.

These models must not be used for identity recognition, surveillance, medical decisions, or metric-accurate depth. Tracking quality varies with lighting, framing, occlusion, skin/background contrast, and device performance. BodyDodge and Spellcaster always provide keyboard and gamepad alternatives.

## Bundled asset integrity

| Asset | SHA-256 |
| --- | --- |
| `pose_landmarker_lite.task` | `59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a` |
| `hand_landmarker.task` | `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1` |
| `vision_wasm_internal.wasm` | `8da277a733926eacd0474b8704b36742d6ec3231c57a860c5b889dff8f1df886` |
| `vision_wasm_nosimd_internal.wasm` | `a28483cd42e74e855bf5ebdb6b40d9b66a5b49e35e95020bc97669e6822a3192` |
