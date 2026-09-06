# Emulator and simulator QA

What has actually been *run*, as opposed to compiled. Build success and runtime success are different claims, and this project had been making only the first one for its native targets.

Recorded 2026-08-13 on macOS 15 (Apple silicon), Xcode 26.5, Android SDK 36, JDK 21.

## Result summary

| Target | Runs | Evidence |
| --- | --- | --- |
| Web launcher + Slashstorm | ✅ | Renders, plays, pairing panel issues real tickets |
| 101 Hub signaling | ✅ | `/v1/health` responds; reachable from the Android emulator |
| Browser 101 Link controller | ✅ | Reaches **LINKED · LAN WEBRTC · ONLINE**, role auto-synced |
| Android 101 Link | ✅ | Full UI, all 8 presets, deep-link pairing, protocol handshake |
| Sensors / gyroscope | ✅ | Injected accel, gyro and orientation flow through filtering and calibration |
| Engineering Labs | ✅ | Motion, Vision, Hardware, Network, Controller all render and respond |
| Wear OS 101 Link | ✅ | Launches, honest locality state, zero permissions on-device |
| iOS 101 Link | ✅ | Launches, renders, switches modes, and cold-launches from a deep link straight to `Connecting…`. Like Android, it cannot finish WebRTC through the simulator's NAT. |
| watchOS 101 Link | — | Compiles for watchOS; not run (no simulator runtime, app target needs signing) |

## End-to-end pairing

The core promise — a controller pairing to a running game over the LAN with no cloud — was exercised for real:

1. `npm run dev` and `npm run hub`. The Hub reported `http://192.168.0.143:10101` and its health endpoint answered.
2. Opened Slashstorm, clicked **Connect sword**. The panel switched from `HUB OFFLINE` to **`LAN WEBRTC READY`** and issued a `101L2.…` ticket.
3. Opened the ticket as a controller. It reached **`LINKED`**, showed **`LAN WEBRTC · ONLINE`**, `SESSION 101R6A`, `SLASHSTORM · PLAYER-1`, and rendered the host-supplied **SWORD ONE** panel with blade, aim, slash and trigger.
4. The host updated its own status from `POINTER · TOUCH · GAMEPAD · KEYBOARD` to **`1 LINK CONTROLLER`**, and the button changed from *Connect sword* to *Add sword*.

That covers session creation, ticket issuing, join, WebRTC connection, capability-based role assignment, and JSON controller-layout delivery.

## Sensors, gyroscope and the motion pipeline

The Android emulator can inject real sensor values, which exercises the whole pipeline rather than a mock. `adb emu sensor status` confirms acceleration, gyroscope, magnetic field and orientation are all injectable.

With **Sensor Lab** selected and motion enabled, injected values arrived correctly end to end:

| Injected | Reported in Sensor Lab |
| --- | --- |
| `acceleration 0:9.81:0` | `ACCEL 0.0 -9.8 -0.0` |
| `gyroscope 1.5:0:0` (rad/s) | `GYRO 0.0 0.0 85.9` (deg/s) — the exact conversion |
| `acceleration 4:8:1` | `ACCEL -0.2 -11.1 0.7`, `ROLL 169.1° → -62.6°`, `YAW 169.1° → -50.1°` |

Sensitivity, dead zone and smoothing controls are present and live (1.00 / 0.04 / 0.22), and the panel states the boundary plainly: *"Filtering, calibration and gesture recognition run on this device. Only normalized numbers and actions are sent to the paired game."*

All eight controller presets are reachable and switch the panel: Classic Controller, Motion Wand, Steering Wheel, Tilt Board, Touch Surface, Trigger Controller, Motion Detector, Sensor Lab. Selecting a motion preset reveals **Enable motion** and **Set neutral**; enabling it flips the control to **Motion on** and the wand reports **PHONE MOTION ACTIVE**.

### Two defects this found

