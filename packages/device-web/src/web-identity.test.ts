import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import test from 'node:test';
import { createEphemeralWebIdentity, createWebCryptoIdentityStore, webEndpointCrypto } from './web-identity.ts';

test('ephemeral WebCrypto identity signs with a copied public key and domain-separated identity', async () => {
  const identity = await createEphemeralWebIdentity(webcrypto as unknown as Crypto);
  const publicKey = identity.publicKey;
  const expectedId = createHash('sha256').update('101.endpoint-key/1\0').update(publicKey).digest('hex');
  assert.equal(publicKey.length, 65);
  assert.equal(publicKey[0], 4);
  assert.equal(identity.keyId, expectedId);
  assert.equal(identity.protection, 'webcrypto-nonextractable');
  assert.equal(await identity.isCurrent(), true);
  let invalidated = false;
  const unsubscribe = identity.onInvalidated(() => { invalidated = true; });
  unsubscribe();
  assert.equal(invalidated, false);
  const message = new TextEncoder().encode('endpoint proof');
  const signature = await identity.sign(message);
  assert.equal(signature.length, 64);
  assert.equal(await webEndpointCrypto.verify(publicKey, message, signature), true);
  publicKey.fill(0);
  assert.equal(identity.publicKey[0], 4);
  message[0] ^= 1;
  assert.equal(await webEndpointCrypto.verify(identity.publicKey, message, signature), false);
});

test('signing and verification snapshot byte inputs before asynchronous crypto', async () => {
  const identity = await createEphemeralWebIdentity();
  const message = new TextEncoder().encode('immutable proof');
  const originalMessage = message.slice();
  const signaturePromise = identity.sign(message);
  message.fill(0);
  const signature = await signaturePromise;
  assert.equal(await webEndpointCrypto.verify(identity.publicKey, originalMessage, signature), true);
  const publicKey = identity.publicKey;
  const verifying = webEndpointCrypto.verify(publicKey, originalMessage, signature);
  publicKey.fill(0); originalMessage.fill(0); signature.fill(0);
  assert.equal(await verifying, true);
  const hashInput = new Uint8Array([1, 2, 3]);
  const hashing = webEndpointCrypto.sha256(hashInput);
  hashInput.fill(0);
  assert.equal(Buffer.from(await hashing).toString('hex'), '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81');
});

test('WebCrypto endpoint APIs reject oversized and malformed input without usable signatures', async () => {
  const identity = await createEphemeralWebIdentity();
  await assert.rejects(() => identity.sign(new Uint8Array(8193)), /message/i);
  const message = new Uint8Array(8192);
  assert.equal(await webEndpointCrypto.verify(identity.publicKey, message, await identity.sign(message)), true);
  assert.equal(await webEndpointCrypto.verify(new Uint8Array(65), message, new Uint8Array(64)), false);
  assert.equal(await webEndpointCrypto.verify(identity.publicKey, message, new Uint8Array(63)), false);
  assert.equal(await webEndpointCrypto.verify(identity.publicKey, new Uint8Array(8193), new Uint8Array(64)), false);
  for (const length of [-1, 0.5, 65]) assert.throws(() => webEndpointCrypto.randomBytes(length), /random/i);
  assert.equal(webEndpointCrypto.randomBytes(32).length, 32);
  await assert.rejects(() => webEndpointCrypto.sha256(new Uint8Array(262145)), /digest/i);
  assert.equal((await webEndpointCrypto.sha256(new Uint8Array(262144))).length, 32);
});

test('absent IndexedDB fails closed without an ephemeral fallback', async () => {
  const store = createWebCryptoIdentityStore();
  try {
    await assert.rejects(() => store.load(), /storage/i);
    await assert.rejects(() => store.create(), /storage/i);
    await assert.rejects(() => store.remove(), /storage/i);
  } finally { store.close(); }
});

test('closed stores reject every operation', async () => {
  const store = createWebCryptoIdentityStore();
  store.close();
  await assert.rejects(() => store.load(), /inactive|closed/i);
  await assert.rejects(() => store.create(), /inactive|closed/i);
  await assert.rejects(() => store.remove(), /inactive|closed/i);
});
