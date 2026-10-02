package com.oneohone.link.identity

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.util.Base64
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec

/** App-owned sign-only key. Private key material is never exported or bridged. */
internal object One01IdentityStore {
  private const val alias = "com.oneohone.link.endpoint-identity.v1"
  private val lock = Any()
  private val keyDomain = "101.endpoint-key/1\u0000".toByteArray(Charsets.UTF_8)
  private val p256: ECParameterSpec by lazy {
    AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }
      .getParameterSpec(ECParameterSpec::class.java)
  }
  private data class OwnedKey(val privateKey: PrivateKey, val publicKey: ECPublicKey, val raw: ByteArray, val keyId: String) {
    fun record() = mapOf("publicKey" to Base64.encodeToString(raw, Base64.NO_WRAP), "keyId" to keyId, "protection" to "os-keystore")
  }
  private fun keystore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  private fun checkedKey(store: KeyStore): OwnedKey? {
    if (!store.containsAlias(alias)) return null
    val privateKey = store.getKey(alias, null) as? PrivateKey ?: error("Invalid endpoint identity key")
    val publicKey = store.getCertificate(alias)?.publicKey as? ECPublicKey ?: error("Invalid endpoint identity public key")
    val info = KeyFactory.getInstance("EC", "AndroidKeyStore").getKeySpec(privateKey, KeyInfo::class.java)
    check(info.keySize == 256 && info.purposes == KeyProperties.PURPOSE_SIGN &&
      info.digests.toSet() == setOf(KeyProperties.DIGEST_SHA256)) { "Invalid endpoint identity key policy" }
    val params = publicKey.params
    check(params.curve == p256.curve && params.generator == p256.generator && params.order == p256.order &&
      params.cofactor == p256.cofactor) { "Invalid endpoint identity curve" }
    val raw = byteArrayOf(4) + coordinate(publicKey.w.affineX) + coordinate(publicKey.w.affineY)
    val challenge = randomBytes(32)
    val proof = signMessage(privateKey, challenge)
    check(verifyMessage(publicKey, challenge, proof)) { "Incoherent endpoint identity key" }
    val keyId = MessageDigest.getInstance("SHA-256").digest(keyDomain + raw).joinToString("") { "%02x".format(it.toInt() and 255) }
    return OwnedKey(privateKey, publicKey, raw, keyId)
  }

  fun load(): Map<String, String>? = synchronized(lock) { checkedKey(keystore())?.record() }

  fun create(): Map<String, String> = synchronized(lock) {
    val store = keystore()
    checkedKey(store)?.let { return@synchronized it.record() }
    val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
    generator.initialize(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
      .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
      .setDigests(KeyProperties.DIGEST_SHA256)
      .setUserAuthenticationRequired(false)
      .build())
    generator.generateKeyPair()
    // StrongBox/hardware backing is neither requested nor inferred from device type.
    checkedKey(keystore())?.record() ?: error("Endpoint identity key creation failed")
  }

  fun remove() = synchronized(lock) { keystore().deleteEntry(alias) }

  fun sign(expectedKeyId: String, message: String): String {
    val bytes = decode(message, 0, 8192)
    check(expectedKeyId.matches(Regex("^[0-9a-f]{64}$"))) { "Endpoint identity changed" }
    return synchronized(lock) {
      val before = checkedKey(keystore()) ?: error("Endpoint identity removed")
      check(before.keyId == expectedKeyId) { "Endpoint identity changed" }
      val signature = signMessage(before.privateKey, bytes)
      val after = checkedKey(keystore()) ?: error("Endpoint identity removed")
      check(after.keyId == expectedKeyId && verifyMessage(before.publicKey, bytes, signature)) { "Endpoint identity changed" }
      Base64.encodeToString(signature, Base64.NO_WRAP)
    }
  }

  private fun coordinate(value: BigInteger): ByteArray {
    check(value.signum() >= 0 && value.bitLength() <= 256) { "Invalid P-256 coordinate" }
    val bytes = value.toByteArray().let { if (it.size == 33 && it[0] == 0.toByte()) it.copyOfRange(1, 33) else it }
    check(bytes.size <= 32) { "Invalid P-256 coordinate" }
    return ByteArray(32).also { bytes.copyInto(it, 32 - bytes.size) }
  }

  fun decode(value: String, minimum: Int, maximum: Int): ByteArray {
    require(value.length <= ((maximum + 2) / 3) * 4) { "Invalid identity byte encoding" }
    val bytes = Base64.decode(value, Base64.NO_WRAP)
    require(bytes.size in minimum..maximum && Base64.encodeToString(bytes, Base64.NO_WRAP) == value) { "Invalid identity byte encoding" }
    return bytes
  }

  fun randomBytes(length: Int): ByteArray {
    require(length in 0..64) { "Invalid random byte length" }
    return ByteArray(length).also { SecureRandom().nextBytes(it) }
  }

  fun sha256(message: String): ByteArray = MessageDigest.getInstance("SHA-256").digest(decode(message, 0, 262144))

  fun signMessage(key: PrivateKey, message: ByteArray): ByteArray {
    require(message.size <= 8192) { "Invalid identity message bytes" }
    // SHA256withECDSA hashes the message internally exactly once and emits X9.62 DER.
    return Signature.getInstance("SHA256withECDSA").run {
      initSign(key)
      update(message)
      sign().also { check(it.size in 8..72) { "Invalid identity signature" } }
    }
  }

  private fun verifyMessage(key: ECPublicKey, message: ByteArray, signature: ByteArray): Boolean =
    Signature.getInstance("SHA256withECDSA").run { initVerify(key); update(message); verify(signature) }

  fun verify(publicKey: String, message: String, signature: String): Boolean {
    val raw = decode(publicKey, 65, 65)
    val bytes = decode(message, 0, 8192)
    val der = decode(signature, 8, 72)
    if (raw[0] != 4.toByte()) return false
    return try {
      val point = ECPoint(BigInteger(1, raw.copyOfRange(1, 33)), BigInteger(1, raw.copyOfRange(33, 65)))
      val key = KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(point, p256)) as ECPublicKey
      verifyMessage(key, bytes, der)
    } catch (_: Exception) { false }
  }
}
