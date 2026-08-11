# Vision foundation

101 bundles MediaPipe Tasks Vision 1.0.1, its WebAssembly runtime, and the Apache-2.0 BlazePose GHUM Lite task model. Installed gameplay does not fetch code, WASM, or model weights from a CDN.

```text
local camera frame
  → MediaPipePoseBackend
  → 33 normalized landmarks
  → PoseClassifier calibration + smoothing + hysteresis
  → PoseInputAdapter
  → InputFrame actions / axes / vectors / pose
  → 101 game
```

`@101/vision` owns 101-specific interpretation. It computes neutral-relative body position, shoulder-to-hip lean, crouch and lift amounts, then derives stateful `duck`, `jump`, `leanLeft`, `leanRight`, `stepLeft`, `stepRight`, `armsRaised`, and temporal `punch` actions. Games do not import MediaPipe or camera APIs.

`@101/adapter-camera` owns browser capture and the replaceable inference backend. `BrowserCameraAdapter.start()` is called only after an explicit user action. It requests video with `audio: false`, processes at a bounded rate, publishes compact numerical input, and stops every media track in `stop()`.

Vision Lab uses the same adapter in two modes:

- Camera mode displays a mirrored local preview and landmark overlay.
- Simulation mode feeds deterministic synthetic landmarks through `PoseInputAdapter` without opening a camera.

The current MediaPipe Web API runs video detection synchronously. The adapter caps inference frequency to protect rendering responsiveness. Moving inference to a worker is a later performance hardening task; this limitation is not hidden.

The bundled model tracks one person. It must not be used for identity recognition, surveillance, medical decisions, or metric-accurate depth. BodyDodge always provides keyboard and gamepad alternatives.

## Bundled asset integrity

| Asset | SHA-256 |
| --- | --- |
| `pose_landmarker_lite.task` | `59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a` |
| `vision_wasm_internal.wasm` | `8da277a733926eacd0474b8704b36742d6ec3231c57a860c5b889dff8f1df886` |
| `vision_wasm_nosimd_internal.wasm` | `a28483cd42e74e855bf5ebdb6b40d9b66a5b49e35e95020bc97669e6822a3192` |
