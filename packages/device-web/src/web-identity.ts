import { bytesToHex, endpointKeyId } from './identity-format.ts';
import type { EndpointCrypto, EndpointIdentity } from './identity-types.ts';

const SIGNING_LIMIT = 8192;
const STORE = 'identity';
const RECORD_KEY = 'endpoint';
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGNATURE = { name: 'ECDSA', hash: 'SHA-256' } as const;

interface StoredIdentity {
  version: 1;
  instanceId: string;
  keyId: string;
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

function requireCrypto(value: Crypto | undefined): Crypto {
  if (!value?.subtle || typeof value.getRandomValues !== 'function') throw new Error('Endpoint cryptography unavailable');
  return value;
}

function messageSnapshot(message: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!(message instanceof Uint8Array) || message.length > SIGNING_LIMIT) throw new Error('Endpoint signing message invalid');
  return new Uint8Array(message);
}

function cryptoAdapter(provider: () => Crypto): EndpointCrypto {
  return {
    randomBytes(length) {
      if (!Number.isInteger(length) || length < 0 || length > 64) throw new Error('Endpoint random length invalid');
      return provider().getRandomValues(new Uint8Array(length));
    },
    async sha256(message) {
      if (!(message instanceof Uint8Array) || message.length > 262144) throw new Error('Endpoint digest message invalid');
      const copy = new Uint8Array(message);
      return new Uint8Array(await provider().subtle.digest('SHA-256', copy));
    },
    async verify(publicKey, message, signature) {
      if (!(publicKey instanceof Uint8Array) || publicKey.length !== 65 || publicKey[0] !== 4
        || !(signature instanceof Uint8Array) || signature.length !== 64
        || !(message instanceof Uint8Array) || message.length > SIGNING_LIMIT) return false;
      const publicCopy = new Uint8Array(publicKey), signatureCopy = new Uint8Array(signature), messageCopy = new Uint8Array(message);
      try {
        const subtle = provider().subtle;
        const key = await subtle.importKey('raw', publicCopy, ECDSA, false, ['verify']);
        return await subtle.verify(SIGNATURE, key, signatureCopy, messageCopy);
      } catch { return false; }
    },
  };
}

/** Uses the host's established implementation, with no persisted identity creation. */
export const webEndpointCrypto = cryptoAdapter(() => requireCrypto(globalThis.crypto));

async function generateRecord(crypto: Crypto): Promise<StoredIdentity> {
  const pair = await crypto.subtle.generateKey(ECDSA, false, ['sign', 'verify']);
  const publicBytes = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const keyId = await endpointKeyId(publicBytes, cryptoAdapter(() => crypto));
  return { version: 1, instanceId: bytesToHex(crypto.getRandomValues(new Uint8Array(32))), keyId,
    publicKey: pair.publicKey, privateKey: pair.privateKey };
}

function keyShape(key: unknown, type: 'public' | 'private'): key is CryptoKey {
  if (!key || Object.prototype.toString.call(key) !== '[object CryptoKey]') return false;
  const value = key as CryptoKey;
  const algorithm = value.algorithm as EcKeyAlgorithm;
  return value.type === type && value.extractable === (type === 'public')
    && algorithm.name === 'ECDSA' && algorithm.namedCurve === 'P-256'
    && value.usages.length === 1 && value.usages[0] === (type === 'public' ? 'verify' : 'sign');
}

function recordShape(value: unknown): asserts value is StoredIdentity {
  const record = value as Partial<StoredIdentity> | undefined;
  if (!record || record.version !== 1 || typeof record.keyId !== 'string' || !/^[0-9a-f]{64}$/.test(record.keyId)
    || typeof record.instanceId !== 'string' || !/^[0-9a-f]{64}$/.test(record.instanceId)
    || !keyShape(record.publicKey, 'public') || !keyShape(record.privateKey, 'private')) {
    throw new Error('Endpoint identity stored key invalid');
  }
}

