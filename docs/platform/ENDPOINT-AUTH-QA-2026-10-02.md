# Endpoint authentication core, 2 October 2026

Base `da1ab0f`; the implementation is the containing commit. Linked receipts
retain exact consumed source hashes. This is partial evidence for T04, S02,
S03, S04 and N01. No checklist row or support acceptance is promoted.

The issued `AuthenticatedResourcePeer` captures one concrete raw transport. Its
P-256/SHA-256 proof binds complete exact offer/answer SDP, the derived DTLS
fingerprints, two fresh challenges, endpoint keys, source/receiver and
offerer/answerer roles, locally expected application/session/epoch and challenge
lifetime. First use requires both owners to compare the full verified digest and
confirm it; previously enrolled endpoint-key pins can establish trust directly.
Reliable finish messages must agree before either endpoint exposes application
traffic or an opaque authenticated scope. Encryption and manual code possession
are insufficient. Resource approval remains a separate scoped owner action.

Remote publishers/receivers now reject raw or structurally copied peers by
default. A pending issued facade can be constructed but cannot describe, approve,
bind or deliver resources. Wrong receiver application/session and wrong endpoint
role/epoch reject. Disconnect, key invalidation and stale currentness checks retire
the facade and release its owned routes. External key currency is polled every
second and must remain within two seconds; local removal is synchronous.

Browser identities use actual nonextractable WebCrypto private keys stored in
IndexedDB. Missing storage does not create an identity; creation is explicit.
Stored pair coherence is proved, competing tabs insert atomically, and signing
checks the same captured instance before and after cryptography. Deletion,
replacement, denied/corrupt storage and closed stores fail. Native providers use
fixed app-owned Keychain/AndroidKeyStore identities without a private export
bridge. iOS uses a software SecKey and reports OS storage, with
WhenUnlockedThisDeviceOnly and synchronization disabled. Hardware protection is
unverified. Native message signing hashes once and emits DER; strict shared
conversion yields WebCrypto's 64-byte P1363 format.

## Scope and results

| Check | Result and limit |
| --- | --- |
| Focused independent source review | No confirmed high-impact authentication/lifecycle finding; 43 focused Node checks pass |
| Real browser identity persistence | 47 checks each in Chromium 149.0.7827.55, Firefox 151.0 and WebKit 26.5 |
| Chromium two-page authentication | Three rejection cases and two successful typed pointer/loss cases pass |
| Firefox two-page transport | Raw reliable/disposable lanes stay closed after ten seconds; authentication never starts |
| WebKit two-page transport | Strict five-second ICE gathering deadline rejects offer creation; authentication never starts |
| Native adapter and existing suite | Nine identity tests and 27 existing native tests pass; native TypeScript passes |
| Swift/Kotlin core and Expo registration | Compile against installed iOS/Android SDKs; actual Expo invocation unverified |
| iOS simulator producer | Exact production Security functions produce a DER signature verified by WebCrypto; tamper and bounds reject; key is ephemeral |
| Android emulator producer | Actual AndroidKeyStore lifecycle and interoperability checked in a separate disposable QA UID; physical/hardware/Expo acceptance excluded |
| iOS persisted Keychain fixture | Unverified: CLI and UIApplication entry approaches installed but could not launch; stopped after the second approach |
| Repository integration gates | TypeScript, lint, 660 unit tests, fresh build and 32 rendered tests pass on the containing candidate |

The Chromium harness creates separate endpoint identities, reloads both pages,
negotiates actual WebRTC and runs the issued facades without the diagnostic
exemption. Independently wrong application/session expectations and a
browser-accepted SDP mutation terminate without scope or application delivery.
Both owners confirm matching verified transcripts before resource description.
Explicit receiver selection then delivers generated normalized Position and
reliable Contact, rescales the surface and releases both routes on transport loss
or key removal. These are generated provider values, not UI/touch/physical input.

At this core milestone, `/pointer-lab`, native PointerLab and Studio used
explicit `authentication: 'local-diagnostic'`. Their existing UI behavior remains
available at that revision, but does not establish endpoint authentication.
The subsequent [enrollment UI milestone](ENDPOINT-ENROLLMENT-UI-QA-2026-10-02.md)
replaces these exemptions with receiver-owned scope invitations, explicit local
identity controls and both owners' confirmations. Its runtime evidence covers
actual browser UI; native screen/bridge acceptance remains open. Wider resource grants, account
identity, coordinator/relay topology and final security validation remain open.

## Retained evidence and reproduction

- Browser stores: [Chromium](receipts/2026-10-02-identity-store-chromium.json),
  [Firefox](receipts/2026-10-02-identity-store-firefox.json),
  [WebKit](receipts/2026-10-02-identity-store-webkit.json).
- Two-page peer: [Chromium](receipts/2026-10-02-authenticated-peer-chromium.json),
  [Firefox failure](receipts/2026-10-02-authenticated-peer-firefox-failed.json),
  [WebKit failure](receipts/2026-10-02-authenticated-peer-webkit-failed.json).
  Failure logs are retained alongside the failed receipts. Their source core
  hashes match the candidate; those earlier attempts predate receipt-only harness
  logging improvements and are not substituted with success claims.
- [Native compilation/producer receipt](receipts/2026-10-02-native-identity.json)
  and [native module contract/repro sources](../../apps/controller-native/modules/one01-identity/README.md).
- [Immutable native module source resolution](receipts/2026-10-02-identity-native-source.json)
  resolves identity and watch implementations from the staged snapshot on both
  Apple and Android; the receipt retains each file hash and the snapshot tree.
- [Implementation plan](../superpowers/plans/2026-10-02-endpoint-authentication.md)
  and `endpoint-auth-core-2026-10-02` in [task evidence](task-evidence.json).

```sh
node tools/qa-web-identity.mjs chromium # also firefox or webkit
node tools/qa-authenticated-peer.mjs chromium
node --experimental-strip-types --test packages/device-web/src/authenticated-peer.test.ts
node tools/qa-native-module-sources.mjs <immutable-candidate-tree>
npm run native:typecheck
npm run native:test
npx tsc --noEmit
npm run lint
npm run test:unit
npm run build
node --test tests/rendered-html.test.mjs
```

Regressions observed before fixes cover missing providers/facade, incomplete ICE,
absence of current session proof, raw/copy binding rejection, and stale idle
identity currency. Strict format fixtures use real native DER/WebCrypto producer
representations. A provider deletion-during-signing check failed when its
post-sign currency check was removed, then passed after restoring it. The broad
unit run exposed one old raw surface fixture; it now declares its local diagnostic
scope explicitly and retains its idle-pairing/one-minute grant check.

Checks run locally on macOS 26.5.2, Node 24.14.0 and Playwright 1.61.1. Installed
dependencies are reused. Native immutable source resolution covers both local
modules, not a clean install or signed application release. The available physical
iPhone requires configured Xcode account/profiles, and an Android phone is not
attached; the existing owner dependency request remains pending. No publication,
deployment, external preview or third-party service was performed.
