# Endpoint authentication implementation plan

> **For agentic workers:** Use test-driven development for meaningful behavior, inline root integration, and disjoint bounded provider lanes under existing owner authorization.

**Goal:** Gate general remote resource traffic on explicit endpoint enrollment and a current, mutually verified WebRTC transcript.

**Architecture:** Reuse WebCrypto, native Security/AndroidKeyStore and the existing raw transport. Add one authenticated facade; preserve diagnostic/legacy scope explicitly. Root owns shared interfaces, exports, transport/binding integration and evidence.

**Tech stack:** TypeScript, WebCrypto/IndexedDB, Expo local modules, Swift Security, Kotlin AndroidKeyStore, existing WebRTC.

**Spec:** [endpoint authentication design](../specs/2026-10-02-endpoint-authentication-design.md).

## Constraints and review focus

Local checkout only; no publication, deployment, new services or remote changes.
Keep the full goal and unqualified acceptance open. Reuse native module source
ownership checks. Exact-tree repository commit gates include a fresh build before
rendered HTML. Never print live SDP, credentials or signing identifiers.

Review storage corruption/loss and concurrent key creation; async crypto completing
after stop; reflection and transcript tampering; app/session authority copied from
untrusted codes; and raw/diagnostic peers being treated as authenticated.

## Tasks and ownership

1. Root: `packages/device-web/src/identity-types.ts`, `identity-format{,.test}.ts`.
   Establish `EndpointIdentity` / `EndpointCrypto`; bounded copied byte input,
   domain-separated ID, strict public-key/signature shape and DER/P1363 fixtures.
   RED: malformed/sign-bit/overlong/out-of-order integer signatures and copied key
   metadata cannot verify a modified transcript. Focused Node test before green.
2. Browser provider lane: only `packages/device-web/src/web-identity{,.test}.ts`
   and a provider-local QA script if needed. Root supplies the interface below.
   `createWebCryptoIdentityStore({crypto?,indexedDB?,databaseName?})` supplies
   `load()`, explicit `create()`, `remove()`, `close()`; Node factory makes an
   explicitly ephemeral signer. RED: missing key is absent; remove/rotation
   invalidates old signers; denied/corrupt storage never creates silently. Use
   real WebCrypto for all signature checks, actual browser IndexedDB for runtime.
3. Native provider lane: only `apps/controller-native/modules/one01-identity/**`
   and `src/native-identity{,.test}.ts`. Load/create/remove/sign/verify/hash/random
   use OS APIs; no private export bridge, no guessed hardware backing. RED native
   signature/DER fixtures, expected-key mismatch, concurrent deletion and bounded
   input failures; real compile/autolinking and producer interoperability evidence.
   No package, lockfile, app UI, config or shared export edits.
4. Root: `packages/transport-webrtc/src/peer{,.test}.ts`, ports only if actual
   producer requires them. Add immutable current-generation session capture.
   RED: no proof before answer, modified returned SDP cannot change proof,
   duplicate/overlapping negotiations and incomplete gather cannot yield proof,
   disconnect invalidates previously captured session. Preserve legacy tests.
5. Root: `packages/device-web/src/authenticated-peer{,.test}.ts` plus binding and
   provider integration. Consume one concrete raw transport and opaque identity.
   RED: pre-auth resources dropped; wrong key/transcript/role/app/session/epoch,
   no enrollment, replay, overload and async disposal fail; authentic paired
   endpoints allow exactly their owned scope and release on revocation.
6. Root: actual browser/native PointerLab and Studio consumer, shared exports and
   bounded invitation/owner-confirmation UI. Source and receiver know locally
   expected scope; compare endpoint transcript digest on first use. Real browser
   persistence + two-page pointer receipt; native interop and physical gaps remain
   separate. Tests demonstrate readable recovery, focus and keyboard equivalents.
7. Freeze candidate. One independent read-only security/lifecycle review. Fix
   reproduced findings RED→GREEN; run required exact-tree gates, retain source and
   version-bound receipts, update SDK and task evidence without partial promotion.

## Provider interface supplied to lanes

```ts
interface EndpointIdentity {
  readonly publicKey: Uint8Array;
  readonly keyId: string;
  readonly protection: 'webcrypto-nonextractable' | 'os-keystore' | 'secure-enclave';
  sign(message: Uint8Array): Promise<Uint8Array>;
  isCurrent(): Promise<boolean>;
  onInvalidated(listener: () => void): () => void;
}
interface EndpointCrypto {
  randomBytes(length: number): Uint8Array;
  sha256(message: Uint8Array): Promise<Uint8Array>;
  verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean>;
}
```