async function validateRecord(value: unknown, crypto: Crypto): Promise<{ record: StoredIdentity; publicBytes: Uint8Array }> {
  recordShape(value);
  try {
    const publicBytes = new Uint8Array(await crypto.subtle.exportKey('raw', value.publicKey));
    if (await endpointKeyId(publicBytes, cryptoAdapter(() => crypto)) !== value.keyId) throw new Error('key mismatch');
    const domain = new TextEncoder().encode('101.endpoint-storage-proof/1\0');
    const proof = new Uint8Array(domain.length + 32);
    proof.set(domain); proof.set(crypto.getRandomValues(new Uint8Array(32)), domain.length);
    const signature = new Uint8Array(await crypto.subtle.sign(SIGNATURE, value.privateKey, proof));
    if (signature.length !== 64 || !await cryptoAdapter(() => crypto).verify(publicBytes, proof, signature)) throw new Error('key mismatch');
    return { record: value, publicBytes };
  } catch { throw new Error('Endpoint identity stored key invalid'); }
}

function identityView(record: StoredIdentity, publicBytes: Uint8Array,
  sign: (message: Uint8Array<ArrayBuffer>) => Promise<Uint8Array>,
  isCurrent: () => Promise<boolean> = async () => true,
  onInvalidated: (listener: () => void) => () => void = () => () => {}): EndpointIdentity {
  const publicCopy = new Uint8Array(publicBytes);
  return Object.freeze({
    get publicKey() { return new Uint8Array(publicCopy); },
    keyId: record.keyId,
    protection: 'webcrypto-nonextractable' as const,
    async sign(message: Uint8Array) { return sign(messageSnapshot(message)); },
    isCurrent,
    onInvalidated,
  });
}

/** Explicitly session-only: caller persistence requires the IndexedDB store below. */
export async function createEphemeralWebIdentity(crypto: Crypto = globalThis.crypto): Promise<EndpointIdentity> {
  const provider = requireCrypto(crypto);
  const { record, publicBytes } = await validateRecord(await generateRecord(provider), provider);
  return identityView(record, publicBytes, async message => {
    const signature = new Uint8Array(await provider.subtle.sign(SIGNATURE, record.privateKey, message));
    if (signature.length !== 64) throw new Error('Endpoint signature invalid');
    return signature;
  });
}

