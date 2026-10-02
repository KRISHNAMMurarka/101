import ExpoModulesCore

public final class One01IdentityModule: Module {
  public func definition() -> ModuleDefinition {
    Name("One01Identity")

    AsyncFunction("load") { try One01IdentityStore.shared.load() }
    AsyncFunction("create") { try One01IdentityStore.shared.create() }
    AsyncFunction("remove") { try One01IdentityStore.shared.remove() }
    AsyncFunction("sign") { (expectedKeyId: String, message: String) in
      try One01IdentityStore.shared.sign(expectedKeyId: expectedKeyId, message: message)
    }
    Function("randomBytes") { (length: Int) in
      try One01IdentityStore.randomBytes(length).base64EncodedString()
    }
    AsyncFunction("sha256") { (message: String) in
      try One01IdentityStore.sha256(message: message).base64EncodedString()
    }
    AsyncFunction("verify") { (publicKey: String, message: String, signature: String) in
      try One01IdentityStore.verify(publicKey: publicKey, message: message, signature: signature)
    }
  }
}
