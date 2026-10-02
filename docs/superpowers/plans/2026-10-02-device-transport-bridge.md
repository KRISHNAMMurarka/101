# Device transport bridge implementation plan

> **For agentic workers:** Use superpowers:executing-plans. Native execution is already authorized. Keep shared files and integration with the current controller.

**Goal:** Implement a general phone-to-application resource bridge while preserving 101 v2 behavior.

**Architecture:** Extract raw WebRTC into one game-independent package; keep 101 serialization in its compatibility caller. Build bounded general codecs, peer-bound SDK registrations and actual browser/native pointer providers on that contract. Qualification and physical evidence remain distinct.

**Tech Stack:** TypeScript, WebRTC DataChannels, existing embedded SDK, React/browser and existing native runtime.

**Spec:** [transport contract](../specs/2026-10-02-device-transport-bridge-design.md).

## Global constraints

- General packages never import game code or normalized 101 input frames.
- Reliable transitions and relative movement cannot be treated as disposable independent samples.
- Registration/authority comes from trusted host code; packets never choose principal/app/session/handles.
- Reconnect creates a new generation and repeats negotiation/ownership.
- No public actions or substitute physical evidence; all commit gates pass on the candidate.

## Review focus

- Disconnect during SDP or ICE gathering must cancel work without late connection resurrection.
- Unknown/duplicate channels cannot replace a legitimate resource lane.
- Reliable admission must expose overload; bytes include the new payload.
- A stale peer/epoch/schema cannot publish into a replacement binding.
- Relative lift/recontact and opposite diagonals preserve movement with no anchor jump.

### Task 1: Raw peer extraction and compatible first caller (T02)

**Files:** Create `packages/transport-webrtc/{package.json,src/{index.ts,peer.ts,peer.test.ts}}`; modify `packages/protocol/src/index.ts`, its package metadata, root aliases and lockfile; create local browser QA helper `tools/qa-device-peer.mjs`.

**Interfaces:** `PeerDataTransport` implements the raw interface in the spec; constructor accepts initiator, ICE servers, channel names, message/buffer limits and a trusted `createPeer` factory. Existing `WebRTCTransport` implements the same public 101 methods and keeps profile/codec observation.

- [x] Write tests first: initiated channel options are `{ordered:true}` and `{ordered:false,maxRetransmits:0}`; raw string/binary delivery survives; bounded sends return false at capacity; old handlers cannot deliver after disconnect/reconnect; cancelled SDP/ICE work rejects and detaches listeners; duplicate/unknown channel closes.

```ts
assert.equal(peer.send('disposable', new Uint8Array(24)), true);
fake.channel.bufferedAmount = 65530;
assert.equal(peer.send('disposable', new Uint8Array(24)), false);
await peer.disconnect(); oldChannel.receive('stale');
assert.equal(received.length, 0);
```

- [ ] Initial missing-module red was not observed before source creation; preserve this missed workflow step. Later lifecycle and review regressions were reproduced red before repair, as recorded in QA.
- [x] Implement raw connection ownership/cancellation/admission with lifecycle checks before and after each async step. Retain the 101 codec wrapper and old labels. Preserve old reliable policy explicitly; general callers use finite bounds.
- [x] Run peer tests plus protocol/pairing tests; verify input-q1 bytes and reliable/disposable direction. Run a real Chromium two-peer local browser exchange using the new raw package with SDP/DTLS, both lanes and teardown; record browser/build and payloads.
- [x] Review frozen changed code independently; repair reproduced important findings with failing tests; run exact candidate gates/fresh build/rendered tests and update T02 evidence. Close no physical row.

### Task 2: General model, codec, scheduling and peer binding (T03–T06/T10–T11)

**Files:** `packages/device-model` only if required by real profile; `packages/connect` public binding exports; first `packages/device-web` codec/binding modules and tests.

**Interfaces:** Closed `GeneralControl`/`GeneralValue` messages from the spec. A trusted binding constructor receives peer/principal/app/session/epoch, selected concrete capability and sink handle; incoming slots map only to registered sources in that scope.

