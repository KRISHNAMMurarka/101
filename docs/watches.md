# Watch companions

101 treats a watch as an **extension of 101 Link**, not as a separate game system. The watch never speaks the 101 protocol, never pairs with a Hub, and never knows which game is running. It relays wrist motion to the phone it is already paired with, and the phone's existing Link session carries it the rest of the way.

```text
Apple Watch ──WatchConnectivity──▶ iPhone ──┐
                                            ├── 101 Link ──▶ 101 Protocol ──▶ 101 Engine
Wear OS     ──Wearable Data Layer─▶ Android ┘
```

That shape is deliberate. A watch has a small battery, an intermittent link and no way to reach a LAN Hub directly. Making it a first-class network peer would mean reimplementing pairing, reconnect and session identity on the most constrained device in the system. Relaying through the phone reuses all of it.

## What a game sees

Nothing watch-specific. `@101/adapter-watch` publishes ordinary `watch-motion` frames:

| Kind | Names |
| --- | --- |
| Actions | `watch.twist`, `watch.flick`, `watch.strike`, `watch.raise`, `watch.lower`, `watch.tap`, and level-valued `watch.raised` |
| Axes | `wristRoll`, `wristPitch`, `wristYaw`, `crown`, `crownDelta` |
| Vectors | `wrist` (roll, pitch, yaw together) |

A game binds `watch.flick` exactly as it binds a gamepad button. Because the Input Bus merges sources, a watch can supply one control while a phone supplies another — the brief's "phone tracks orientation while watch detects rapid wrist movement" case needs no game code at all.

### Wrist gestures are not phone gestures

A phone is gripped and swung from the shoulder; a watch pivots on the forearm. Raw magnitude alone produces constant false positives from ordinary arm movement, so every gesture is edge-triggered with a cooldown, `twist` reads rotation about the forearm axis specifically, and `raise`/`lower` use separate thresholds so a wrist resting near the boundary cannot chatter. A flick suppresses the twist that shares its motion, so one movement never fires two actions.

The Digital Crown and the Wear OS rotary bezel both report unbounded travel. `WatchCrownTracker` turns that into a bounded `crown` dial plus a per-frame `crownDelta`, discarding overshoot past the limits so a small reversal moves the dial immediately instead of first unwinding travel the wearer can no longer see.

## Honest transport locality

This is the part of the watch work that required the most care, and the brief is explicit about why.

Apple's Watch Connectivity moves data between a watch and its **own paired iPhone**. An interactive `sendMessageData` to a reachable counterpart is genuinely device-to-device.

Google's Wearable Data Layer is different. Google documents that it selects its own transport and may carry data over the network rather than Bluetooth depending on connectivity. "Connected" is therefore **not** the same claim as "local".

101 resolves this by reporting what it can actually confirm:

| Locality | Meaning |
| --- | --- |
| `verified-local` | Proven device-to-device. watchOS: the paired counterpart is reachable. Wear OS: the node reports `isNearby`. |
| `assumed-local` | Reserved for routes believed local but unproven. |
| `cloud-possible` | Wear OS node is connected but **not** nearby, so the Data Layer may route it through Google's network. |
| `unknown` | No route established — not paired, app not installed, or not reachable. |

A connected-but-distant Wear OS node is reported as `cloud-possible`, never upgraded on optimism. Gameplay still runs over such a route if the player accepts it — a usable controller beats a refused one — but the UI says so plainly instead of showing a reassuring indicator 101 cannot justify. `isStrictlyLocal()` is the check a mode should use when it promises that nothing leaves the room.

Missing proximity information is treated as unproven rather than as permission to assume the optimistic answer.

## Wire format

Both watch apps encode the same 53-byte little-endian payload, and `decodeWatchPayload()` in `@101/adapter-watch` decodes it:

```text
 0      magic 0x31
 1      version
 2..3   sequence            u16
 4..7   milliseconds        u32   (since the relay started, not wall clock)
 8..23  orientation x,y,z,w f32 x4
24..35  acceleration x,y,z  f32 x3 (g, gravity removed)
36..47  rotationRate x,y,z  f32 x3 (degrees/second)
48..51  crown travel        f32    (detents, monotonic)
52      buttons bitfield    u8     (bit 0: tap)
```

Roughly 50 samples per second cross a small-MTU Bluetooth link, so the realtime path spends its bytes on values rather than repeated JSON key names. One layout across both platforms means the phone decodes either watch with no per-platform branch. Three independent test suites — Swift, Kotlin and TypeScript — pin the same offsets, so a change on one platform fails a build instead of silently producing garbage wrist input.

Every decoder returns "no sample" rather than throwing on a short, misaligned, foreign or non-finite packet. A relay has to tolerate junk on the wire without taking the controller down, and a `NaN` quaternion would poison the motion pipeline downstream.

### Sampling policy

Sensors deliver far faster than the link needs, so both relays rate-limit to about 50 Hz while moving and 6 Hz at rest. Two exceptions matter:

