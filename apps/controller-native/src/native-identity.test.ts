import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign, verify, webcrypto } from 'node:crypto';
import test from 'node:test';
import { createNativeEndpointCrypto, createNativeIdentityStore, nativeEndpointCrypto } from './native-identity.ts';
import type { NativeIdentityBridge, NativeIdentityRecord } from '../modules/one01-identity/index.ts';

// Node's established SHA256/ECDSA producer emits the same X9.62 DER format as
// SecKey's message algorithm and Java Signature; it is not OS-storage evidence.
class ProducerBridge implements NativeIdentityBridge {
  private key?: ReturnType<typeof generateKeyPairSync>;
  malformedSignature?: string;
  afterSign?: () => void;

  randomBytes(length: number) { return randomBytes(length).toString('base64'); }
  async sha256(message: string) { return createHash('sha256').update(Buffer.from(message, 'base64')).digest('base64'); }
  async verify(publicKey: string, message: string, signature: string) {
    const raw = Buffer.from(publicKey, 'base64');
    const key = await webcrypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    const spki = Buffer.from(await webcrypto.subtle.exportKey('spki', key));
    return verify('sha256', Buffer.from(message, 'base64'), { key: spki, format: 'der', type: 'spki' }, Buffer.from(signature, 'base64'));
  }
  async load(): Promise<NativeIdentityRecord | null> {
    if (!this.key) return null;
    const jwk = this.key.publicKey.export({ format: 'jwk' });
    const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]);
    const keyId = createHash('sha256').update('101.endpoint-key/1\0').update(raw).digest('hex');
    return { publicKey: raw.toString('base64'), keyId, protection: 'os-keystore' };
  }
  async create() {
    this.key ??= generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    return (await this.load())!;
  }
  async remove() { this.key = undefined; }
  async sign(expectedKeyId: string, message: string) {
    if ((await this.load())?.keyId !== expectedKeyId || !this.key) throw new Error('Identity changed');
    const result = this.malformedSignature ?? sign('sha256', Buffer.from(message, 'base64'), this.key.privateKey).toString('base64');
    this.afterSign?.();
    if ((await this.load())?.keyId !== expectedKeyId) throw new Error('Identity changed');
    return result;
  }
}

test('native load stays absent until explicit create and create keeps the same key', async () => {
  const bridge = new ProducerBridge();
  const store = createNativeIdentityStore(bridge);
  assert.equal(await store.load(), null);
  const [first, second] = await Promise.all([store.create(), store.create()]);
  assert.equal(first.keyId, second.keyId);
  assert.equal((await store.load())?.keyId, first.keyId);
  assert.equal(first.protection, 'os-keystore');
  first.publicKey.fill(0);
  assert.equal(first.publicKey[0], 4, 'public metadata is a fresh copy');
});

test('native DER signatures verify in WebCrypto once and bind the unmodified message', async () => {
  const bridge = new ProducerBridge();
  const store = createNativeIdentityStore(bridge);
  const identity = await store.create();
  const message = new TextEncoder().encode('native endpoint transcript');
  const signature = await identity.sign(message);
  assert.equal(signature.length, 64);
  const key = await webcrypto.subtle.importKey('raw', identity.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.equal(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, message), true);
  assert.equal(await createNativeEndpointCrypto(bridge).verify(identity.publicKey, message, signature), true);
  message[0] = message[0]! ^ 1;
  assert.equal(await createNativeEndpointCrypto(bridge).verify(identity.publicKey, message, signature), false);
});

test('native removal invalidates captured signers and replacement cannot satisfy an old signer', async () => {
  const bridge = new ProducerBridge();
  const store = createNativeIdentityStore(bridge);
  const first = await store.create();
  await store.remove();
  assert.equal(await store.load(), null);
  const replacement = await store.create();
  assert.notEqual(replacement.keyId, first.keyId);
  await assert.rejects(first.sign(new Uint8Array([1])), /changed|removed/i);
  assert.equal((await replacement.sign(new Uint8Array([1]))).length, 64);
});