- [ ] Write malformed/oversized/unknown schema/codec, wrong-lane, cross-peer/session, stale epoch/sequence, reliable event and receiver overload assertions before implementation.

```ts
assert.equal(binding.receive(otherPeer, sample), false);
assert.equal(binding.receive(peer, { ...sample, epoch: oldEpoch }), false);
assert.equal(binding.receive(peer, sample), true);
assert.equal(binding.receive(peer, sample), false);
```

- [ ] Implement descriptor/limit negotiation, JSON codec, peer authority and conservative clock translation with needed M08/S03/S09 negative cases. Freeze exact extended interfaces in this task's execution record before coding; complex structured/rich profiles receive their own bounded plans and actual callers.
- [ ] Test independent typed temperature/normalized position and reliable contact, loss/reordering/duplicates/saturation/slow sinks and renewal/expiry/reconnect release. Profile changes stop old output before negotiation.
- [ ] Record only completed task acceptance; multi-codec/physical/global identity rows stay open until their complete conditions run.

### Task 3: Browser/native providers and independent pointer (T07–T09/T14)

**Files:** `packages/device-web` actual provider; independent pointer app/page under `app/pointer-lab` initially; native general-provider caller beside existing controller session; explicit 101 application bridge.

**Interfaces:** Profile declarations in the spec; contact/relative transform publishes recoverable absolute state. UI lifecycle calls binding stop/release. ResizeObserver maps normalized state into measured surface geometry.

- [ ] Write relative movement and release regressions first (both diagonals, dropped sends accumulated, lift/recontact, blur/hide/stop); implement generic providers and independent SDK caller.
- [ ] Test real browser paired flow, accessible controls and permission/ownership recovery. Build/install local debug native caller on available authorized devices; preserve existing game v2 caller.
- [ ] Perform exact T08 physical run on both phones only when available; record capture-to-render distributions with clock bounds. Keep physical, human and injected outcomes separate.
- [ ] Implement explicit typed-resource → manifest control mappings and run all required game/controller regressions plus disconnect/reconnect. Close T14 only on one exact complete candidate.

### Task 4: Secure fallback and candidate comparison (T12–T13)

**Files:** Bounded WSS transport with disposable local harness and first application caller; measurement script and retained/rejected optional transport record.

**Interfaces:** Same trusted peer binding; secure authenticated topology and negotiated delivery/freshness, never unrestricted URL/credential forwarding.

- [ ] Assert insecure origin, wrong peer, overbuffer, expired interactive packets and reconnect epoch denial before implementation. Use a local disposable TLS harness; external hosting is not authorized.
- [ ] Implement/test fallback queues and receiver age limits; run complete independent pointer case and local security/impairment checks.
- [ ] Compare WebTransport/native QUIC only with a justified actual caller and supported runtime; record explicit retain/reject with end-to-end bytes/latency/security evidence.

## Execution record

- Base `79bc605`; C01–C08/Q01 contract checkpoint is accepted locally with 511 unit tests and 31 fresh-build rendered checks. No remote/physical SDK support is accepted.
- Ruling: implement the reusable peer extraction first; it has a real existing caller and shrinks the next security-sensitive boundary. Cost if wrong: compatible wrapper can revert independently before general rollout.
- Preflight: codec wrapper consumes raw lanes but retains its directional input-q1 profile state. Binding consumes raw peer messages but owns a separate general vocabulary and authority. No shared game vocabulary enters the raw package.
- Later tasks above retain concrete wire/profile/failure expectations; their implementation steps are expanded with exact signatures and fixtures at the bounded task boundary before writing source.

- Task 1 completed: 12 raw peer tests; 68 focused peer/protocol/pairing tests; 525 unit and 31 fresh-build rendered tests; TypeScript/lint/native TypeScript and 27 native tests pass. Independent review findings on asynchronous codec generation and lane delivery semantics repaired with three reproduced regressions. Chromium/WebKit raw loopback pass, Firefox loopback remains failed/unqualified. See [QA](../../platform/TRANSPORT-QA-2026-10-02.md).
