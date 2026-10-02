import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicKey, generateKeyPairSync, sign, verify, webcrypto } from 'node:crypto';
import { bytesToHex, hexToBytes, derToP1363, p1363ToDer, endpointKeyId } from './identity-format.ts';

test('native DER and WebCrypto P1363 signatures interoperate without hashing a message twice', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const message = new TextEncoder().encode('101 endpoint authentication fixture');
  const der = sign('sha256', message, privateKey);
  const p1363 = derToP1363(der);
  assert.equal(p1363.length, 64);
  assert.equal(verify('sha256', message, publicKey, p1363ToDer(p1363)), true);
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  const raw = Uint8Array.from([4, ...Buffer.from(jwk.x!, 'base64url'), ...Buffer.from(jwk.y!, 'base64url')]);
  const imported = await webcrypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.equal(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, imported, new Uint8Array(p1363), message), true);
  message[0] ^= 1;
  assert.equal(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, imported, new Uint8Array(p1363), message), false);
});

test('DER conversion preserves required sign padding and rejects ambiguous or invalid scalars', () => {
  const r = `80${'00'.repeat(31)}`, s = `7f${'00'.repeat(31)}`;
  const fixed = hexToBytes(r + s, 64);
  const der = hexToBytes(`3045022100${r}0220${s}`, 71);
  assert.deepEqual(derToP1363(der), fixed);
  assert.deepEqual(p1363ToDer(fixed), der);
  for (const hex of [
    '3006020100020101', // zero
    '3006020180020101', // negative
    '300702020001020101', // redundant zero
    '300602010102010100', // trailing byte
    '308106020101020101', // nonminimal length
    '3006020101020102ff', // incorrect enclosing length
    '3006020101030101', // wrong integer tag
    `3026022100${'ff'.repeat(32)}020101`, // out of range
  ]) assert.throws(() => derToP1363(Uint8Array.from(Buffer.from(hex, 'hex'))), /signature/i, hex);
  assert.throws(() => p1363ToDer(new Uint8Array(64)), /signature/i);
  assert.throws(() => p1363ToDer(new Uint8Array(65)), /signature/i);
});

test('identity wire bytes reject malformed encodings and IDs derive from the public key domain', async () => {
  assert.equal(bytesToHex(new Uint8Array([0, 1, 255])), '0001ff');
  assert.deepEqual(hexToBytes('0001ff', 3), new Uint8Array([0, 1, 255]));
  for (const value of ['0', 'gg', 'AA', ' 01', '0100']) assert.throws(() => hexToBytes(value, 1), /encoding/i);
  const publicKey = new Uint8Array(65); publicKey[0] = 4; publicKey[64] = 1;
  let domain: Uint8Array | undefined;
  const crypto = { async sha256(message: Uint8Array) { domain = message; return new Uint8Array(await webcrypto.subtle.digest('SHA-256', new Uint8Array(message))); } };
  const id = await endpointKeyId(publicKey, crypto);
  const prefix = Buffer.from('101.endpoint-key/1\0', 'utf8');
  assert.deepEqual(domain, new Uint8Array(Buffer.concat([prefix, Buffer.from(publicKey)])));
  assert.equal(id.length, 64);
  assert.notEqual(id, bytesToHex(new Uint8Array(await webcrypto.subtle.digest('SHA-256', publicKey))));
  await assert.rejects(() => endpointKeyId(new Uint8Array(65), crypto), /public key/i);
});
