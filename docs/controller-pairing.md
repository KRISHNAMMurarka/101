# Controller pairing

## Phase 1 browser test

1. Launch 101 and open **Input Lab**.
2. Choose **Connect device**.
3. Open the provided controller link in another tab in the same browser profile.
4. The controller sends a capability hello; `@101/session` selects a compatible open role.
5. The host targets that device with `player.assign` and a JSON `controller.configure` panel.
6. Touch and optional motion events appear as normalized actions, axes, and vectors.

This test intentionally uses `BroadcastChannel`. It proves the game/input/protocol boundary but does not cross devices. Keep the controller open while switching games: its repeated capability hello lets the active host replace the panel without manual reconnection. Orbital Crew assigns separate pilot, weapons, shield, reactor, and emergency panels to up to five tabs.

Controller configuration is device-targeted. A phone ignores assignments, layouts, state readouts, and haptic commands addressed to another device. The host also replaces the device/player identity claimed by incoming realtime frames with the authoritative session assignment.

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

## LAN WebRTC target

The Hub creates a session and advertises it locally. A native or PWA Link client discovers the Hub or scans a session code, confirms the host, exchanges capabilities, and opens control plus realtime DataChannels. The connection screen reports LAN, relay, or manual-offline mode rather than implying every path is strictly local.

The next convenience layer advertises a Hub on the LAN and transfers the same versioned pairing descriptions automatically. QR encoding will wrap the implemented bounded text code; it does not change the transport contract.
