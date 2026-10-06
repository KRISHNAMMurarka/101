import assert from 'node:assert/strict';
import test from 'node:test';

test('media source and sink consent each narrow the actual route; missing consent rejects', async () => {
  const api = await import('./media-grants.ts');
  const source = { expiresAt: 5000, maxHz: 30, maxAgeMs: 100 };
  const sink = { expiresAt: 4000, maxHz: 15, maxAgeMs: 80 };
  assert.deepEqual(api.intersectMediaRouteGrants(source, sink, 1000), { expiresAt: 4000, maxHz: 15, maxAgeMs: 80 });
  assert.equal(api.intersectMediaRouteGrants(undefined, sink, 1000), undefined);
  assert.equal(api.intersectMediaRouteGrants(source, undefined, 1000), undefined);
  assert.equal(api.intersectMediaRouteGrants(source, sink, 4000), undefined);
});

test('closed current media grants reject accessors, extension fields, invalid time and oversized lifetimes', async () => {
  const api = await import('./media-grants.ts');
  const grant = { expiresAt: 2000, maxHz: 30, maxAgeMs: 100 };
  let called = false;
  const accessor = { get expiresAt() { called = true; return 2000; }, maxHz: 30, maxAgeMs: 100 };
  for (const invalid of [accessor, { ...grant, cameraPermission: true }, { ...grant, expiresAt: 32000 }, { ...grant, maxHz: 31 },
    { ...grant, maxAgeMs: 1001 }, Object.create(grant), { ...grant, expiresAt: NaN }])
    assert.equal(api.intersectMediaRouteGrants(invalid, grant, 1000), undefined);
  assert.equal(called, false);
  for (const now of [-1, NaN, Infinity]) assert.equal(api.intersectMediaRouteGrants(grant, grant, now), undefined);
});
