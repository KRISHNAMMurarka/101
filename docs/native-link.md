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

Games never import React Native, Expo, WebRTC, camera, or sensor APIs. A third-party game declares a controller role and layout through the public SDK. The existing 101 host sends that layout and native Link returns ordinary `InputFrame` actions, axes and vectors.

## Privacy and permissions

The native application has no account, analytics, cloud relay, microphone feature, or recording path. QR scanning asks for Camera permission only when opened. Motion sensing asks for Motion permission only after **Enable Motion**. Generated Android manifests explicitly remove `RECORD_AUDIO`; generated iOS configuration has Camera, Local Network and Motion descriptions but no Microphone description.

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
