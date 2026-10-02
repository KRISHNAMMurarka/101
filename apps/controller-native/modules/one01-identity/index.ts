export interface NativeIdentityRecord {
  publicKey: string;
  keyId: string;
  protection: 'os-keystore' | 'secure-enclave';
}

/** Only public metadata and bounded base64 bytes cross the bridge. */
export interface NativeIdentityBridge {
  load(): Promise<NativeIdentityRecord | null>;
  create(): Promise<NativeIdentityRecord>;
  remove(): Promise<void>;
  sign(expectedKeyId: string, message: string): Promise<string>;
  randomBytes(length: number): string;
  sha256(message: string): Promise<string>;
  verify(publicKey: string, message: string, signature: string): Promise<boolean>;
}

export function getNativeIdentityBridge(): NativeIdentityBridge {
  // Metro resolves this literal require; deferring it keeps the injected adapter
  // runnable in Node and avoids initializing a native bridge just to read types.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Metro's synchronous native resolver must remain lazy for the injected adapter.
    const { requireNativeModule } = require('expo-modules-core') as typeof import('expo-modules-core');
    return requireNativeModule<NativeIdentityBridge>('One01Identity');
  } catch (cause) { throw new Error('Native endpoint identity is unavailable', { cause }); }
}
