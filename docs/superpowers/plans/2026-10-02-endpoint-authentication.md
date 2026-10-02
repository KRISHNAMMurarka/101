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
- [ ] Actual callers and runtime evidence.
- [x] Independent candidate boundary review; 43 focused checks, no confirmed
  high-impact authentication or lifecycle finding. Core integration gates and
  preserved partial receipts are recorded in endpoint authentication QA.

This core milestone does not finish task 6. Actual browser/native pointer labs and
Studio still use explicit diagnostic peers; a receiver-owned invitation and both
owner confirmation controls must replace those exemptions. Firefox raw channels
and WebKit ICE failed before authentication. Physical, iOS storage and full native
bridge acceptance remain open, as do T04/S02/S03/S04 and support acceptance.
