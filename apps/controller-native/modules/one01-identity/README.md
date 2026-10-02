# Native endpoint identity

This local Expo module keeps a fixed app-owned P-256 private key behind the OS
API. Loading an absent key returns null; creation is explicit and keeps a coherent
existing key. Removal and signing serialize with creation/loading. Each signature
rechecks the expected key before and after signing. Only public metadata and
signatures cross the bridge; no private export operation exists.

iOS uses Security SecKey with permanent Keychain storage configured as
`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, with synchronization disabled.
The configured software key reports `os-keystore`. It does not claim Secure
Enclave protection or private-key nonextractability. Android uses AndroidKeyStore
EC `secp256r1`, with only `PURPOSE_SIGN` and `DIGEST_SHA256` authorized, and reports
`os-keystore`. Hardware backing is not inferred from either platform.

The message-signing algorithms hash once: iOS
`ecdsaSignatureMessageX962SHA256`, Android `SHA256withECDSA`. Native signatures
are X9.62 DER. The TypeScript adapter uses the shared strict DER/P1363 conversion
and returns 64-byte `r || s`. Public points are 65-byte uncompressed `04 || X || Y`.
The key ID is lowercase SHA-256 of UTF-8 `101.endpoint-key/1\0` plus that point.
Sign/verify messages cap at 8192 bytes, SHA-256 input at 262144 bytes, and entropy
at 64 bytes. Canonical bounded base64 carries bytes across Expo.

`createNativeIdentityStore()` supplies load/create/remove. Captured identities
provide current-key checks and synchronous invalidation on local removal,
including another store using the same bridge. `nativeEndpointCrypto` uses
SecRandomCopyBytes/SecureRandom, native SHA-256 and native P-256 verification.
Missing cryptographic facilities fail closed. Expo's development entropy fallback
is not used.

## Local evidence, 2026-10-02

Run commands from the repository root:

```sh
node --experimental-strip-types --test apps/controller-native/src/native-identity.test.ts
npm --workspace @101/controller-native run typecheck
npm --workspace @101/controller-native test
python3 apps/controller-native/modules/one01-identity/qa/ios-compile.py
node --experimental-strip-types apps/controller-native/modules/one01-identity/qa/android-compile.mjs
node --experimental-strip-types apps/controller-native/modules/one01-identity/qa/ios-producer.mjs simulator
node --experimental-strip-types apps/controller-native/modules/one01-identity/qa/android-compile.mjs runtime
```

Focused adapter checks followed observed RED failures before implementation.
They cover absence/idempotence, DER/WebCrypto interoperability, tampering, bounds,
copied bytes, guessed metadata, currentness, removal during signing, rotation and
missing native facilities. Native TypeScript and the existing native unit suite
pass. Both Expo autolinkers resolve this module's repository source.

Both real Swift core/Expo registration and Kotlin core/Expo registration compile
against the installed SDKs. The iOS Expo dependency requires deployment target
16.4; compilation uses that target. On the iPhone 17 Pro iOS 26.5 simulator, the
exact production Security signing/hash/entropy/verification functions ran with an
ephemeral SecKey. Its DER output converted strictly and verified in WebCrypto;
changed messages and native input bounds were rejected.

On Pixel_Fold_API_36 (Android API 36), a disposable QA app with a separate UID ran
the exact production AndroidKeyStore core. Absence, coherent creation/loading,
idempotence, signing, expected-key mismatch, bounds, deletion, rotation and old
signer rejection passed. Its signature verified in WebCrypto after conversion;
a changed message failed. The QA package and temporary APK/signing files were
removed. The harness never modifies a generated app project.

iOS persisted Keychain lifecycle is **unverified**. The isolated simulator QA app
installed, but SpringBoard rejected launch with both CLI and UIApplication entry
approaches. The reproducible command is:

```sh
node --experimental-strip-types apps/controller-native/modules/one01-identity/qa/ios-storage.mjs
```

Actual Expo bridge invocation, physical endpoint qualification, lock-state
behavior and hardware protection remain unverified. Simulator/Node evidence does
not promote those claims. No generated native app project was changed.

Platform references: [Apple Security keys](https://developer.apple.com/documentation/security/keys),
[Android Keystore](https://developer.android.com/privacy-and-security/keystore),
[Android key policy](https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec),
[WebCrypto ECDSA](https://www.w3.org/TR/2017/REC-WebCryptoAPI-20170126/#ecdsa-operations).
