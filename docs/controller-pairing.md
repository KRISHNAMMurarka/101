# Controller pairing

## Automatic LAN QR

Start the web runtime and local Hub in two terminals:

```bash
npm run dev -- --host 0.0.0.0
npm run hub
```

Open the launcher using the printed LAN address, choose **Connect device**, and scan the QR. The browser controller receives a short-lived ticket, joins the local signaling service, and establishes direct WebRTC control/realtime DataChannels. The Hub does not relay gameplay frames.

The host keeps a multiplexed session transport alive across game transitions. Slashstorm can assign a sword, TiltDrift can replace it with a steering panel, and Orbital Crew can replace it with an asymmetric station without rescanning. WebRTC failure or controller reload negotiates a fresh generation automatically.

If the Hub runs on a non-default address, add `?hub=http://HOST:PORT` to the launcher once. The browser stores that local endpoint. On HTTPS pages, configure a trusted HTTPS Hub endpoint; browsers block mixed active content.

## Installable 101 Link PWA

Open `/controller` in a PWA-capable browser and use **Install 101 Link** when the browser offers it. The standalone app keeps a durable local device ID, accepts a full pairing URL or `101L2` ticket, and renders every host-provided controller layout.

## Native 101 Link

The Expo/React Native app in `apps/controller-native` uses the same `101L2` ticket, HTTP signaling contract, control messages, realtime `InputFrame` schema, and host-defined controller layout as the PWA. Scan the host QR or paste its ticket. The native app joins the local Hub and then moves gameplay traffic onto a direct WebRTC connection with reliable control and unordered zero-retransmit realtime channels.

The app is not game-specific. `controller.configure` replaces its current surface atomically, releases controls held by the previous role, and renders buttons, shoulders, analog triggers/buttons, D-pads, tuned sticks, touch surfaces, sliders, and motion mappings from validated JSON. Placement and handedness are advisory, with a player-facing side swap. Switching games does not require another scan.

For strict offline manual pairing, paste or scan the host's `101C2`/`101J2` offer instead of a LAN ticket. Native Link produces an answer that can be copied back to the host. No signaling service is used in this mode.

Native development requires a development build because DataChannels use a native WebRTC module:

```bash
npm run native:ios
# or
npm run native:android
```

See [native Link development](native-link.md) for verification and signing details.

The service worker caches the controller shell, manifest, icon, and same-origin runtime assets for installed/offline startup. Requests containing a `pair` query are always network-only: the temporary join secret and its server-rendered response are never stored in Cache Storage. An offline shell can open without a host, but live gameplay naturally requires the LAN host to be reachable.

## Same-browser diagnostic

1. Launch 101 and open **Input Lab**.
2. Choose **Connect device**.
3. Open the provided controller link in another tab in the same browser profile.
4. The controller sends a capability hello; `@101/session` selects a compatible open role.
5. The host targets that device with `player.assign` and a JSON `controller.configure` panel.
6. Touch and optional motion events appear as normalized actions, axes, and vectors.

This path intentionally uses `BroadcastChannel`. It proves the game/input/protocol boundary without a Hub. Keep the controller open while switching games: the active host replaces its panel without manual reconnection. Slashstorm assigns two independent sword tabs, TiltDrift assigns one driver, BodyDodge assigns one movement panel, Orbital Crew assigns separate pilot, weapons, shield, reactor, and emergency panels to up to five tabs, BeatForge replaces that panel with a motion performer, GravityStack assigns gravity first and then a separate builder panel, Spellcaster maps physical motion gestures to the same semantic spells as its camera/keyboard controls, and Echo Maze sends precise clues only to the assigned scanner.

Every controller tab has an independent session identity. Before a new panel is installed, Link publishes a neutral frame for the old role so a held button or stick cannot leak into the next game. When more devices are connected than the current game can use, surplus devices display **Standby** instead of pretending to be assigned. If an active tab closes or stops heartbeating, the host expires it and promotes a compatible standby controller automatically.

Controller configuration is device-targeted. A phone ignores assignments, layouts, state readouts, and haptic commands addressed to another device. Echo Maze uses this boundary for role-private companion information: the host sends bearing, distance, signal, and echo proximity only to the assigned scanner. The host also replaces the device/player identity claimed by incoming realtime frames with the authoritative session assignment.

Motion permission is requested only when **Enable motion** is pressed. If permission is denied or unavailable, the sword touch surface and steering buttons/pedals remain usable.

Open `/controller-lab` to edit and validate a controller layout directly. The Lab applies the schema to session `CTRL01` and shows the actions, axes, and vectors emitted by the connected controller.

## Manual offline WebRTC

1. Open `/network` on both browsers.
2. Choose **Create host offer** on the game host and **Join as controller** on the other device.
3. Copy the compressed offer to the controller.
4. The controller validates it and creates an answer.
5. Copy the answer to the host.
6. Both peers report the selected candidate path, latency, jitter and realtime loss.

The lab supplies no STUN, TURN, signaling, account, or relay service. That preserves strict locality but means some network/browser combinations will not connect.

## Security properties

- Join, host administration, and each peer use different high-entropy bearer secrets.
- Tickets expire and contain no account identity.
- Offer/answer generations reject stale reconnect data.
- Games never see signaling or transport APIs.
- Targeted role state is routed only to the peer that registered that `deviceId`.
- The Hub exchanges pairing descriptions; it is not a gameplay relay.