test('native signature is discarded if key removal occurs during signing', async () => {
  const bridge = new ProducerBridge();
  const store = createNativeIdentityStore(bridge);
  const identity = await store.create();
  bridge.afterSign = () => { void store.remove(); };
  await assert.rejects(identity.sign(new Uint8Array([1])), /changed|removed/i);
  assert.equal(await store.load(), null);
});

test('native adapter rejects malformed producer DER and unbounded or invalid byte inputs', async () => {
  const bridge = new ProducerBridge();
  const identity = await createNativeIdentityStore(bridge).create();
  for (const hex of ['3006020180020101', '300702020001020101', '3006020100020101', '3006020101020100', '300602010102010100']) {
    bridge.malformedSignature = Buffer.from(hex, 'hex').toString('base64');
    await assert.rejects(identity.sign(new Uint8Array([1])), /signature/i);
  }
  bridge.malformedSignature = undefined;
  const crypto = createNativeEndpointCrypto(bridge);
  assert.equal((await identity.sign(new Uint8Array(8192))).length, 64);
  for (const length of [-1, 0.5, 65, Number.NaN]) assert.throws(() => crypto.randomBytes(length), /length|bytes/i);
  await assert.rejects(identity.sign(new Uint8Array(8193)), /bytes|message/i);
  await assert.rejects(crypto.sha256(new Uint8Array(262145)), /bytes|message/i);
  assert.deepEqual(await crypto.sha256(new Uint8Array(262144)), new Uint8Array(createHash('sha256').update(new Uint8Array(262144)).digest()));
  assert.equal(await crypto.verify(new Uint8Array(65), new Uint8Array([1]), new Uint8Array(64)), false);
});

test('native metadata with a guessed key identifier or protection claim fails closed', async () => {
  const bridge = new ProducerBridge();
  await bridge.create();
  const record = await bridge.load();
  bridge.load = async () => ({ ...record!, keyId: '0'.repeat(64) });
  await assert.rejects(createNativeIdentityStore(bridge).load(), /identity|key/i);
  bridge.load = async () => ({ ...record!, protection: 'hardware' as NativeIdentityRecord['protection'] });
  await assert.rejects(createNativeIdentityStore(bridge).load(), /protection|identity/i);
});

test('native adapter clones messages before queued work and secure OS outputs are shape-checked', async () => {
  const bridge = new ProducerBridge();
  const store = createNativeIdentityStore(bridge);
  const identity = await store.create();
  const message = new Uint8Array([1, 2, 3]);
  const pending = identity.sign(message);
  message.fill(9);
  const signature = await pending;
  assert.equal(await createNativeEndpointCrypto(bridge).verify(identity.publicKey, new Uint8Array([1, 2, 3]), signature), true);
  bridge.randomBytes = () => 'AA==';
  assert.throws(() => createNativeEndpointCrypto(bridge).randomBytes(32), /encoding|bytes/i);
  bridge.sha256 = async () => 'AA==';
  await assert.rejects(createNativeEndpointCrypto(bridge).sha256(new Uint8Array([1])), /encoding|bytes/i);
});

test('native current identity and synchronous invalidation retire storage loss and explicit removal', async () => {
  const bridge = new ProducerBridge();
  const store = createNativeIdentityStore(bridge);
  const identity = await store.create();
  assert.equal(await identity.isCurrent(), true);
  let invalidations = 0;
  identity.onInvalidated(() => { invalidations++; });
  const removing = store.remove();
  assert.equal(invalidations, 1, 'listeners run before removal awaits the bridge');
  assert.equal(await identity.isCurrent(), false);
  await removing;
  const replacement = await store.create();
  await bridge.remove();
  assert.equal(await replacement.isCurrent(), false, 'OS storage loss invalidates a captured signer');
});

test('native cryptography cannot silently fall back when the OS module is unavailable', async () => {
  assert.throws(() => nativeEndpointCrypto.randomBytes(32), /unavailable/i);
  await assert.rejects(nativeEndpointCrypto.sha256(new Uint8Array([1])), /unavailable/i);
  assert.throws(() => createNativeIdentityStore(), /unavailable/i);
});
