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

## Vision adapters

Run inference locally. Convert camera frames into landmarks, then gestures, then `InputFrame`. Raw video stays on the source device unless an explicit, separately consented mode truly requires video transport.

## Specialist hardware

WebHID, Web Bluetooth and Web Serial adapters are optional capability enhancements. Browser support and permission state must be surfaced. No game may require one of these adapters just to start.
