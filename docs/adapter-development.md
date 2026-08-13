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

## Watches

A watch is an extension of 101 Link, not a separate peer. The native watch app relays a compact binary sample to its own paired phone, and `@101/adapter-watch` turns it into ordinary `watch-motion` frames. Wrist gestures are edge-triggered with hysteresis because a forearm pivot is not a shoulder swing, and transport locality is reported rather than assumed: Wear OS is only `verified-local` when the OS confirms a nearby node. See [watch companions](watches.md).

## Specialist hardware detail

All three transports deliver bytes, so `@101/hardware` owns the byte-to-game-language conversion once: a declarative `HardwareReportMapping` of offsets, value types, ranges, dead zones and thresholds, plus serial framers and a shared frame emitter. `@101/adapter-hid`, `@101/adapter-bluetooth` and `@101/adapter-serial` differ only in how they obtain bytes, so one authored mapping survives a device moving between transports. Pass a `decoder` instead of a `mapping` for bit-packed or text protocols. Every adapter emits a neutral release frame on surprise disconnect as well as deliberate teardown. See [specialist hardware](hardware.md).
