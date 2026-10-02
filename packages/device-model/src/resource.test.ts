import assert from 'node:assert/strict';
import test from 'node:test';
import { createAssetReference, parseAssetReference, verifyAssetContent } from './resource.ts';

const encoder = new TextEncoder();

test('typed references bind exact media type, length and SHA-256 to immutable metadata', async () => {
  const bytes = encoder.encode('hello, world');
  const reference = await createAssetReference('document:welcome', 'text', bytes);
  assert.deepEqual(reference, {
    id: 'document:welcome', kind: 'text', mediaType: 'text/plain;charset=utf-8',
    byteLength: 12, sha256: '09ca7e4eaa6e8ae9c7d261167129184883644d07dfba7cbfbc4c8a2e08360d5b',
  });
  assert.equal(Object.isFrozen(reference), true);
  assert.deepEqual(parseAssetReference({ ...reference }), reference);
  assert.equal(await verifyAssetContent(reference, bytes), true);
  assert.equal(await verifyAssetContent(reference, encoder.encode('hello, worle')), false);
});

test('references reject mismatched content types, malformed identifiers and active objects', async () => {
  const bytes = encoder.encode('{}');
  const reference = await createAssetReference('document:config', 'json-document', bytes);
  assert.equal(reference.mediaType, 'application/json');
  assert.throws(() => parseAssetReference({ ...reference, mediaType: 'text/plain;charset=utf-8' }));
  assert.throws(() => parseAssetReference({ ...reference, id: 'https://example.invalid/a' }));
  assert.throws(() => parseAssetReference({ ...reference, extra: true }));
  assert.throws(() => parseAssetReference({ ...reference, get byteLength() { throw new Error('getter'); } }));
  await assert.rejects(() => createAssetReference('document:bad', 'json-document', encoder.encode('{bad')));
  await assert.rejects(() => createAssetReference('document:bad', 'text', new Uint8Array([0xff])));
});

test('resource byte snapshots ignore an overridden typed-array iterator', async () => {
  const bytes = new Uint8Array([65]);
  Object.defineProperty(bytes, Symbol.iterator, { value: function* () { yield 66; yield 67; } });
  const reference = await createAssetReference('document:iterator', 'text', bytes);
  assert.equal(reference.byteLength, 1);
  assert.equal(await verifyAssetContent(reference, new Uint8Array([65])), true);
});
