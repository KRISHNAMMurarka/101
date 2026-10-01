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

## iPhone app integration

`apps/controller-native/plugins/with-watch-app.cjs` adds the `101LinkWatch` target
during Expo prebuild. It includes these Swift files, links the local
`One01WatchCore` package, and embeds the watch app in the iPhone host. The watch
bundle ID is `com.oneohone.link.watchkitapp`, with companion
`com.oneohone.link`. The generated `ios/` project is ignored; the plugin is the
source of truth after regeneration.

After prebuild and CocoaPods installation, build the iPhone workspace with
`CODE_SIGNING_ALLOWED=NO SDK_STAT_CACHE_ENABLE=NO` to verify both targets and
the embedded watch bundle. Running on a physical watch also requires Xcode to
have a valid Apple account, signing team, and provisioning profiles for both
bundle IDs. The local unsigned simulator build does not establish that signing
or real wrist motion works.

## Privacy

HealthKit is never imported and no health authorization is requested. The app reads `CMDeviceMotion` only — attitude, gravity-removed acceleration and rotation rate. It cannot acquire heart rate, workout state or wearer identity, because it never asks for them.
