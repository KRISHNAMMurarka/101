import Foundation
import Security

// Ephemeral producer fixture: never creates, deletes, or exports a private
// Keychain identity. The exact production sign/verify/hash/entropy methods run.
@main
struct IdentityProducerFixture {
  static func rejects(_ operation: () throws -> Void) throws {
    do { try operation() } catch { return }
    throw One01IdentityError.invalidBytes
  }

  static func main() throws {
    let message = Data("101 native producer interoperability".utf8)
    var error: Unmanaged<CFError>?
    let attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecPrivateKeyAttrs as String: [kSecAttrIsPermanent as String: false],
    ]
    guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error),
      let publicKey = SecKeyCopyPublicKey(key),
      let raw = SecKeyCopyExternalRepresentation(publicKey, &error) as Data?
    else { throw One01IdentityError.unavailable }
    let signature = try One01IdentityStore.signMessage(key: key, message: message)
    guard try One01IdentityStore.verify(publicKey: raw.base64EncodedString(), message: message.base64EncodedString(),
      signature: signature.base64EncodedString()) else { throw One01IdentityError.invalidKey }
    guard try !One01IdentityStore.verify(publicKey: raw.base64EncodedString(), message: (message + Data([0])).base64EncodedString(),
      signature: signature.base64EncodedString()) else { throw One01IdentityError.invalidKey }
    try rejects { _ = try One01IdentityStore.signMessage(key: key, message: Data(count: 8193)) }
    try rejects { _ = try One01IdentityStore.randomBytes(65) }
    try rejects { _ = try One01IdentityStore.decode("AB==", minimum: 1, maximum: 1) }
    try rejects { _ = try One01IdentityStore.sha256(message: Data(count: 262145).base64EncodedString()) }
    try rejects { _ = try One01IdentityStore.shared.sign(expectedKeyId: "invalid", message: message.base64EncodedString()) }
    guard try One01IdentityStore.randomBytes(64).count == 64 else { throw One01IdentityError.unavailable }
    let digest = try One01IdentityStore.sha256(message: message.base64EncodedString())
    let output = try JSONSerialization.data(withJSONObject: [
      "publicKey": raw.base64EncodedString(), "message": message.base64EncodedString(),
      "signature": signature.base64EncodedString(), "sha256": digest.base64EncodedString(),
    ], options: [.sortedKeys])
    FileHandle.standardOutput.write(output)
  }
}
