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

`BroadcastChannelTransport` supports the same-browser controller test. `WebRTCTransport` implements real peer DataChannels with no hard-coded signaling dependency: the current Network Lab exchanges compressed, versioned, integrity-checked offers and answers manually. Native bridges and automated LAN signaling will implement the same contract.

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
- Signaling: manual offline text transfer is implemented; LAN discovery and QR encoding remain follow-up layers.
- Reconnect: capability heartbeats, stale-host detection, neutral input release, standby promotion, and role resynchronization are implemented for the browser test path; WebRTC renegotiation and durable native-device identity remain follow-up work.
