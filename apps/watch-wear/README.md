# 101 Link — Wear OS companion

Relays wrist motion to 101 Link on the paired phone over the Wearable Data Layer. The watch never speaks the 101 protocol and never knows which game is running; the phone's existing Link session carries the input the rest of the way. See [watch companions](../../docs/watches.md) for the architecture and the wire format.

## Verify

```bash
npm run watch:wear:test
```

```bash
npm run watch:wear:build
```

Both resolve the Android SDK and JDK 21 automatically on a normal developer machine and explain exactly what to install when they cannot. The build writes `app/build/outputs/apk/debug/app-debug.apk`, installable on a Wear OS 3+ watch or emulator:

```bash
adb install app/build/outputs/apk/debug/app-debug.apk
```

JDK 21 specifically is required: the Android Gradle Plugin's toolchain rejects newer JDKs even when one is installed.

## Honest locality

The Wearable Data Layer selects its own transport and may carry data over the network rather than Bluetooth. "Connected" is therefore not the same claim as "local", so `WearLinkState` reports `verified-local` only when the OS reports the node as **nearby**, and `cloud-possible` otherwise. Gameplay still runs over a routed path if the player accepts it, but the UI says so rather than showing an indicator 101 cannot justify.

Only `MessageClient` is used. `DataClient` items are synced state — deduplicated, possibly delayed — which is wrong for a controller, so samples are dropped rather than buffered when no route exists.

The phone half must advertise the `one01_link` capability so the watch can find it without a hardcoded node ID.

## Signing

The release build deliberately configures **no** signing key. Publishing needs your own upload key, which never belongs in a repository. Generate one with `keytool`, keep it outside the checkout, and reference it from a local `keystore.properties` — both that file and `*.jks`/`*.keystore` are gitignored here.

## Privacy

The manifest declares no `BODY_SENSORS`, `ACTIVITY_RECOGNITION`, `RECORD_AUDIO`, `CAMERA` or location permission, and the built APK is verified to declare **zero** permissions. Motion sensors need no runtime permission on Wear OS, and 101 has no use for health, audio or identity data, so the app is built so that it cannot acquire any.
