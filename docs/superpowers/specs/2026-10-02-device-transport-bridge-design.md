# Device transport bridge contract

Revision 1, 2 October 2026. Bounded stage 2 design implementing T01–T14 of the [master checklist](../../platform/MASTER-CHECKLIST.md), under the [release contract](../../platform/RELEASE-CONTRACT.md). The owner authorized native execution; approval-dependent publication and absent physical proof remain separate.

## Observable outcome and boundaries

A phone supplies typed application pointer position and contact to a browser-owned surface through the general SDK. Both diagonal directions, lift/recontact, resize, stop and loss/reconnect preserve meaning. The same peer implementation carries existing 101 reliable/disposable messages without changing v2/input-q1 semantics. General packages never import game roles, axes, session or input code.

Use a game-independent `@101/transport-webrtc` raw peer class. It owns one RTCPeerConnection, a reliable ordered channel and an unordered zero-retransmit channel, bounded raw send admission, state subscriptions, SDP exchange and teardown. `@101/protocol` is its first caller, retaining all existing codecs, profile observation and pairing envelope encoding. Native RTCPeerConnection implementations can use the same raw contract through a factory; their actual API compatibility requires a separate runtime test. No build/emulator observation closes physical/native support.

`@101/device-web` supplies the first browser provider/binding caller after the wire model is implemented. Application-level consent maps a concrete selected remote capability to an app-owned sink in `@101/connect`. Trusted host code constructs authority from authenticated signaling/peer enrollment; packets cannot supply registration IDs, principal/app/session or permission. LAN invitation possession alone does not authorize arbitrary resources. Global persistent identities, key storage, coordinator/relay and S08 proof remain separate S/N work.

## Raw peer interface

```ts
type PeerState = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'failed';
type PeerLane = 'reliable' | 'disposable';
type PeerData = string | ArrayBuffer | Uint8Array;
interface PeerTransport {
  readonly state: PeerState;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  createOffer(): Promise<RTCSessionDescriptionInit>;
  acceptOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit>;
  acceptAnswer(answer: RTCSessionDescriptionInit): Promise<void>;
  send(lane: PeerLane, data: PeerData): boolean;
  onData(listener: (lane: PeerLane, data: string | ArrayBuffer) => void): () => void;
  onStateChange(listener: (state: PeerState) => void): () => void;
  stats(): Promise<RTCStatsReport | undefined>;
}
```

Default channels are `connect-control-1` and `connect-samples-1`. The 101 caller selects `101-control`/`101-realtime`. Buffer limit defaults to 64 KiB for disposable and 256 KiB for reliable; maximum message is 256 KiB. Admission checks include pending bytes plus the new encoded message. Reliable saturation returns false; it never pretends dispatch succeeded. The compatibility caller explicitly retains its old reliable-buffer policy during extraction; general routes always use finite bounds. Transport admission means handed to the data channel, never receipt/effect. The general scheduler reacts to rejected reliable admission with visible stop/recovery; samples retain at most one unsent recoverable state.

Each peer operation captures the current generation. Disconnect invalidates it before detaching handlers/closing channels/peer, cancels ICE waits and releases application state via subscribers. Completion from a replaced connection rejects with a disposed-generation result. Unknown/duplicate channel labels close rather than acquiring a second active channel. ICE gathering uses a lifecycle-owned timeout of 5 seconds; incomplete gathering at timeout uses currently gathered SDP and exposes route path through stats, matching current LAN behavior. All listeners/timers detach at completion/disconnect. Input packet parsing stays in the caller.

## General wire messages and resource binding

Wire protocol `connect/1` uses closed JSON objects encoded as UTF-8 JSON strings. Control packet ceiling is 64 KiB plus a bounded descriptor envelope (maximum 66 KiB); samples/events have a 4 KiB ceiling; at most 128 descriptors/capabilities and 128 active bindings per peer. Descriptor schema 1 parser remains authoritative. Initial codecs are lossless JSON/1 and compact normalized-pointer/1 only after its independent layout/error fixtures exist; no sensor is encoded as 101 axes. Unnegotiated bytes/types/revisions reject.

```ts
type GeneralControl =
  | { protocol: 'connect'; version: 1; type: 'describe'; epoch: string; clockId: string; device: DeviceDescriptor; codecs: WireCodec[] }
  | { protocol: 'connect'; version: 1; type: 'bind'; epoch: string; slot: number; capability: string; descriptorRevision: number; schemaVersion: number; codec: WireCodec; maxHz: number; maxAgeMs: number }
  | { protocol: 'connect'; version: 1; type: 'ready'; epoch: string; slot: number; maxHz: number; maxAgeMs: number }
  | { protocol: 'connect'; version: 1; type: 'stop'; epoch: string; slot: number; reason: 'stopped' | 'unavailable' | 'expired' | 'overload' | 'incompatible' }
  | { protocol: 'connect'; version: 1; type: 'clock'; epoch: string; id: number; sentAt: number; remoteReceivedAt?: number; remoteSentAt?: number };
type GeneralValue = {
  protocol: 'connect'; version: 1; type: 'sample' | 'event'; epoch: string;
  slot: number; sequence: number; capturedAt: number; value: SignalValue;
  operationId?: string; deadline?: number;
};
```

