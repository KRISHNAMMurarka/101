package com.oneohone.link.identity

import android.app.Activity
import android.os.Bundle
import android.util.Base64
import org.json.JSONObject

/** Distinct disposable QA application UID, exact production AndroidKeyStore core. */
class AndroidIdentityFixture : Activity() {
  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    val result = JSONObject()
    try {
      check(One01IdentityStore.load() == null)
      val first = One01IdentityStore.create()
      check(first == One01IdentityStore.create() && first == One01IdentityStore.load())
      val message = "101 AndroidKeyStore producer interoperability".toByteArray(Charsets.UTF_8)
      val encoded = Base64.encodeToString(message, Base64.NO_WRAP)
      val signature = One01IdentityStore.sign(first.getValue("keyId"), encoded)
      check(One01IdentityStore.verify(first.getValue("publicKey"), encoded, signature))
      check(!One01IdentityStore.verify(first.getValue("publicKey"), Base64.encodeToString(message + byteArrayOf(0), Base64.NO_WRAP), signature))
      rejects { One01IdentityStore.sign("0".repeat(64), encoded) }
      rejects { One01IdentityStore.sign(first.getValue("keyId"), Base64.encodeToString(ByteArray(8193), Base64.NO_WRAP)) }
      rejects { One01IdentityStore.randomBytes(65) }
      rejects { One01IdentityStore.decode("AB==", 1, 1) }
      rejects { One01IdentityStore.sha256(Base64.encodeToString(ByteArray(262145), Base64.NO_WRAP)) }
      check(One01IdentityStore.randomBytes(64).size == 64)
      result.put("publicKey", first.getValue("publicKey"))
      result.put("signature", signature)
      result.put("message", encoded)
      result.put("sha256", Base64.encodeToString(One01IdentityStore.sha256(encoded), Base64.NO_WRAP))
      result.put("protection", first.getValue("protection"))
      One01IdentityStore.remove()
      check(One01IdentityStore.load() == null)
      rejects { One01IdentityStore.sign(first.getValue("keyId"), encoded) }
      val replacement = One01IdentityStore.create()
      check(replacement.getValue("keyId") != first.getValue("keyId"))
      rejects { One01IdentityStore.sign(first.getValue("keyId"), encoded) }
      result.put("result", "passed")
    } catch (failure: Throwable) {
      result.put("result", "failed")
      result.put("failureType", failure.javaClass.simpleName)
    } finally {
      try { One01IdentityStore.remove() } catch (_: Throwable) { result.put("cleanup", "failed") }
      openFileOutput("result.json", MODE_PRIVATE).use { it.write(result.toString().toByteArray(Charsets.UTF_8)) }
      finish()
    }
  }

  private fun rejects(operation: () -> Unit) {
    try { operation() } catch (_: Exception) { return }
    error("Expected native input rejection")
  }
}