**Android motion was completely dead, and the previous milestone caused it.** Blocking `ACTIVITY_RECOGNITION` for privacy also blocked the permission `expo-sensors` requests inside `DeviceMotion.requestPermissionsAsync()` on API 29+, so every motion mode failed with *"Motion permission was not granted"*. Android sensors need no runtime permission at all, so the request is now skipped there and still made on iOS, which genuinely requires it. Both the privacy property and the feature are kept.

**Sensor Lab reported `1000000 Hz`.** Two readings sharing a timestamp hit a 1 ms floor and `1000/0.001` was printed as fact. Repeated and backwards timestamps are now skipped rather than clamped, long stalls no longer masquerade as slow sampling, the interval is smoothed, and the result is capped. It now reads a steady 19–20 Hz.

Both carry regression tests.

## Engineering Labs

All six render and respond:

| Lab | Verified |
| --- | --- |
| Motion Lab | Keyboard simulation drives the real pipeline — `ROLL -74.1°`, live quaternion, raw vs filtered acceleration |
| Vision Lab | Body simulation produced `BODY X -0.58`, `CROUCH 0.36`, 2 active actions, 19 input frames |
| Hardware Lab | WebHID, Web Bluetooth and Web Serial all report **AVAILABLE**, secure context yes, permission **prompt** — nothing auto-granted |
| Network Lab | Manual offline WebRTC UI with latency, jitter, loss, path and the honest no-STUN/TURN locality note |
| Controller Lab | Layout presets, schema-boundary note, live normalized frame inspector |
| Input Lab | Covered by the rendered-route suite |

Note when testing these by script: both simulation labs update through React state, so a value read in the same tick as a dispatched key event still shows the previous render. Read after a tick, or the lab looks broken when it is not.

## Android 101 Link

Installed the debug APK on a Pixel Fold API 36 emulator with `adb reverse tcp:8081` so Metro was reachable.

- Launches into the full controller UI: **PRIVATE BY DEFAULT**, *Connect to 101 Hub*, and the controller-mode carousel.
- Tapping **Steering Wheel** switched the active mode and swapped the panel below to a steering control, and the motion-only **Enable motion** / **Set neutral** actions appeared. Mode switching works.
- The `oneohone://pair?ticket=…` deep link was accepted: status went `IDLE` → **`CONNECTING`** and a **Disconnect** action appeared.

### Why pairing does not complete on the emulator

`logcat` shows the 101 protocol working correctly end to end:

```text
setRemoteDescription OK      ← received the host's offer
createAnswer                 ← produced its answer
setLocalDescription OK
onIceGatheringChange COMPLETE
…17s later…
close                        ← generation-based reconnect retries
```

Signaling, the offer/answer exchange and ICE gathering all succeed. What fails is ICE *connectivity*: the emulator sits behind Android's userspace NAT on `10.0.2.16`, and its candidates are not routable from the host browser. This is a well-known Android emulator limitation for WebRTC, not a defect in 101 — and the retry visible in the log is the reconnect logic behaving correctly.

The same ticket, same Hub and same host connect immediately from a browser controller, which is what establishes that the pairing path itself is sound. Verifying phone WebRTC end to end needs a real device on the same LAN.

## Wear OS 101 Link

Created a Wear OS 3 (API 34) AVD and installed the debug APK.

- Launches and renders its whole UI.
- Reports **`UNKNOWN`** with **"No paired phone."** and leaves **Start** disabled — exactly the contract from `WearLinkState`. With no companion, it refuses to guess a locality rather than showing an optimistic indicator.
- `adb shell dumpsys package com.oneohone.wear` lists **no requested permissions at all**, confirming the privacy claim on-device rather than only in the manifest.

A real watch-to-phone relay needs two paired devices and has not been tested.

## Reproducing

```bash
npm run dev
```

```bash
npm run hub
```

Then open the launcher, pick a game, and use **Connect device**. For the Android controller:

```bash
npm run native:android
```

For the Wear OS watch:

```bash
npm run watch:wear:build
```

```bash
adb -s <wear-emulator> install -r apps/watch-wear/app/build/outputs/apk/debug/app-debug.apk
```

