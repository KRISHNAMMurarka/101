# Native 101 Link

`apps/controller-native` is the iOS and Android implementation of the universal 101 controller. It is an independent application, but not an independent protocol fork: it consumes the same `@101/protocol`, `@101/pairing`, `@101/link-controller`, and `@101/motion` packages used by the browser runtime.

## Included controller features

- local QR scan, pasted ticket, controller URL and `oneohone://pair` deep link
- fully serverless manual `101C2`/`101J2` offer acceptance with copyable return answer
- expiring authenticated local-Hub signaling and generation-based reconnect
- direct native WebRTC reliable control plus disposable realtime DataChannels
- automatic host-provided JSON controller layouts for third-party games
- classic controller, motion wand, steering wheel, tilt board, touch surface, trigger controller, motion detector and Sensor Lab presets
- buttons, D-pad, joysticks, normalized touch surface and sliders
- local quaternion correction, neutral calibration, sensitivity, dead zone, smoothing and swing/shake/spin recognition
- host assignments, live private state, latency heartbeat and tap/impact/warning haptics
- durable random device identity and optional last-session reconnect through platform secure storage
- a paired Apple Watch or Wear OS watch as an extra input source on the same player, through `modules/one01-watch`

Games never import React Native, Expo, WebRTC, camera, or sensor APIs. A third-party game declares a controller role and layout through the public SDK. The existing 101 host sends that layout and native Link returns ordinary `InputFrame` actions, axes and vectors.

## iOS: Expo modules must build from source

iOS 101 Link used to die on launch, before rendering a frame, in both Debug and Release:

```text
[runtime not ready]: Error: Cannot find native module 'ExpoAsset'
```

**Cause: Expo's precompiled modules.** They are enabled by default for iOS in SDK 57. With them on, `ExpoModulesCore` shipped as a *dynamic* XCFramework while the module classes were linked *statically* into the app binary, and no module registered with the runtime registry. The very first `requireNativeModule` — `expo-asset`, imported during startup — threw, and the app was dead before its own code ran.

The fix is one declarative line in `app.json`:

```json
["expo-build-properties", { "ios": { "usePrecompiledModules": false } }]
```

That writes `EXPO_USE_PRECOMPILED_MODULES: "false"` into `Podfile.properties.json` during prebuild, so it survives regeneration. Everything Expo then links consistently — `ExpoModulesCore.framework` disappears from the app bundle because it is statically linked with the rest — and the app starts. A contract test keeps the setting in place.

The cost is slower clean iOS builds, which is the correct trade for an app that runs.

### What this cost to find, so nobody repeats it

Every cheap explanation was wrong, and each was ruled out with evidence rather than assumption:

- **Not autolinking.** `npx expo-modules-autolinking verify -v` reported *"Everything is fine"* and listed all 25 modules plus the local watch module.
- **Not a stale build.** It reproduced after `expo prebuild --clean`, fresh `pod install`, and `xcodebuild clean build`.
- **Not missing linkage.** `nm` found `AssetModule`, `One01WatchModule` and the sensors modules in the Release binary, and `ExpoModulesProvider.swift` listed all 50 modules.
- **Not a duplicate registry.** `ModuleRegistry` was defined only inside `ExpoModulesCore.framework`; the apparent duplicate symbols were just the two architectures of a fat simulator binary.
- **Not the JS bundle.** Android ran the identical bundle.
- **Not a missing dependency.** Adding `expo-asset` explicitly changed nothing, so that change was reverted rather than left as noise.

The signal that mattered was in the built artifact: the app bundle embedded some Expo modules as prebuilt XCFrameworks from `PODS_XCFRAMEWORKS_BUILD_DIR` while others were static. Mixed linkage, one broken registry.

## Remaining iOS gaps

Verified working on the simulator: the app launches, renders its full UI, switches controller modes, and reports `PHONE MOTION ACTIVE`.

Not yet working, and not to be described as working:

- **Deep links do not reach JavaScript.** `simctl openurl oneohone://pair?ticket=…` is accepted by the system — the log shows the scene receiving `UIOpenURLAction`, and `CFBundleURLSchemes` contains `oneohone` — but neither the `Linking` `url` event nor `getInitialURL()` populates the pairing field. The same deep link works on Android.
- **The Connect button does not fire.** Entering a valid ticket and tapping **Connect** leaves the state at `IDLE` with no error. Touch handling itself is fine: tapping a controller-mode card switches the mode and reveals its calibration actions.

Both are open. Pairing has therefore been proven on Android and in the browser, but not yet on iOS.

## Privacy and permissions

The native application has no account, analytics, cloud relay, microphone feature, or recording path. QR scanning asks for Camera permission only when opened. Motion sensing asks for Motion permission only after **Enable Motion**. Generated Android manifests explicitly remove `RECORD_AUDIO`; generated iOS configuration has Camera, Local Network and Motion descriptions but no Microphone description.

`ACTIVITY_RECOGNITION` and `BODY_SENSORS` are blocked too. `expo-sensors` bundles a pedometer, so the former arrives through manifest merging even though 101 reads only accelerometer, gyroscope, magnetometer and device motion; the brief keeps health data out of normal game operation, so both are removed and the built APK was verified to declare neither. The watch bridge adds no permission of its own — Watch Connectivity and the Wearable Data Layer need none.

Cleartext HTTP is permitted only because a strict-local Hub is commonly addressed as `http://192.168.x.x`. Gameplay leaves signaling for encrypted peer-to-peer WebRTC DataChannels after pairing. Pairing tickets expire and should be treated as temporary secrets.

## Develop and verify

Requirements are the root Node version plus Xcode/CocoaPods for iOS or Android Studio/SDK for Android.

```bash
npm install
npm run native:test
npm run native:typecheck
npm run native:doctor
npm run native:export
```

The native WebRTC package requires a custom development build; Expo Go cannot load it.

```bash
npm run native:ios
npm run native:android
```

`expo prebuild` generates `ios/` and `android/` locally from committed app configuration. Those generated directories are ignored so the native permission configuration remains reproducible and dependency updates do not create opaque generated-source diffs. iOS distribution still requires an Apple signing identity and provisioning profile; Android release artifacts require an application signing key. Neither signing requirement is bypassed by GitHub source distribution.

## Third-party controller layout

Any game package can publish a role such as:

```ts
{
  id: "navigator",
  label: "Navigator",
  playerId: "player-1",
  requiredCapabilities: ["touch"],
  layout: {
    title: "Navigator",
    accent: "#54F0C3",
    motion: { action: "steer", mode: "tilt" },
    layout: [
      { type: "joystick", action: "aim", label: "AIM" },
      { type: "button", action: "boost", label: "BOOST", emphasis: "primary" }
    ]
  }
}
```

The session host validates this public layout, assigns a compatible device, and sends it with `controller.configure`. The native app does not need to know the game ID or ship a game-specific screen.