Epoch is a fresh cryptographically random 128-bit channel-generation token from the trusted host. Slots are integers 1–128 assigned by the receiver's approved binding, never arbitrary embedded handle IDs. Descriptor and supported operations are parsed first; schema/revision, codec and rate/age intersect both descriptors and owner grants. The bind response confirms actual accepted limits. A peer cannot bind another peer/session or select an ungranted resource. Each binding owns its embedded source handle/route and drops all old-generation packets after close; fresh reconnect repeats describe/consent/bind/ready. Source readiness begins unavailable and becomes available only after negotiation and actual provider permission.

The first bridge uses a shared epoch established by trusted enrollment on both ends, rather than accepting an epoch selected by a describe packet. Each receiver is bound to one concrete transport object and immutable principal/application/session context. A host approval selects a capability from the parsed description, concrete sink handle/descriptor and expiring owner limits. The embedded runtime still authorizes the actual route, intersecting immutable caller constraints with its host grant so renewal, queued dispatch and asynchronous effect checks cannot outlive owner approval. If its effective limits differ from the proposed negotiated limits, the route is released and approval must be retried with current limits before any delivery. This first caller requires exact descriptor identity/revision and codecs; it does not silently replace registrations when a peer sends another description.

`normalized-pointer/1` is a 48-byte sample-only format for schema-1 x/y vectors with unit `1`, frame `surface-normalized` and range `[0,1]`. Big-endian fields: `CN` magic at 0, version 1 at 2, sample tag 1 at 3, 16-byte epoch at 4, uint16 slot at 20, zero uint16 reserved at 22, uint32 sequence at 24, float64 capture time at 28, float32 x/y at 36/40, zero uint32 reserved at 44. Float32 coordinate error is at most 2^-25 absolute; timestamps retain float64 precision. Contact events and arbitrary sensor values use JSON/1. Unnegotiated binary, wrong profile, nonzero reserved bits, invalid ranges and any other length reject.

Samples are replaceable absolute state, positive increasing uint32 sequence, finite capture time and validated typed value. Events use the reliable channel, strictly increasing positive decimal operation IDs, finite deadlines and bounded deduplication state. Contact release is a reliable event and also occurs locally on blur/hide/unmount/permission loss/disconnect/deadman expiry. Invalid/out-of-order/duplicate/expired/wrong-lane packets cannot refresh liveness or mutate held state. Relative input accumulates bounded unsent deltas into recoverable normalized position; first contact establishes only a local touch anchor and never jumps the remote pointer.

Remote times are not embedded host times. Clock ping/response estimates offset and an RTT-derived uncertainty interval. A binding translates remote capture/deadline conservatively only while maximum uncertainty and drift/age limits satisfy the profile. Otherwise it pauses with readable recovery; uncorrected clocks are never subtracted for latency. Preserve raw capture/receipt/clock identities as provenance. Runtime clocks stay monotonic and exact remote M08 work is required before closing that task.

## First caller, compatibility and verification

Independent app resources: `app:pointer-position/1`, vector unit `1`, frame `surface-normalized`, range `[0,1]`, latest ≤60 Hz/100 ms; `app:pointer-contact/1`, boolean event, reliable/100 ms. Both source and sink operations are granted independently. The surface measures via ResizeObserver, draws within current geometry, retains visible stop and keyboard equivalents and exposes readable status; diagnostics/latency distributions are in Details/Studio. App chrome is monochrome. It does not move the OS cursor or use game seats.

The explicit 101 bridge later maps approved general profiles to selected manifest controls/roles. It resides outside general packages. Existing protocol tests must prove reliable messages and input-q1 profile direction/bytes still pass through the extracted peer. All games keep their existing manifests/callers until their bridge has passing regression/acceptance evidence.

Fault harnesses cover loss, reorder, duplicates, saturation, stale epoch, changed schema, cross-peer/session, clock uncertainty, slow receive and reconnect ownership. WSS fallback verifies secure URL/peer authority and independent buffer/age scheduling; browser WebSocket buffering cannot be undone, so admission stops before exceeding bounds and old queued data is rejected at the receiver. T13 optional comparisons use an actual supported caller and complete measurements; an unsupported candidate is explicitly rejected rather than shipped speculatively.

Physical T08/T14 requires both iPhone and Android on the exact candidate, measured capture-to-render latency with uncertainty, consent/ownership and real loss/reconnect. Injection, headless browser and loopback are separately labeled runtime evidence. Missing Android/human actions do not stop other authorized implementation and do not close those rows.
