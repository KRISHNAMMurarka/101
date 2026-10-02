import { fromByteArray, toByteArray } from 'base64-js';
import { derToP1363, endpointKeyId, p1363ToDer } from '../../../packages/device-web/src/identity-format.ts';
import type { EndpointCrypto, EndpointIdentity } from '../../../packages/device-web/src/identity-types.ts';
import { getNativeIdentityBridge, type NativeIdentityBridge, type NativeIdentityRecord } from '../modules/one01-identity/index.ts';

const MAX_BYTES = 8192;
const MAX_HASH_BYTES = 262144;

function copyBytes(input: Uint8Array, max = MAX_BYTES): Uint8Array {
  if (!(input instanceof Uint8Array) || input.length > max) throw new TypeError('Invalid identity message bytes');
  return new Uint8Array(input);
}
function decodeBytes(value: string, min: number, max = min): Uint8Array {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw new TypeError('Invalid identity byte encoding');
  const bytes = toByteArray(value);
  if (bytes.length < min || bytes.length > max || fromByteArray(bytes) !== value)
    throw new TypeError('Invalid identity byte encoding');
  return new Uint8Array(bytes);
}

/** OS entropy, message SHA-256, and P-256 verification; there is no JS fallback. */
export function createNativeEndpointCrypto(bridge?: NativeIdentityBridge): EndpointCrypto {
  const native = () => bridge ?? getNativeIdentityBridge();
  return {
    randomBytes(length) {
      if (!Number.isSafeInteger(length) || length < 0 || length > 64) throw new TypeError('Invalid random byte length');
      return decodeBytes(native().randomBytes(length), length);
    },
    async sha256(message) {
      const bytes = copyBytes(message, MAX_HASH_BYTES);
      return decodeBytes(await native().sha256(fromByteArray(bytes)), 32);
    },
    async verify(publicKey, message, signature) {
      try {
        const key = copyBytes(publicKey, 65), bytes = copyBytes(message), sig = copyBytes(signature, 64);
        if (key.length !== 65 || key[0] !== 4 || sig.length !== 64) return false;
        return await native().verify(fromByteArray(key), fromByteArray(bytes), fromByteArray(p1363ToDer(sig))) === true;
      } catch { return false; }
    },
  };
}

export const nativeEndpointCrypto: EndpointCrypto = createNativeEndpointCrypto();

interface NativeStoreState { generation: number; tail: Promise<void>; invalidators: Set<() => void> }
const states = new WeakMap<NativeIdentityBridge, NativeStoreState>();

export function createNativeIdentityStore(bridge: NativeIdentityBridge = getNativeIdentityBridge()) {
  let state = states.get(bridge);
  if (!state) { state = { generation: 0, tail: Promise.resolve(), invalidators: new Set() }; states.set(bridge, state); }
  const ownedState = state;
  const crypto = createNativeEndpointCrypto(bridge);
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = ownedState.tail.then(operation);
    ownedState.tail = result.then(() => undefined, () => undefined);
    return result;
  };
  const metadata = async (record: NativeIdentityRecord) => {
    if (!record || record.protection !== 'os-keystore' && record.protection !== 'secure-enclave')
      throw new TypeError('Invalid native identity protection');
    const publicKey = decodeBytes(record.publicKey, 65);
    if (publicKey[0] !== 4 || typeof record.keyId !== 'string' || !/^[0-9a-f]{64}$/.test(record.keyId) ||
      await endpointKeyId(publicKey, crypto) !== record.keyId) throw new TypeError('Invalid native identity key');
    return { publicKey, keyId: record.keyId, protection: record.protection };
  };
  const capture = async (record: NativeIdentityRecord, generation: number): Promise<EndpointIdentity> => {
    const value = await metadata(record);
    if (generation !== ownedState.generation) throw new Error('Native identity removed or changed');
    let invalidated = false;
    const listeners = new Set<() => void>();
    const invalidate = () => {
      if (invalidated) return;
      invalidated = true;
      ownedState.invalidators.delete(invalidate);
      for (const listener of listeners) { try { listener(); } catch { /* One consumer cannot prevent revocation. */ } }
      listeners.clear();
    };
    const assertCurrent = async () => {
      if (invalidated || generation !== ownedState.generation) { invalidate(); throw new Error('Native identity removed or changed'); }
      const current = await bridge.load();
      if (!current || (await metadata(current)).keyId !== value.keyId || generation !== ownedState.generation) {
        invalidate();
        throw new Error('Native identity removed or changed');
      }
    };
    return Object.freeze({
      get publicKey() { return new Uint8Array(value.publicKey); },
      keyId: value.keyId,
      protection: value.protection,
      async isCurrent() {
        if (invalidated || generation !== ownedState.generation) { invalidate(); return false; }
        return serialize(async () => {
          try { await assertCurrent(); return true; } catch { invalidate(); return false; }
        });
      },
      onInvalidated(listener: () => void) {
        if (invalidated || generation !== ownedState.generation) { invalidate(); listener(); return () => {}; }
        listeners.add(listener);
        ownedState.invalidators.add(invalidate);
        return () => {
          listeners.delete(listener);
          if (listeners.size === 0) ownedState.invalidators.delete(invalidate);
        };
      },
      async sign(message: Uint8Array) {
        const bytes = copyBytes(message);
        return serialize(async () => {
          await assertCurrent();
          const encoded = await bridge.sign(value.keyId, fromByteArray(bytes));
          await assertCurrent();
          return derToP1363(decodeBytes(encoded, 8, 72));
        });
      },
    });
  };
  return {
    load(): Promise<EndpointIdentity | null> {
      const generation = ownedState.generation;
      return serialize(async () => {
        const record = await bridge.load();
        return record === null ? null : capture(record, generation);
      });
    },
    create(): Promise<EndpointIdentity> {
      const generation = ownedState.generation;
      return serialize(async () => capture(await bridge.create(), generation));
    },
    remove(): Promise<void> {
      ownedState.generation++;
      for (const invalidate of [...ownedState.invalidators]) invalidate();
      return serialize(async () => { await bridge.remove(); });
    },
  };
}
