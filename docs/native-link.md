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

## Device identity must never be a single point of failure

The app's identity effect was three unguarded `await`s inside a `void`:

```ts
void (async () => {
  const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY);   // keychain
  const id = existing ?? `link-${Crypto.randomUUID()}`;
  if (!existing) await SecureStore.setItemAsync(DEVICE_ID_KEY, id); // keychain
  setDeviceId(id);
})();
```

Everything downstream is gated on `deviceId`: the session, deep-link handling, **Connect**, and the motion controller. So a single keychain failure left the app looking fine and doing nothing — buttons dead, links ignored, and `enableMotion` reporting "Motion on" because `motionRef.current?.start()` optional-chains past a controller that was never constructed. The rejection went into `void`, so nothing was logged and nothing was shown.

Identity is now guarded, falls back to an in-memory id, and reports the loss of persistence rather than the loss of the app. **A controller that forgets itself still plays.** A contract test keeps the guard in place.

`expo-dev-client` also moved from `dependencies` to `devDependencies`. It is a development tool, and on iOS it registers an AppDelegate subscriber whose `_handleExternalDeepLink` stores the URL in its own pending registry and returns `true` when no app is running — which short-circuits `super.application(...) || RCTLinkingManager.application(...)` so React Native never sees it. Shipping it in production is both bloat and a hazard. (Excluding it from autolinking did **not** on its own fix the deep link here, so it is not the whole story — see below.)

## Solved: iOS pairing, and why it looked like three separate bugs

iOS deep links, the Connect button and the motion toggle all appeared broken in different ways. They were one fault:

```text
KeyChainException: A required entitlement isn't present.
   (at ExpoSecureStore/SecureStoreModule.swift)
```

`expo-secure-store` is keychain-backed on iOS, and a build made with signing disabled — which is how simulator builds are produced here — carries no entitlements at all, so every call throws. Three unguarded calls turned that single throw into three unrelated-looking symptoms:

| Unguarded call | Symptom |
| --- | --- |
| `getItemAsync(DEVICE_ID_KEY)` in the identity effect | `deviceId` never set, so the session, deep links, Connect and motion were **all** gated off. `enableMotion` still reported "Motion on" because `motionRef.current?.start()` optional-chains past a controller that was never built. |
| `getItemAsync(LAST_PAIRING_KEY)`, one line after `Linking.getInitialURL()` | The launch URL was read **correctly**, then discarded when the next line threw and the `void`-ed async function rejected. iOS Linking was never at fault. |
| `setItemAsync(LAST_PAIRING_KEY)` after a successful `connect()` | A connected session reported as failed, because remembering the pairing sat inside the same `try`. |

Every one of them rejected into a bare `void`, so nothing was logged and nothing was shown — which is why this cost two sessions to find. What finally located it was making the failure visible: once identity degraded gracefully instead of vanishing, the app printed the keychain exception on its own screen.

The fixes:

- Identity falls back to an in-memory id and says persistence was lost. **A controller that forgets itself still plays.**
- `rememberPairing`, `forgetPairing` and `readSavedPairing` swallow storage failures. Convenience must never gate the link.
- `ios.entitlements` now declares `keychain-access-groups`, so secure storage genuinely works in signed builds rather than merely failing quietly.

Verified: an iOS Release build, cold-launched via `oneohone://pair?ticket=…`, reads the ticket and reaches **Connecting…** — the first time iOS moved past `IDLE`. It holds there for the same simulator WebRTC/NAT reason Android does, which is an environment limit, not a defect.

Three contract tests hold this shut: identity must degrade, only the guarded effect may touch `SecureStore` directly, and the keychain entitlement must stay declared.

## Solved: two thumbs at once

Holding a stick and pressing a button dropped the stick to neutral, so no layout combining a pad
with a button was actually playable — which is every gamepad preset, and the whole premise of the
landscape two-thumb layout.

React Native has exactly **one responder for the entire app**, and `PanResponder`'s default answer
when another view asks for it is *yes*:

```js
// react-native/Libraries/Interaction/PanResponder.js
onResponderTerminationRequest(event) {
  return config.onPanResponderTerminationRequest == null ? true : /* … */;
}
```

Every pad and slider used that default. A `Pressable` button claiming the responder therefore
terminated the stick, `onPanResponderTerminate` fired, and `release()` sent `(0, 0)` mid-movement.
The controller looked perfectly correct in code review and in any single-finger test.

The fix has two halves and needs both:

- **Pads and sliders refuse to hand over the responder** — `onPanResponderTerminationRequest: () => false`.
  On its own this would only invert the bug, leaving buttons dead while a stick is held.
- **Buttons stop competing for it.** They are plain views using `onTouchStart`/`onTouchEnd`/
  `onTouchCancel`, which are delivered to the view under the finger without any responder
  negotiation. `accessibilityRole="button"` keeps them buttons to a screen reader.

`onTouchCancel` matters as much as the other two: a cancelled touch that never released would latch
its action on forever.

A contract test asserts both halves stay in place, since the failure is invisible to review.

`PanResponder.create()` is still called per render, which looks wasteful. It was measured rather
than assumed: rebuilding it costs a fraction of a microsecond against a 16 ms frame, and hoisting it
into a ref meant writing to that ref during render, which the lint rules correctly reject. The
allocation is not worth the hazard.

**Not yet verified on hardware.** The reasoning is confirmed against the React Native source in this
repo, and the logic is locked by a test, but genuine simultaneous multi-touch cannot be exercised on
a simulator — both iOS and Android emulators synthesise only mirrored two-finger pinch gestures, not
two independent touch points. This needs one pass on a real phone.

## Solved: the host used to expire a controller that was still being played

The host reclaimed any device it had not heard a `hello` from within `deviceTimeoutMs` (6 s).
Liveness was refreshed **only** by the handshake — not by input, not by the heartbeat:

```ts
if (message.channel === "control" && message.payload.type === "hello") { /* … lastSeenAt … */ }
if (message.channel !== "realtime") return;   // a `ping` fell through here and was discarded
```

The browser client survived this by accident: it re-sends `hello` on a 1.6 s timer. The native app
sends `ping` instead, so its device record went stale while the player was actively holding the
controller, and the role was reclaimed six seconds after connecting.

Nothing caught it because no test advanced a clock past the timeout with a live device, and no
emulator run ever completed a WebRTC connection — pairing stops at `Connecting…` behind the
emulator NAT, which is well short of six seconds of play.

Now:

- **Input refreshes liveness.** Sending a frame is proof the controller is there.
- **`ping` refreshes liveness and is answered with `pong`.** The reply is what makes the round trip
  measurable at the controller; without it the native latency readout could never populate.
- **`ping` carries an optional `deviceId`**, because the host otherwise cannot tell whose beat it
  is on a multiplexed transport. Optional, so a client predating the field still validates.

A regression test drives a device past the timeout while it plays and then pings, and asserts a
genuinely silent device is still reclaimed. Removing either half of the fix fails it.

## Remaining iOS gaps

- **Pairing has not completed end to end on iOS.** The deep link is read and the app reaches
  `Connecting…`, but the simulator cannot finish a WebRTC connection through its NAT — the same
  limit that stops the Android emulator. Confirming a completed pair needs a real device on the LAN.
- **QR scanning is untested here**, because the simulator has no camera. The camera permission
  prompt appears with the correct copy, so the path up to capture is wired.
- The watchOS app target still has to be created and signed in Xcode; that is an Apple requirement,
  not a gap this repository can close.

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
