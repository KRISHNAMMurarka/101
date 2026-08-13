# Emulator and simulator QA

What has actually been *run*, as opposed to compiled. Build success and runtime success are different claims, and this project had been making only the first one for its native targets.

Recorded 2026-08-13 on macOS 15 (Apple silicon), Xcode 26.5, Android SDK 36, JDK 21.

## Result summary

| Target | Runs | Evidence |
| --- | --- | --- |
| Web launcher + Slashstorm | ✅ | Renders, plays, pairing panel issues real tickets |
| 101 Hub signaling | ✅ | `/v1/health` responds; reachable from the Android emulator |
| Browser 101 Link controller | ✅ | Reaches **LINKED · LAN WEBRTC · ONLINE**, role auto-synced |
| Android 101 Link | ✅ | Full UI, mode switching, deep-link pairing, protocol handshake |
| Wear OS 101 Link | ✅ | Launches, honest locality state, zero permissions on-device |
| iOS 101 Link | ❌ | Builds and links, throws before first render — see [known issue](native-link.md#known-issue-ios-fails-to-start-on-the-simulator) |
| watchOS 101 Link | — | Compiles for watchOS; not run (no simulator runtime, app target needs signing) |

## End-to-end pairing

The core promise — a controller pairing to a running game over the LAN with no cloud — was exercised for real:

1. `npm run dev` and `npm run hub`. The Hub reported `http://192.168.0.143:10101` and its health endpoint answered.
2. Opened Slashstorm, clicked **Connect sword**. The panel switched from `HUB OFFLINE` to **`LAN WEBRTC READY`** and issued a `101L2.…` ticket.
3. Opened the ticket as a controller. It reached **`LINKED`**, showed **`LAN WEBRTC · ONLINE`**, `SESSION 101R6A`, `SLASHSTORM · PLAYER-1`, and rendered the host-supplied **SWORD ONE** panel with blade, aim, slash and trigger.
4. The host updated its own status from `POINTER · TOUCH · GAMEPAD · KEYBOARD` to **`1 LINK CONTROLLER`**, and the button changed from *Connect sword* to *Add sword*.

That covers session creation, ticket issuing, join, WebRTC connection, capability-based role assignment, and JSON controller-layout delivery.

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
