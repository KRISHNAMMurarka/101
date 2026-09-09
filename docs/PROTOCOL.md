# 101 Link protocol

Protocol version: `2`

## Channels

### Control

Reliable and ordered. It carries device hello/capabilities, player assignment, controller layout, calibration, pause, and latency pings. Controllers still accept haptic commands here for compatibility with older hosts, but current hosts do not send them on this channel.

### Realtime

Optimized for frequency and freshness. It carries normalized `InputFrame` values, compact sensor packets, and instant haptic feedback. Receivers discard frames whose sequence is not newer than the last accepted frame for that device; haptics are intentionally disposable because a late buzz is worse than a missed one.

## Transport contract

```ts
interface LinkTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendReliable(message: ControlMessage): void;
  sendRealtime(message: RealtimeMessage): void;
  onMessage(callback: (message: LinkMessage) => void): () => void;
}
```

`BroadcastChannelTransport` supports the same-browser controller test. `WebRTCTransport` implements real peer DataChannels with no hard-coded signaling dependency. The Network Lab exchanges compressed, versioned, integrity-checked offers and answers manually; `@101/pairing` automates the same exchange through a local Hub.

`MultiplexLinkTransport` lets one host accept BroadcastChannel plus any number of WebRTC peers. It learns the source route from each `hello`, so device-targeted configuration, disposable haptic feedback, and private role-state messages go only to that peer. Untargeted session controls may be broadcast.

## Automatic LAN signaling

The Hub creates an expiring `101L2` ticket containing the independent pairing schema version, session ID, LAN endpoint, one join secret, expiry, and transport. The QR contains the ticket—not an SDP blob or account identifier. Host administration uses a different secret, and each joined controller receives its own peer secret. Re-creating a live session without its host bearer returns `409` and no credentials. An authenticated browser reload keeps the join ticket, rotates the host bearer, and invalidates the previous bearer. Desktop-to-browser authority is carried only in a session- and loopback-Hub-bound URL fragment, which the launcher removes immediately and rotates before use; it is never part of the controller ticket or URL query.

```text
POST /v1/sessions
POST /v1/sessions/:session/peers
DELETE /v1/sessions/:session/peers/:peer
GET  /v1/sessions/:session/peers/:peer/offer
PUT  /v1/sessions/:session/peers/:peer/answer
POST /v1/sessions/:session/peers/:peer/reconnect

GET  /v1/sessions/:session/host/peers
PUT  /v1/sessions/:session/host/peers/:peer/offer
POST /v1/sessions/:session/host/peers/:peer/reconnect
```

`AutomaticPairingHost` creates one WebRTC transport per peer. `SignaledLinkTransport` monitors it and sends gameplay over the peer DataChannels. A failed connection increments a signaling generation, disposes stale SDP, creates a fresh peer connection, and re-registers without requiring another scan. The host and controller retain that reset intent if the Hub is briefly unreachable, so neither side publishes or accepts another offer at the obsolete generation; host teardown also waits for a reset already in flight. If a crashed peer lease has already been reaped, the still-valid ticket joins again; a graceful close deletes its lease immediately. Old generations cannot overwrite new offers or answers. If one peer publishes a semantically invalid answer, the host drops and resets that peer and continues the current list, so one broken or hostile controller cannot starve later peers.

Both Hub implementations accept only validated session IDs, clamp invitation lifetimes to 60 seconds–24 hours, and bound live state to 128 sessions and 64 peers per session. A peer with no controller signaling activity for 30 seconds is removed. These bounds are availability safeguards for a LAN service, not a replacement for keeping pairing tickets private.

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

Protocol v2 makes asymmetric configuration explicit. `player.assign`, `player.wait`, `controller.configure`, `controller.state`, and `haptic` all carry a target `deviceId`. A controller ignores messages for other devices. `player.wait` explicitly places a connected surplus device on standby. `controller.configure` carries the active game, role, revision, theme, optional motion mapping, and a JSON element list containing buttons, shoulders, triggers, analog buttons, sticks, D-pads, touch surfaces, or sliders.

The session host treats the identity inside realtime packets as untrusted. It accepts frames only from registered devices with an assignment and replaces the packet's `deviceId` and `playerId` with the authoritative values before the Input Bus sees it.

### Controller layout contract

Every element can carry advisory, flattened placement hints. `side` is `left`, `right`, or `center`; `zone` is `thumb`, `shoulder`, `index`, or `edge`; `size` is `small`, `medium`, or `large`; `span` is an integer from 1 through 4; and `priority` is an integer from 0 through 100. A renderer may reflow these hints for its screen and accessibility settings. Top-level `handedness` (`left` or `right`) is the game author's preferred default, not a lock: the player may override it.

