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

## Known issue: iOS fails to start on the simulator

**Android runs; iOS builds but does not start.** Running the app on emulators surfaced this — earlier milestones only verified that iOS *compiled*.

On launch the app throws before the first render:

```text
[runtime not ready]: Error: Cannot find native module 'ExpoAsset'
```

What has been established:

- **It is not the watch bridge.** `ExpoAsset` is unrelated to `modules/one01-watch`, and `One01WatchModule` links correctly (6 symbols in the built binary).
- **It is not a stale build.** It reproduces after `expo prebuild --clean`, a fresh `pod install`, and `xcodebuild clean build`.
- **It is not missing linkage.** `nm` on the Release binary finds `AssetModule` (4 symbols), `One01WatchModule` (6), and the sensors modules (123). `ExpoModulesProvider.swift` lists all 50 modules including `ExpoAsset`, and the provider is compiled into the app target.
- **It is not the JS bundle.** Android runs the identical bundle correctly through Metro.
- **It is not a missing dependency.** Adding `expo-asset` as an explicit dependency changed nothing, so that change was reverted rather than left as noise.

So the module classes are present and linked but are not *registered* with the Expo module registry at runtime, on iOS only. The remaining suspects are the Expo modules registry initialization order in this SDK 57 + React Native 0.86 configuration, or the dynamic-framework/static-library split visible in the built app (`ExpoModulesCore` ships as a dynamic framework while the module classes are statically linked into the main binary).

The Debug build fails differently and consistently: `unsanitizedScriptURLString = (null)`, meaning the dev launcher never receives a Metro URL even when the packager is reachable and the `oneohone://expo-development-client` deep link is delivered. Both symptoms point at the same iOS-side initialization problem.

This is tracked as open. Do not describe iOS 101 Link as working until it launches to its own UI on a device or simulator.

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
