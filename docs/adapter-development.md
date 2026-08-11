# Adapter development

An adapter converts one physical source into `InputFrame`. It has no game-specific behavior.

```ts
interface InputAdapter {
  readonly id: string;
  readonly source: InputSource;
  start(emit: InputFrameListener): void | Promise<void>;
  stop(): void | Promise<void>;
}
```

## Requirements

- Use a stable `deviceId` for the connection lifetime.
- Increment `sequence` for every emitted frame.
- Use the source device's high-resolution monotonic timestamp where possible.
- Normalize axes and vector components into `[-1, 1]`.
- Emit game-language defaults only when they are universal; configurable mappings belong in the runtime mapping layer.
- Remove every event listener, animation frame and native subscription in `stop()`.
- Keep permissions lazy and explain why they are needed.
- Report capability and transport limitations honestly.

## Motion adapters

Send raw samples through `@101/motion`: timestamp normalization, screen-orientation correction, quaternion calibration, smoothing, dead zone and gesture recognition. Do not recognize a swing from a single noisy sample; use hysteresis and a state machine.

`@101/adapter-motion` is the browser reference. `requestMotionPermission()` must be called from an explicit user gesture before `BrowserMotionAdapter.start()`. The adapter publishes `steer`, `tiltX`, `tiltY`, quaternion/diagnostic axes, the `tilt` vector, and state-machine `shake`, `swing`, `slash`, and `spin` actions. Games consume only the semantic subset they bind.

## Vision adapters

Run inference locally. Convert camera frames into landmarks, then gestures, then `InputFrame`. Raw video stays on the source device unless an explicit, separately consented mode truly requires video transport.

`@101/adapter-camera` is the browser reference. MediaPipe-specific classes implement `PoseVisionBackend` and `HandVisionBackend`; `PoseInputAdapter` and `HandInputAdapter` own the stable 101 frame mappings and can consume other backends or synthetic landmarks. Static hand poses require stable frames, while swipes/circles use timestamped histories and cooldowns. This split is intentional: games and classification tests do not depend on camera access or a particular inference engine. See [vision foundation](vision.md).

## Specialist hardware

WebHID, Web Bluetooth and Web Serial adapters are optional capability enhancements. Browser support and permission state must be surfaced. No game may require one of these adapters just to start.