`button` and `shoulder` are digital controls. They may declare a local `interaction`: `hold` (default threshold 450 ms, valid range 150–2000), `double-tap` (default interval 300 ms, valid range 150–750), `toggle`, or `chord`. A chord names one to four unique secondary actions and cannot repeat the element's primary action. Handling these semantics on Link keeps games from reimplementing timing and state machines.

`trigger` and `analog-button` publish their action as a normalized value from 0 through 1. A joystick applies a radial `deadZone` (default `0.12`, range `0`–`0.95`) and a `responseCurve` exponent (default `1`, range `0.25`–`4`) before publishing its vector. Radial normalization keeps a diagonal from exceeding the magnitude of a cardinal direction.

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


## Version policy and upgrade boundaries

Gameplay is `PROTOCOL_VERSION = 2`, with minimum supported version 2. Reliable
messages are JSON `{version,message}` envelopes. A hello has its own version field;
both must be in the readable range. Negotiating an advertised future maximum is
not permission to read future wire bytes. The current sender writes v2; no v3 codec
is claimed. Binary versions must match exactly and throw `ProtocolVersionError`
with `outdated: "ours" | "theirs"` when they do not. A malformed type or size is a
separate error. See [upgrade decisions](DEVICE-ROUTING.md).

Pairing tickets (`101L2`, `PAIRING_TICKET_VERSION = 2`) and SDP envelopes
(`101J2` JSON, `101C2` deflate, `PAIRING_DESCRIPTION_VERSION = 2`) have independent
schema versions. Existing v2 tickets remain valid until expiry when gameplay alone
is upgraded. Their checksums detect corruption, not adversarial forgery; signaling
authority is supplied by the expiring bearer secrets described above.

## Compact input negotiation and layout

The controller advertises `features.inputFormats: ["input-q1"]`. SessionHost selects
it only if advertised and `createInputPacketProfile` can represent the entire role
in at most twelve scalar lanes. The selected format is returned in
`controller.configure.inputFormat`. Missing/unknown features, incompatible shapes,
extra controls, vectors with z, and poses use JSON. Unknown advertised format names
are ignored for forward compatibility; unknown selected formats are rejected.
This negotiation already existed before the next-tasks audit.

`input-q1` is exactly 24 bytes, with all multibyte values little-endian:

| Offset | Type | Meaning |
| ---: | --- | --- |
| 0 | u8 | Exact gameplay protocol version |
| 1 | u8 | Low nibble type 2, high nibble append-only INPUT_SOURCES index |
| 2 | u16 | Controller configuration revision |
| 4 | u32 | Sequence (wraps modulo 2^32) |
| 8 | u32 | Source timestamp in milliseconds (wraps modulo 2^32) |
| 12–23 | 12 bytes | Deterministically ordered role lanes, unused bytes zero |

A digital lane is 0/1, an analog action is 0–255 mapped to 0–1, and an axis/vector
component is signed -127–127 mapped to -1–1. -128 is invalid. Receiver identity
comes from the authenticated role profile, not the packet. A stale configuration
revision is rejected. The codec is bandwidth-oriented; it makes no latency promise.

## Pose payloads and device outputs

JSON InputFrame carries `poses: Record<string, number[]>`. Legacy body tuples are
x/y/z/visibility. Rich body tuples begin with `[-101,1]`, then repeat
x/y/z/visibility/hasWorld/worldX/worldY/worldZ. World coordinates are meters and
mirror with image x. The installed MediaPipe JS producer has no presence field;
the public pose type no longer promises one. InputBus preserves finite pose scalars
up to magnitude 1,000,000, with at most 16 poses and 4096 numbers each; invalid
skeletons are discarded whole. Hardware decoders may supply the same opaque arrays.
The rich-pose marker is a payload schema version, not a negotiated wire capability:
older readers understand only the legacy tuples. Shipped camera capture is local;
a future remote-pose provider must negotiate the rich schema or emit legacy tuples
for an older receiver. Do not infer rich-pose compatibility from protocol v2 alone.

`display` and `audioOut` are independent boolean capabilities. They describe possible
outputs, not authorization for private state or unlocked playback. `speaker` and
`speakerAudio` remain backwards-compatible private cue support. No screen subscription
messages exist yet; the [routing design](DEVICE-ROUTING.md) defines what must precede them.
