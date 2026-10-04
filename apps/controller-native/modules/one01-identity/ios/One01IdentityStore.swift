import CryptoKit
import Foundation
import Security

enum One01IdentityError: Error {
  case unavailable
  case invalidBytes
  case invalidKey
  case changedKey
  case storageFailure
}

/** Software SecKey in device-only Keychain storage. No private export API is exposed. */
final class One01IdentityStore {
  static let shared = One01IdentityStore()
  private let lock = NSLock()
  private let tag = Data("com.oneohone.link.endpoint-identity.v1".utf8)
  private static let algorithm = SecKeyAlgorithm.ecdsaSignatureMessageX962SHA256
  private static let keyDomain = Data("101.endpoint-key/1\0".utf8)

  private struct OwnedKey {
    let privateKey: SecKey
    let publicKey: SecKey
    let rawPublicKey: Data
    let keyId: String
    var record: [String: String] {
      ["publicKey": rawPublicKey.base64EncodedString(), "keyId": keyId, "protection": "os-keystore"]
    }
  }

  private func serialized<T>(_ work: () throws -> T) rethrows -> T {
    lock.lock()
    defer { lock.unlock() }
    return try work()
  }

  private var query: [String: Any] {
    [kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: tag]
  }

  /** iOS may bridge numeric Security attributes as NSNumber instead of String. */
  static func matchesStoredAttribute(_ value: Any?, expected: CFString) -> Bool {
    if let string = value as? String { return string == expected as String }
    if let number = value as? NSNumber { return number.stringValue == expected as String }
    return false
  }

  private func checkedKey() throws -> OwnedKey? {
    var request = query
    request[kSecReturnRef as String] = true
    request[kSecReturnAttributes as String] = true
    request[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(request as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let attributes = result as? [String: Any],
      let rawKey = attributes[kSecValueRef as String], CFGetTypeID(rawKey as CFTypeRef) == SecKeyGetTypeID(),
      attributes[kSecAttrAccessible as String] as? String == kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String,
      Self.matchesStoredAttribute(attributes[kSecAttrKeyType as String], expected: kSecAttrKeyTypeECSECPrimeRandom),
      Self.matchesStoredAttribute(attributes[kSecAttrKeyClass as String], expected: kSecAttrKeyClassPrivate),
      (attributes[kSecAttrKeySizeInBits as String] as? NSNumber)?.intValue == 256
    else { throw One01IdentityError.storageFailure }
    let key = rawKey as! SecKey
    guard SecKeyIsAlgorithmSupported(key, .sign, Self.algorithm), let publicKey = SecKeyCopyPublicKey(key)
    else { throw One01IdentityError.invalidKey }
    var error: Unmanaged<CFError>?
    guard let bytes = SecKeyCopyExternalRepresentation(publicKey, &error) as Data?,
      bytes.count == 65, bytes.first == 4
    else { throw One01IdentityError.invalidKey }
    // Prove the stored private key matches its derived public key before reporting it.
    let challenge = try Self.randomBytes(32)
    let proof = try Self.signMessage(key: key, message: challenge)
    guard SecKeyVerifySignature(publicKey, Self.algorithm, challenge as CFData, proof as CFData, &error)
    else { throw One01IdentityError.invalidKey }
    let keyId = SHA256.hash(data: Self.keyDomain + bytes).map { String(format: "%02x", $0) }.joined()
    return OwnedKey(privateKey: key, publicKey: publicKey, rawPublicKey: bytes, keyId: keyId)
  }

  func load() throws -> [String: String]? {
    try serialized { try checkedKey()?.record }
  }

  func create() throws -> [String: String] {
    try serialized {
      if let existing = try checkedKey() { return existing.record }
      let attributes: [String: Any] = [
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrKeySizeInBits as String: 256,
        kSecPrivateKeyAttrs as String: [
          kSecAttrIsPermanent as String: true,
          kSecAttrApplicationTag as String: tag,
          kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
          kSecAttrSynchronizable as String: false,
        ],
      ]
      var error: Unmanaged<CFError>?
      guard SecKeyCreateRandomKey(attributes as CFDictionary, &error) != nil,
        let created = try checkedKey() else { throw One01IdentityError.storageFailure }
      // No token/Secure Enclave attribute is configured; report OS storage honestly.
      return created.record
    }
  }

  func remove() throws {
    try serialized {
      let status = SecItemDelete(query as CFDictionary)
      guard status == errSecSuccess || status == errSecItemNotFound else { throw One01IdentityError.storageFailure }
    }
  }

  func sign(expectedKeyId: String, message: String) throws -> String {
    let bytes = try Self.decode(message, minimum: 0, maximum: 8192)
    guard expectedKeyId.count == 64, expectedKeyId.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
    else { throw One01IdentityError.changedKey }
    return try serialized {
      guard let before = try checkedKey(), before.keyId == expectedKeyId else { throw One01IdentityError.changedKey }
      let signature = try Self.signMessage(key: before.privateKey, message: bytes)
      var error: Unmanaged<CFError>?
      guard SecKeyVerifySignature(before.publicKey, Self.algorithm, bytes as CFData, signature as CFData, &error),
        let after = try checkedKey(), after.keyId == expectedKeyId else { throw One01IdentityError.changedKey }
      return signature.base64EncodedString()
    }
  }

  static func decode(_ value: String, minimum: Int, maximum: Int) throws -> Data {
    guard value.utf8.count <= ((maximum + 2) / 3) * 4,
      let bytes = Data(base64Encoded: value), bytes.count >= minimum, bytes.count <= maximum,
      bytes.base64EncodedString() == value else { throw One01IdentityError.invalidBytes }
    return bytes
  }

  static func randomBytes(_ length: Int) throws -> Data {
    guard length >= 0, length <= 64 else { throw One01IdentityError.invalidBytes }
    if length == 0 { return Data() }
    var bytes = Data(count: length)
    let status = bytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, length, $0.baseAddress!) }
    guard status == errSecSuccess else { throw One01IdentityError.unavailable }
    return bytes
  }

  static func sha256(message: String) throws -> Data {
    Data(SHA256.hash(data: try decode(message, minimum: 0, maximum: 262144)))
  }

  static func signMessage(key: SecKey, message: Data) throws -> Data {
    guard message.count <= 8192, SecKeyIsAlgorithmSupported(key, .sign, algorithm) else { throw One01IdentityError.invalidBytes }
    var error: Unmanaged<CFError>?
    // The message algorithm performs SHA-256 internally exactly once.
    guard let signature = SecKeyCreateSignature(key, algorithm, message as CFData, &error) as Data?,
      signature.count >= 8, signature.count <= 72 else { throw One01IdentityError.unavailable }
    return signature
  }

  static func verify(publicKey: String, message: String, signature: String) throws -> Bool {
    let raw = try decode(publicKey, minimum: 65, maximum: 65)
    let bytes = try decode(message, minimum: 0, maximum: 8192)
    let der = try decode(signature, minimum: 8, maximum: 72)
    guard raw.first == 4 else { return false }
    let attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeyClass as String: kSecAttrKeyClassPublic,
      kSecAttrKeySizeInBits as String: 256,
    ]
    var error: Unmanaged<CFError>?
    guard let key = SecKeyCreateWithData(raw as CFData, attributes as CFDictionary, &error),
      SecKeyIsAlgorithmSupported(key, .verify, algorithm) else { return false }
    return SecKeyVerifySignature(key, algorithm, bytes as CFData, der as CFData, &error)
  }
}
