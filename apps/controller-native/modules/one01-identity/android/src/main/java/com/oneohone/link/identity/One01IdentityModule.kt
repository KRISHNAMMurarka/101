package com.oneohone.link.identity

import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class One01IdentityModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("One01Identity")
    AsyncFunction("load") { One01IdentityStore.load() }
    AsyncFunction("create") { One01IdentityStore.create() }
    AsyncFunction("remove") { One01IdentityStore.remove() }
    AsyncFunction("sign") { expectedKeyId: String, message: String -> One01IdentityStore.sign(expectedKeyId, message) }
    Function("randomBytes") { length: Int -> Base64.encodeToString(One01IdentityStore.randomBytes(length), Base64.NO_WRAP) }
    AsyncFunction("sha256") { message: String -> Base64.encodeToString(One01IdentityStore.sha256(message), Base64.NO_WRAP) }
    AsyncFunction("verify") { publicKey: String, message: String, signature: String ->
      One01IdentityStore.verify(publicKey, message, signature)
    }
  }
}
