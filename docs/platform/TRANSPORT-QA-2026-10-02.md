# Peer extraction verification — 2 October 2026

Scope: T01 contract/plan and T02 raw reusable WebRTC extraction. Base `79bc605`; implementation is the containing commit, identified by the source fingerprints in the browser receipts. The typed remote resource bridge, global peer identities and physical phone pointer are not implemented or qualified by this record.

`@101/transport-webrtc` has no game dependency. Its first repository caller is the existing 101 WebRTCTransport, which retains v2 codecs, directional input-q1 negotiation, old channel labels and old reliable/disposable admission policy. New general callers get finite reliable/disposable defaults and explicit send admission. SDP generation, compression/decompression and ICE waits retain the original connection generation; disconnect clears profile state before callbacks and invalidates pending negotiation. Remote channels must match actual ordered/retransmission semantics, not just a friendly label.

| Check | Result |
| --- | --- |
| Focused peer/protocol/pairing suite | 68 passed, zero failed |
| `npx tsc --noEmit` / `npm run lint` | Pass |
| `npm run test:unit` | 525 passed, zero failed |
| `npm run build` | Pass; fresh server/client build, ID `a7c2a2e465506f25` |
| `node --test tests/rendered-html.test.mjs` | 31 passed, zero failed |
| `npm run native:typecheck` / `npm run native:test` | Pass / 27 passed |
| `npm install --offline --ignore-scripts` | One local workspace link; no new third-party package |
| `node tools/generate-license-inventory.mjs` | 1052 locked dependencies; inventory unchanged |
| Chromium 149.0.7827.55 loopback | Actual two-peer WebRTC/DTLS, both lanes/directions, binary bytes and teardown pass; [receipt](receipts/2026-10-02-peer-chromium.json) |
| WebKit 26.5 loopback | Same raw peer case passes; [receipt](receipts/2026-10-02-peer-webkit.json) |
| Firefox 151.0 loopback | Unqualified: ICE pairs remained in progress, channels unopened; [failed diagnostic receipt](receipts/2026-10-02-peer-firefox.json) retained |

Real-browser checks use a disposable loopback-only HTTP origin and bundled Playwright engines, not a user's Safari/Firefox session. They carry small application-owned test payloads; they do not negotiate SDK resources, prove physical phone/native input, establish cross-network/relay behavior or measure finger-to-pixel latency. `elapsedMs` includes the QA polling interval and is only smoke timing. Q07/Q08 and T03–T14 remain open.

## Regression and review record

- A same-turn disconnect/reconnect originally let a queued negotiation select the replacement peer. The regression failed before the generation capture/check fix.
- An observer exception blocked channel setup/delivery. A reentrant cancellation created channels after closure and allowed a later listener to see revoked data. Both tests failed before lifecycle/observer isolation fixes.
- Partial native channel creation originally left a peer and earlier channel owned after rejection. The failed regression now verifies complete cleanup and a retryable failed state.
- Independent read-only review reproduced old compressed offers/answers surviving decode across disconnect/reconnect and incoming reliable channel labels accepting unordered/lossy delivery. All three regression cases failed before their fixes and pass afterward. No important finding remains deferred.
- The initial test fixture used a TypeScript parameter property unsupported by Node stripping, then omitted asynchronous method-entry synchronization. Those fixture errors were repaired before claiming behavioral coverage. The expected missing-module check had not completed before initial source creation; initial feature cases therefore are backed by runnable assertions and subsequent reproduced lifecycle regressions, rather than an invented missing-module receipt.
- Initial extraction checks exposed a misplaced guard in the Multiplex caller; it was removed at that narrow accidental edit. The binary fixture now uses actual browser `ArrayBuffer` delivery rather than an arbitrary typed-array object. Existing codec/profile, private peer routing and pairing tests pass.
- Firefox failed both opaque-page and local-origin attempts. The diagnostic reports host UDP/TCP candidates on both peers and in-progress pairs without nomination; no packet addresses or pairing secrets are recorded. No unchanged blind retry is accepted as a fix.

The [transport contract](../superpowers/specs/2026-10-02-device-transport-bridge-design.md) freezes wire messages, future binding authority, epochs, limits, clock handling, first pointer profiles and required faults. The [implementation plan](../superpowers/plans/2026-10-02-device-transport-bridge.md) keeps general binding/provider/native/physical/fallback acceptance separate. First-phase implementation does not close those later tasks.