export function createWebCryptoIdentityStore(options: { crypto?: Crypto; indexedDB?: IDBFactory; databaseName?: string } = {}) {
  let closed = false, generation = 0;
  let database: IDBDatabase | undefined;
  let opening: Promise<IDBDatabase> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const capturedInvalidations = new Set<() => void>();

  function invalidate() {
    generation++;
    for (const listener of [...capturedInvalidations]) listener();
    capturedInvalidations.clear();
  }

  function active(expectedGeneration = generation) {
    if (closed || generation !== expectedGeneration) throw new Error('Endpoint identity inactive');
  }

  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  }

  function open(): Promise<IDBDatabase> {
    active();
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        try {
          const factory = options.indexedDB ?? globalThis.indexedDB;
          if (!factory) throw new Error('unavailable');
          const request = factory.open(options.databaseName ?? '101.endpoint-identity.v1', 1);
          request.onupgradeneeded = () => { request.result.createObjectStore(STORE); };
          request.onerror = () => reject(new Error('Endpoint identity storage unavailable'));
          request.onblocked = () => reject(new Error('Endpoint identity storage blocked'));
          request.onsuccess = () => {
            const value = request.result;
            if (closed) { value.close(); reject(new Error('Endpoint identity inactive')); return; }
            value.onversionchange = () => { closed = true; invalidate(); value.close(); };
            if (!value.objectStoreNames.contains(STORE)) { value.close(); reject(new Error('Endpoint identity storage invalid')); return; }
            database = value; resolve(value);
          };
        } catch { reject(new Error('Endpoint identity storage unavailable')); }
      });
    }
    return opening;
  }

  async function read(): Promise<unknown> {
    const db = await open(); active();
    return new Promise((resolve, reject) => {
      try {
        const transaction = db.transaction(STORE, 'readonly');
        const request = transaction.objectStore(STORE).get(RECORD_KEY);
        transaction.oncomplete = () => resolve(request.result);
        transaction.onabort = transaction.onerror = () => reject(new Error('Endpoint identity storage unavailable'));
      } catch { reject(new Error('Endpoint identity storage unavailable')); }
    });
  }

  async function insertIfAbsent(candidate: StoredIdentity, expectedGeneration: number): Promise<unknown> {
    const db = await open(); active(expectedGeneration);
    return new Promise((resolve, reject) => {
      try {
        const transaction = db.transaction(STORE, 'readwrite');
        const store = transaction.objectStore(STORE), request = store.get(RECORD_KEY);
        let result: unknown;
        request.onsuccess = () => {
          try {
            active(expectedGeneration);
            result = request.result;
            if (result === undefined) { result = candidate; store.put(candidate, RECORD_KEY); }
          } catch { transaction.abort(); }
        };
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = transaction.onerror = () => reject(new Error('Endpoint identity storage unavailable'));
      } catch { reject(new Error('Endpoint identity storage unavailable')); }
    });
  }

  function match(value: unknown, captured: StoredIdentity, expectedGeneration: number) {
    active(expectedGeneration); recordShape(value);
    if (value.keyId !== captured.keyId || value.instanceId !== captured.instanceId) throw new Error('Endpoint identity key replaced');
  }

  async function capture(value: unknown, expectedGeneration: number): Promise<EndpointIdentity> {
    const crypto = requireCrypto(options.crypto ?? globalThis.crypto);
    const { record, publicBytes } = await validateRecord(value, crypto);
    match(await read(), record, expectedGeneration);
    let current = true;
    const listeners = new Set<() => void>();
    const invalidateCaptured = () => {
      if (!current) return;
      current = false;
      capturedInvalidations.delete(invalidateCaptured);
      for (const listener of [...listeners]) { try { listener(); } catch { /* A subscriber cannot retain the key. */ } }
      listeners.clear();
    };
    capturedInvalidations.add(invalidateCaptured);
    const checkCurrent = async () => {
      if (!current) throw new Error('Endpoint identity inactive');
      active(expectedGeneration);
      const stored = await read(); match(stored, record, expectedGeneration);
      await validateRecord(stored, crypto);
      match(await read(), record, expectedGeneration);
      if (!current) throw new Error('Endpoint identity inactive');
    };
    return identityView(record, publicBytes, message => serialized(async () => {
      try {
        await checkCurrent();
        const signature = new Uint8Array(await crypto.subtle.sign(SIGNATURE, record.privateKey, message));
        await checkCurrent();
        if (signature.length !== 64) throw new Error('Endpoint signature invalid');
        return signature;
      } catch (error) { invalidateCaptured(); throw error; }
    }), () => serialized(async () => {
      try { await checkCurrent(); return true; }
      catch { invalidateCaptured(); return false; }
    }), listener => {
      if (!current) { try { listener(); } catch { /* Already invalidated. */ } return () => {}; }
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
  }

  return {
    load(): Promise<EndpointIdentity | undefined> {
      const expectedGeneration = generation;
      return serialized(async () => {
        active(expectedGeneration);
        const value = await read(); active(expectedGeneration);
        return value === undefined ? undefined : capture(value, expectedGeneration);
      });
    },
    create(): Promise<EndpointIdentity> {
      const expectedGeneration = generation;
      return serialized(async () => {
        active(expectedGeneration);
        const existing = await read(); active(expectedGeneration);
        const value = existing === undefined
          ? await insertIfAbsent(await generateRecord(requireCrypto(options.crypto ?? globalThis.crypto)), expectedGeneration)
          : existing;
        return capture(value, expectedGeneration);
      });
    },
    remove(expectedKeyId?: string): Promise<void> {
      invalidate();
      const expectedGeneration = generation;
      return serialized(async () => {
        active(expectedGeneration);
        if (expectedKeyId !== undefined && !/^[0-9a-f]{64}$/.test(expectedKeyId)) throw new Error('Endpoint identity key mismatch');
        const db = await open(); active(expectedGeneration);
        await new Promise<void>((resolve, reject) => {
          try {
            const transaction = db.transaction(STORE, 'readwrite');
            const store = transaction.objectStore(STORE), request = store.get(RECORD_KEY);
            let failure: Error | undefined;
            request.onsuccess = () => {
              try {
                active(expectedGeneration);
                if (expectedKeyId !== undefined && request.result !== undefined) {
                  recordShape(request.result);
                  if (request.result.keyId !== expectedKeyId) throw new Error('Endpoint identity key mismatch');
                }
                store.delete(RECORD_KEY);
              } catch (error) { failure = error as Error; transaction.abort(); }
            };
            transaction.oncomplete = () => resolve();
            transaction.onabort = transaction.onerror = () => reject(failure ?? new Error('Endpoint identity storage unavailable'));
          } catch { reject(new Error('Endpoint identity storage unavailable')); }
        });
        active(expectedGeneration);
      });
    },
    close(): void { closed = true; invalidate(); database?.close(); },
  };
}