- **Settling is always sent.** The transition from moving to still must reach the game, or it keeps applying the last motion after the wrist has already stopped.
- **Taps are never rate-limited away.** A tap is a discrete intent, not a sample of a continuous signal.

Samples are dropped rather than buffered when no route exists. Queued delivery (`transferUserInfo`, `updateApplicationContext`, `DataClient`) is deliberately unused: those arrive long after the moment they describe, which is worse than nothing for a controller.

## Privacy

Neither app requests health data, and neither can acquire it later:

- **watchOS** never imports HealthKit and requests no health authorization. It reads `CMDeviceMotion` only.
- **Wear OS** declares no `BODY_SENSORS`, `ACTIVITY_RECOGNITION`, `RECORD_AUDIO`, `CAMERA` or location permission. The built APK is verified to declare **zero** permissions.

Wrist frames carry motion quantities only — no wearer identity, no serial numbers, no heart rate. A test asserts that no emitted key contains health or identity terms. The brief allows heart-rate-derived modes only with explicit permission and real usefulness; no such mode exists here, so no such data is collected.

## Building

### Apple Watch

The shared logic lives in a Swift package that builds and tests on any Mac:

```bash
npm run watch:ios:test
```

`One01WatchCore` is platform-independent on purpose — the payload, sampling policy and link-state model compile and unit-test on macOS in seconds. `apps/watch-ios/App/` holds the watchOS-only shell: SwiftUI, `CMMotionManager` and `WCSession`.

To verify it compiles for the watch itself:

```bash
npm run watch:ios:check
```

**To run it on hardware**, create a watchOS App target in Xcode, add `apps/watch-ios/App/*.swift` to it, and add the local `One01Watch` package as a dependency. Then set your own signing team. This step cannot be skipped or bundled: Apple requires a registered Apple Developer account and a provisioning profile tied to your team, and no repository can remove that requirement. The watch app must be embedded in an iOS host app whose bundle identifier matches the watch app's prefix; for 101 that host is `apps/controller-native`.

### Wear OS

```bash
npm run watch:wear:test
npm run watch:wear:build
```

Both require `JAVA_HOME` on JDK 21 and `ANDROID_HOME` on an Android SDK with API 36. The build produces `apps/watch-wear/app/build/outputs/apk/debug/app-debug.apk`, installable on a Wear OS 3+ watch or emulator with `adb install`.

The release build deliberately configures **no** signing key. Publishing needs your own upload key, which never belongs in a repository. Generate one with `keytool`, keep it outside the checkout, and reference it from a local `keystore.properties` that stays untracked.

The phone half must advertise the `one01_link` capability for the watch to find it without hardcoding a node ID.

## The phone side

`apps/controller-native/modules/one01-watch` is a local Expo module that receives the payload on the phone. The two platforms use entirely different frameworks — Watch Connectivity on iOS, the Wearable Data Layer on Android — but both deliver the same bytes, so the module exposes one JavaScript interface and reports companion state without deciding what it means:

```ts
const controller = new WatchController(bridge, { onFrame: (frame) => session.send(frame) });
await controller.start(playerId);
controller.strictlyLocal; // false until the OS actually proves a direct route
```

`WatchController` in `apps/controller-native/src/watch-controller.ts` owns the glue. Three behaviors matter:

- **Wrist input joins the phone's own player.** The phone already has a session, a device identity and a transport, so the watch adds a *source*, not a second peer. That is what makes "phone tracks orientation while the watch detects rapid wrist movement" work with no game code.
- **A malformed payload is dropped, never fatal.** The count is exposed as `rejectedSamples` and the operator is told once — not once per packet — so a version mismatch is diagnosable instead of looking like a dead watch.
- **Losing the route releases held controls.** A watch walking out of range mid-game cannot leave `watch.flick` applied, the same guarantee the HID, Bluetooth and Serial adapters make.

Bytes cross the native bridge base64-encoded. It costs about a third more size on a link that is already local and buys a single code path, because that is the only binary representation both Expo platforms pass reliably.

On Android the phone advertises the `one01_link` capability from the module's own resources, so the watch finds it through `CapabilityClient` instead of hardcoding a node ID that breaks the moment the user pairs a different phone.

## Current limits

Stated plainly, because the brief asks for honesty over polish:

- **Neither watch app has been run on physical watch hardware in this repository.** The Wear OS app *has* been run on a Wear OS 3 emulator: it launches, reports `UNKNOWN` locality with "No paired phone." because no companion exists there, correctly disables **Start**, and `dumpsys` confirms it declares zero permissions on-device. That exercises the honest-locality contract but not a real watch-to-phone relay, which needs two paired devices.
- The watchOS app has not been run at all. Its sources compile against the real watchOS SDK, but no watchOS simulator runtime is installed here and the app target still needs to be created and signed in Xcode.
- The watchOS app target still has to be added in Xcode and signed with your own team, as described above. That is an Apple requirement, not a gap this repository can close.
- watchOS relaying is foreground-only. Background wrist input would need an extended runtime session, which costs battery and is not justified for a controller the player is actively using.