Key IDs are lowercase SHA-256 hex of UTF-8 `101.endpoint-key/1\0` followed by the
exact raw 65-byte point. Messages cap at 8192 bytes. Signature output is exactly
64-byte P1363; public point exactly 65 bytes with prefix 04. Providers clone all
inputs before awaits and public output. Each captured signer rechecks that storage
still holds the same key before and after signing; provider generation invalidates
signers on removal. `load` cannot create; `create` returns an existing coherent key
instead of silently replacing it. Storage is trusted host state, never packet data.
Local removal/close sends invalidation synchronously. The facade polls captured-key
currency every 1000 ms and stops if its last verified check is older than 2000 ms;
external storage loss is bounded rather than inferred from historical proof.

## Execution ledger

- [x] Independent read-only boundary/primary-source review at `b67b1dc`.
- [x] Native source ownership prerequisite integrated at `da1ab0f`; 628 unit,
  32 rendered, fresh build, TypeScript and lint pass; native types + 27 tests pass.
- [x] Format and interfaces; strict DER/P1363 producer interoperability.
- [x] Browser identity provider; real IndexedDB/WebCrypto in three engines.
- [x] Native identity provider source, adapter checks and Swift/Kotlin compilation.
  iOS persisted storage and actual Expo invocation remain unverified.
- [x] Immutable transport session; incomplete ICE fails without producing proof.
- [x] Authenticated facade and bindings; real two-page Chromium pointer/loss check.
- [x] Actual caller implementation and browser DOM runtime evidence. Native
  screen/Expo invocation and physical acceptance remain unverified.
- [x] Independent candidate boundary review; 43 focused checks, no confirmed
  high-impact authentication or lifecycle finding. Core integration gates and
  preserved partial receipts are recorded in endpoint authentication QA.

The core milestone preceded task 6. The subsequent enrollment UI milestone
replaces diagnostic peers in browser/native pointer labs and Studio with a
receiver-owned invitation and both owner confirmation controls. Firefox raw channels
and WebKit ICE failed before authentication. Physical, iOS storage and full native
bridge acceptance remain open, as do T04/S02/S03/S04 and support acceptance.

## Task 6 decision ledger and screen contract

Continue from `0de40c1` without changing the core trust contract. Preserve the
existing monochrome lab layout, native controls, touch pad, direction buttons and
measured receiver geometry. No new visual system, motion, dependencies or service.

Actors are the receiving application owner and the source device owner. The
receiver explicitly creates a local identity if absent, then creates a five-minute
invitation for its own application/session and a fresh epoch. The source loads or
explicitly creates its own identity, pastes that invitation, reviews the displayed
application/session, and chooses **Connect to this receiver**. That local action
captures the reviewed target; parsing an invitation never grants authority. The
receiver accepts only an offer for its still-current locally owned invitation.
Both then exchange offer/answer, compare the full verified digest on their actual
screens and independently choose **Codes match — allow connection**. First-use
comparison authenticates the endpoint channel, not a human/account. Only after
both confirmations can the receiver separately approve Pointer/Contact or
aim/trigger for one minute. Reconnect and key replacement repeat enrollment.

Invitation JSON is closed, bounded to 2048 UTF-8 bytes, versioned, frozen on
parse, and expires within five minutes on each endpoint's wall clock. Clock
disagreement rejects with readable fresh-invitation recovery. Its expiry bounds
admission, never extends the signed monotonic handshake deadline or resource
grant. Application/session always come from the receiver's own invitation or the
source owner's explicit reviewed selection, never offer/answer metadata.

States: identity loading/absent/available/error; explicit create/delete; invitation
empty/current/expired; source review; offer/answer loading/error/current;
cryptographic verification; verified digest awaiting local consent; waiting for
other owner's confirmation; enrolled but resource-unselected; active; lost,
revoked, expired or stopped. Actions have visible busy/disabled states and readable
live status. Removal stops current authority before deleting its saved key.
Storage failure does not silently create. Stop, hide, role change and unmount
dispose timers, crypto subscriptions and held input. Blur releases source contact.

Use semantic buttons/labels/textareas, live polite status, visible keyboard focus,
44px targets, wrapped digest/scope text and mobile-width fields. Comparison is
readable text with an independently focusable confirmation button; no colour-only
success indication. Direction buttons, arrows and Space remain equivalent input.
Native screens keep their existing accessible direction/contact controls.

Acceptance: parser RED→GREEN; real DOM UI invitation/review/bilateral consent,
no early resource output, wrong-scope/expired/replayed invitation recovery,
identity deletion, fresh reconnect, keyboard/focus, narrow viewport and reduced
motion checks; native types and runtime/export evidence separated from physical
acceptance. Retain source/version-bound receipts and failed engine conditions.
