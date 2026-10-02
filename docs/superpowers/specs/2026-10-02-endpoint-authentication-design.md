# Endpoint authentication design

Base `da1ab0f`. Continue inline under the owner's existing authorization, with
substantial disjoint internal implementation lanes and no repeated approval pause.

## Outcome and boundary

An explicitly enrolled browser/native endpoint proves possession of its own P-256
key before general resources can cross a WebRTC channel. Its proof binds the exact
negotiated transport, complementary source/receiver roles, a fresh epoch and two
fresh challenges, and locally expected application/session scope. A descriptor,
friendly device ID, constructor string or manual code cannot establish identity.
Both source and destination owners retain operation consent. The existing legacy
101 v2 protocol remains separately scoped until explicitly migrated.

The authenticated resource facade is the narrowest existing boundary: it owns one
raw `PeerDataTransport` generation and drops application data before mutually
verified proof and enrollment. Its private provenance cannot be created from a
packet or a structural TypeScript object. Bindings recheck the facade scope and
release on timeout, revocation, disconnect or replacement. Explicit local
diagnostic fixtures remain labeled unauthenticated and cannot claim qualification.

## Identity contract

`EndpointIdentity` exposes a copied 65-byte P-256 public point (`04 || X || Y`),
domain-separated key ID, protection metadata and opaque asynchronous
`sign(message): Promise<Uint8Array>`. The private key never crosses the native
bridge or an export API. `EndpointCrypto` supplies secure randomness, SHA-256 and
P-256/SHA-256 verification. Wire signatures are 64-byte `r || s`; native X9.62 DER
conversion is strict and rejects noncanonical, zero, negative or out-of-range
integers. Message-signing APIs hash the transcript once.

Browser/Node use established WebCrypto. Browser IndexedDB persists nonextractable
private CryptoKeys; readback validates algorithm, usages, public/private coherence
and a proof. Load never silently creates. Creation requires an explicit user
action; rotation/removal invalidates captured signers and enrolled peers. Storage
denial, corrupt keys and key loss are recoverable failures. Nonextractability is
an API property, not a hardware security claim.

Native uses an app-owned Expo module with narrowly bounded operations. Android
uses AndroidKeyStore EC/secp256r1 and SHA256withECDSA. iOS uses Security/Keychain
SecKey and reports the actual configured protection, never inferring hardware
backing from platform/model. Key creation, loading, signing and deletion are
serialized; sign must recheck the expected key ID. No key alias or private
material is chosen by a packet. Native build and actual signature interoperability
are separate acceptance evidence; simulator and device limitations stay visible.

## Transport and handshake

Raw negotiation captures immutable copies of the complete final local SDP and
the exact accepted remote SDP, arranged as offer/answer, only for the current
generation. Overlapping or repeated negotiation cannot replace an owned proof.
Incomplete ICE gathering rejects; disconnect invalidates every captured binding.
All DTLS fingerprints must be derived from the actual descriptions and included
in the transcript. The transcript hashes the exact SDP strings as well as their
fingerprints, with deterministic ordering and domain separation.

Reliable pre-authentication controls have a closed, byte-bounded hello/proof/finish
vocabulary. Hello carries the key, nonce, roles, epoch and expected scope. Each
endpoint signs the same complete transcript under a role-specific proof domain.
Fresh local challenge lifetime is bounded by an owned monotonic deadline; a
signed lifetime never extends that deadline. Conflicting duplicates, reflection,
cross-session/app/epoch traffic, missing fingerprint, malformed key/signature,
queue overload and late asynchronous crypto results fail closed. Finish proves
both sides verified the same transcript. Application lanes remain closed until
proof, owner enrollment and mutually acknowledged finish succeed.

Owner enrollment is distinct from signature verification. First use requires
an owner-authenticated key pin or full transcript digest comparison on both
displays and explicit confirmation. A remote packet cannot supply locally expected
application/session authority; the source consumes a receiver-owned invitation or
an owner-reviewed target selection. Trust-on-first-use is labeled and cannot be
presented as account/human identity. Key rotation requires fresh enrollment.

## Sources and acceptance

The cryptographic wire format follows [W3C WebCrypto ECDSA](https://www.w3.org/TR/2017/REC-WebCryptoAPI-20170126/#ecdsa-operations).
Fingerprint binding follows [RFC 8827](https://www.rfc-editor.org/rfc/rfc8827.html#section-7.4)
and [RFC 8122](https://www.rfc-editor.org/rfc/rfc8122.html#section-5).
Native facilities follow [Apple Security](https://developer.apple.com/documentation/security/protecting-keys-with-the-secure-enclave)
and [Android Keystore](https://developer.android.com/privacy-and-security/keystore).

Meaningful RED checks precede each implementation. Actual browser persistence,
two-endpoint authentication and scoped pointer publication must run through real
caller paths. Native producer signatures must verify in WebCrypto using a named
emulator/device candidate. No S02/S03/S04/T04 completion is inferred from only a
Node fixture, native compilation or self-signed key metadata. Wider bilateral
grants, all owners/endpoints and final security/physical qualification stay open
until their full task contracts are demonstrated.
