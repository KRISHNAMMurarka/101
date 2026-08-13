# 101 Link protocol

Protocol version: `2`

## Channels

### Control

Reliable and ordered. It carries device hello/capabilities, player assignment, controller layout, calibration, pause, haptic commands, and latency pings.

### Realtime

Optimized for frequency and freshness. It carries normalized `InputFrame` values or compact sensor packets. Receivers discard frames whose sequence is not newer than the last accepted frame for that device.

## Transport contract

```ts
interface LinkTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendReliable(message: ControlMessage): void;
  sendRealtime(frame: InputFrame): void;
  onMessage(callback: (message: LinkMessage) => void): () => void;
}
```

`BroadcastChannelTransport` supports the same-browser controller test. `WebRTCTransport` implements real peer DataChannels with no hard-coded signaling dependency. The Network Lab exchanges compressed, versioned, integrity-checked offers and answers manually; `@101/pairing` automates the same exchange through a local Hub.

`MultiplexLinkTransport` lets one host accept BroadcastChannel plus any number of WebRTC peers. It learns the source route from each `hello`, so device-targeted configuration, haptic, and private role-state messages go only to that peer. Untargeted session controls may be broadcast.

## Automatic LAN signaling

The Hub creates an expiring `101L2` ticket containing the protocol version, session ID, LAN endpoint, one join secret, expiry, and transport. The QR contains the ticket—not an SDP blob or account identifier. Host administration uses a different secret, and each joined controller receives its own peer secret.

```text
POST /v1/sessions
POST /v1/sessions/:session/peers
GET  /v1/sessions/:session/peers/:peer/offer
PUT  /v1/sessions/:session/peers/:peer/answer
POST /v1/sessions/:session/peers/:peer/reconnect

GET  /v1/sessions/:session/host/peers
PUT  /v1/sessions/:session/host/peers/:peer/offer
POST /v1/sessions/:session/host/peers/:peer/reconnect
```

`AutomaticPairingHost` creates one WebRTC transport per peer. `SignaledLinkTransport` monitors it and sends gameplay over the peer DataChannels. A failed connection increments a signaling generation, disposes stale SDP, creates a fresh peer connection, and re-registers without requiring another scan. Old generations cannot overwrite new offers or answers.

## Capability hello

```json
{
  "type": "hello",
  "version": 2,
  "deviceId": "phone-a7f2",
  "device": "iphone",
  "capabilities": {
    "touch": true,
    "accelerometer": true,
    "gyroscope": true,
    "haptics": true
  }
}
```

Capabilities describe what a device can provide, not what permissions have already been granted. Permission requests occur only when a selected role needs that capability.

## Targeted role configuration

Protocol v2 makes asymmetric configuration explicit. `player.assign`, `player.wait`, `controller.configure`, `controller.state`, and `haptic` all carry a target `deviceId`. A controller ignores messages for other devices. `player.wait` explicitly places a connected surplus device on standby. `controller.configure` carries the active game, role, revision, theme, optional motion mapping, and a JSON element list containing buttons, sticks, D-pads, touch surfaces, or sliders.

The session host treats the identity inside realtime packets as untrusted. It accepts frames only from registered devices with an assignment and replaces the packet's `deviceId` and `playerId` with the authoritative values before the Input Bus sees it.

## Compact motion packet

The initial binary motion packet is 48 bytes:

| Offset | Type | Value |
| ---: | --- | --- |
| 0 | `u8` | protocol version |
| 1 | `u8` | packet type (`1` = motion) |
| 4 | `u32` | sequence |
| 8 | `f64` | source timestamp |
| 16 | `4 × f32` | quaternion x/y/z/w |
| 32 | `3 × f32` | acceleration x/y/z |
| 44 | `u32` | button bitset |

All multibyte fields use little-endian encoding. Future changes require a new version or packet type; do not silently reinterpret fields.

## WebRTC configuration

- Control: ordered, reliable DataChannel.
- Realtime: unordered with zero or very limited retransmits where supported.
- Signaling: authenticated automatic LAN QR exchange and manual serverless text transfer are both implemented.
- Reconnect: capability heartbeats, neutral release, standby promotion, role resynchronization, and fresh-generation WebRTC renegotiation are implemented.
