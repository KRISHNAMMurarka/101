# 101 Link — Apple Watch companion

Relays wrist motion to 101 Link on the paired iPhone. The watch never speaks the 101 protocol and never knows which game is running; the phone's existing Link session carries the input the rest of the way. See [watch companions](../../docs/watches.md) for the architecture and the wire format.

## Layout

| Path | Contents |
| --- | --- |
| `Sources/One01WatchCore/` | Platform-independent logic: the binary payload, the sampling policy, the link-state model |
| `App/` | watchOS-only shell: SwiftUI, `CMMotionManager`, `WCSession` |
| `Tests/` | Unit tests for the core |

The split is deliberate. Everything that does not need a watch builds and tests on macOS in seconds, so the watch-only shell stays thin enough to review by eye.

## Verify

```bash
npm run watch:ios:test
```

```bash
npm run watch:ios:check
```

The first runs the core's unit tests on the host. The second typechecks every source — including the shell's `WatchConnectivity`, `CoreMotion`, `WatchKit` and `SwiftUI` usage — against the real watchOS SDK, so a watch-only mistake fails on a Mac rather than on a wrist. It needs Xcode's watchOS SDK but not an installed watchOS simulator runtime, and skips with a clear message where the SDK is absent.

## Running on hardware

1. In Xcode, add a **watchOS App** target to the iOS host app in `apps/controller-native`.
2. Add `App/*.swift` to that target.
3. Add this directory as a local Swift package dependency so the target can `import One01WatchCore`.
4. Select your own signing team.

Step 4 cannot be skipped or bundled. Apple requires a registered Apple Developer account and a provisioning profile tied to your team; no repository can remove that requirement, and this one does not pretend otherwise. The watch app must also be embedded in an iOS host whose bundle identifier is a prefix of the watch app's.

## Privacy

HealthKit is never imported and no health authorization is requested. The app reads `CMDeviceMotion` only — attitude, gravity-removed acceleration and rotation rate. It cannot acquire heart rate, workout state or wearer identity, because it never asks for them.