## Launcher payload (2026-08-14)

Measured against the production build with `vinext start`, summing every JS chunk the homepage
requests:

| | Chunks | JS transferred |
| --- | --- | --- |
| Static imports | 36 (10 game chunks preloaded) | **2843 KB** |
| Lazy surfaces | 19 (0 game chunks) | **462 KB** |

The important property is not the 84% cut, it is the slope: the old cost grew with the catalog, so
a thousand games meant a thousand games' worth of JavaScript before the first card painted. It is
now flat.

Verified in a browser rather than only in the build output: the homepage loads no `*Game-*.js`,
clicking **Play Slashstorm** fetches `SlashstormGame-<hash>.js` on demand, and the game canvas
mounts and runs.

One trap worth recording. An earlier measurement showed a broken page and a failing chunk, which
looked like the lazy split had broken hydration. It had not — three `vinext` processes were alive
and a stale one was answering on port 3000 with an asset manifest from a previous build, so the
HTML referenced a chunk hash that no longer existed. `pkill -f vinext` and a clean restart before
measuring; check `ps aux | grep vinext` returns one process when a built asset 404s or hangs.

## Two-thumb play, verified on a real iOS runtime (2026-09-06)

This was the last thing in the project marked "reasoned but unverified on hardware", because
simulators were believed to synthesise only mirrored pinch. They do not: the simulator control API
accepts an arbitrary two-finger path, which is exactly what the React Native responder bug needed.

The bug was that React Native has one responder for the whole app, and `PanResponder` answers *yes*
by default when another view asks for it — so pressing a button while holding a stick terminated the
stick and snapped its vector to neutral. Every gamepad preset was affected.

Method: a Release build on iPhone 17 Pro (iOS 26.5), Classic Controller panel, with the control
callbacks writing to an on-screen ring buffer so the sequence survives the gesture. Finger 1 holds
and drags the AIM stick; finger 2 lands on button A and stays down.

```
B buttonA=true  |  B buttonA=false          ← baseline: a lone tap is seen
V aim -0.71,-0.71                            ← finger 1 engages the stick
B buttonA=true                               ← finger 2 presses A while the stick is held
V aim -0.08,-0.58                            ← the stick keeps tracking
V aim -0.18,-0.88
V aim -0.02,-0.58
V aim 0.00,0.00                              ← released on lift
B buttonA=false
```

The stick continued producing vectors *after* `buttonA=true`. Under the original bug the press would
have been followed immediately by `V aim 0.00,0.00` and nothing further, because the responder was
terminated. Both halves of the fix are therefore confirmed against real React Native: pads refuse to
surrender the responder, and buttons take raw touch events so they never ask for it.

Two things this cost, worth recording so the next person does not repeat them. The Debug build fails
to link — `expo-dev-launcher` tries to link `SwiftUICore` directly, which Apple disallows — so use
`--configuration Release`. And `console.log` does not reach the device log from a Release build, so
observation has to be rendered on screen rather than logged.

The test build forced the play surface open (`playing = true`) and instrumented the control
callbacks, because the panel is otherwise only reachable through a completed pairing, which the
simulator cannot finish. That harness was reverted immediately; the responder behaviour under test is
in `controls.tsx` and is unaffected by why the panel is shown.

## Controller audio on a real iOS runtime

`expo-audio` instantiates an `AVPlayer` and loads the bundled `private-cue.wav` at launch on the
simulator, with no error:

```
AVPlayer _insertItem:afterItem: currentItem KVO: P/TN called with I/JKN.01
AVPlayer _setRate:rateChangeReason:...
```

That rules out the module or the asset being broken on device, which was a genuine unknown.

**It is not proof of audibility.** No cue was delivered — that needs a paired host, and the simulator
cannot complete WebRTC — and nobody has listened. The honest status stays: the path is wired, tested
at every seam, and now known to construct a working player on iOS; whether a player actually hears it
still needs a person and a phone.
