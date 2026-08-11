# 101 Link protocol

Protocol version: `1`

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
  "version": 1,
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
- Reconnect: preserve stable device identity, renegotiate transport, then request fresh calibration if sensor orientation may have changed.
