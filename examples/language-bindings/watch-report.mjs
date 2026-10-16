import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDeviceRuntime, createWatchCompanionResources, decodeWatchCompanionReport, watchCompanionReportDevice } from '@101/connect';

/** Shared software grammar cases. Reading/decoding creates no enrollment or route. */
export function readWatchReportFixtures(path) {
  const bytes = readFileSync(path); assert.ok(bytes.byteLength <= 32768);
  const source = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  assert.equal(source.schemaVersion, 1); assert.equal(source.contract, 'watch-report-contracts/1');
  assert.deepEqual(source.applicability, { javascript: 'watch-companion-report/1', swift: 'legacy-watch-payload/1', kotlin: 'legacy-watch-payload/1', c: 'watch-report-c-strict/1' });
  assert.deepEqual(source.limits, { fixtureBytes: 32768, golden: 16, decode: 64, commands: 128, lineBytes: 4096,
    rawInputBytes: 256, outputBytes: 131072, nativeDeadlineMs: 30000 });
  assert.match(source.baseHex, /^[0-9a-f]{106}$/);
  assert.ok(Array.isArray(source.golden) && source.golden.length >= 6 && source.golden.length <= 16);
  assert.ok(Array.isArray(source.decode) && source.decode.length >= 20 && source.decode.length <= 64);
  const identities = new Set();
  for (const entry of source.golden) {
    assert.deepEqual(Object.keys(entry.accept).sort(), ['c']);
    assert.equal(entry.accept.c, true, entry.id);
  }
  for (const entry of [...source.golden, ...source.decode]) {
    assert.match(entry.id, /^[a-z0-9-]{1,64}$/); assert.equal(identities.has(entry.id), false); identities.add(entry.id);
    materializeWatchReportFixture(source, entry); watchReportFixtureMeaning(source, entry);
  }
  for (const entry of source.decode) {
    assert.deepEqual(Object.keys(entry.accept).sort(), ['c', 'javascript', 'kotlin', 'swift']);
    assert.ok(Object.values(entry.accept).every(value => typeof value === 'boolean'));
    assert.equal(entry.accept.c, entry.accept.javascript, entry.id);
    assert.equal(entry.accept.swift, entry.accept.kotlin);
    if (entry.accept.javascript !== entry.accept.swift) assert.equal(entry.difference, 'legacy-masks-reserved-buttons-strict-profile-rejects');
  }
  return source;
}
export function materializeWatchReportFixture(source, entry) {
  const bytes = Uint8Array.from(Buffer.from(source.baseHex, 'hex'));
  assert.ok((entry.patches ?? []).length <= 16);
  for (const patch of entry.patches ?? []) {
    assert.deepEqual(Object.keys(patch).sort(), ['hex', 'offset']);
    assert.ok(Number.isInteger(patch.offset) && patch.offset >= 0);
    assert.match(patch.hex, /^(?:[0-9a-f]{2}){1,53}$/);
    const selected = Buffer.from(patch.hex, 'hex'); assert.ok(patch.offset + selected.byteLength <= 53);
    bytes.set(selected, patch.offset);
  }
  if (entry.length !== undefined) {
    assert.ok(Number.isInteger(entry.length) && entry.length >= 0 && entry.length <= 256);
    const resized = new Uint8Array(entry.length); resized.set(bytes.subarray(0, entry.length)); return resized;
  }
  return bytes;
}
export function watchReportFixtureMeaning(source, entry) {
  const value = { ...source.baseMeaning, ...entry.changes };
  assert.deepEqual(Object.keys(value).sort(), ['accelerationG', 'crownReported', 'orientationReported', 'relayEmissionMs', 'rotationDegPerSecond', 'sequence', 'tap']);
  assert.ok(Number.isInteger(value.sequence) && value.sequence >= 0 && value.sequence <= 65535);
  assert.ok(Number.isInteger(value.relayEmissionMs) && value.relayEmissionMs >= 0 && value.relayEmissionMs <= 4294967295);
  assert.equal(typeof value.tap, 'boolean');
  for (const [key, count] of [['orientationReported', 4], ['accelerationG', 3], ['rotationDegPerSecond', 3]]) {
    assert.ok(Array.isArray(value[key]) && value[key].length === count && value[key].every(item => typeof item === 'number' && Number.isFinite(Math.fround(item))));
    value[key] = value[key].map(Math.fround);
  }
  assert.ok(typeof value.crownReported === 'number' && Number.isFinite(Math.fround(value.crownReported)));
  value.crownReported = Math.fround(value.crownReported); return value;
}
export function verifyWatchJavaScriptFixtures(source) {
  for (const entry of source.golden) assert.deepEqual(decodeWatchCompanionReport(materializeWatchReportFixture(source, entry)),
    { ...watchReportFixtureMeaning(source, entry), physicalValidity: 'unspecified' }, entry.id);
  for (const entry of source.decode) {
    const bytes = materializeWatchReportFixture(source, entry);
    if (entry.accept.javascript) assert.deepEqual(decodeWatchCompanionReport(bytes), { ...watchReportFixtureMeaning(source, entry), physicalValidity: 'unspecified' });
    else assert.throws(() => decodeWatchCompanionReport(bytes), entry.id);
  }
  return { golden: source.golden.length, decode: source.decode.length,
    incompatibilities: source.decode.filter(entry => entry.accept.javascript !== entry.accept.swift).map(entry => entry.id), c: source.applicability.c };
}

/** Native codec bytes feed current public SDK source/sink routes through explicitly software bridge ports.
 * Actual watch OS delivery and enrollment authentication are unqualified; enrollment is separately issued.
 */
export async function runWatchReportHostProof(nativeBeforeHex, nativeAfterHex) {
  const checks = [];
  for (const platform of ['watchos', 'wearos']) {
    let at = 0, epoch = 0, issued, listener, owner = new AbortController(), sourceApproved = false, sinkApproved = false, nativeStarts = 0, nativeStops = 0, releases = 0;
    const applied = [], pendingStops = new Set();
    const bridge = {
      async enroll(signal) {
        assert.equal(signal.aborted, false); const issuer = new AbortController();
        issued = Object.freeze({ platform, epoch: ++epoch, signal: issuer.signal,
          snapshot: Object.freeze({ platform, companionPaired: true, appInstalled: true, reachable: true, nearby: platform === 'wearos' }) });
        return issued;
      },
      async start(enrollment, report, _loss, signal) { assert.equal(enrollment, issued); assert.equal(signal.aborted, false); nativeStarts++; listener = report; },
      stop(enrollment) {
        assert.ok(enrollment); nativeStops++;
        const pending = Promise.resolve(); pendingStops.add(pending); pending.finally(() => pendingStops.delete(pending)); return pending;
      }
    };
    const descriptor = watchCompanionReportDevice('watch:contract-sink', platform);
    const runtime = createDeviceRuntime({ now: () => at, clockDomain: 'contract-host-receipt', authorize: request =>
      sinkApproved && request.principalId === 'sink-owner' && request.applicationId === 'watch-contract' && request.sessionId === 'owned-software-' + platform &&
      request.sourceOperation === 'subscribe' && request.sinkOperation === 'write' ? { expiresAt: 2000, maxAgeMs: 250, maxHz: 30 } : undefined });
    const sink = runtime.registerSink({ device: { ...descriptor, capabilities: descriptor.capabilities.map(capability =>
      ({ ...capability, permissions: ['write'], ownership: { mode: 'exclusive' } })) }, capability: 'report',
      apply(observation, context) { assert.equal(context.isCurrent(), true); assert.equal(context.signal.aborted, false); applied.push(observation); }, release() { releases++; } });
    runtime.setReadiness(sink, 'available');
    const resources = createWatchCompanionResources({ runtime, bridge, ownerId: 'source-owner', now: () => at,
      approve: request => sourceApproved ? { request, signal: owner.signal, expiresAt: 2000 } : undefined });
    const route = source => runtime.route({ from: source, to: sink, principalId: 'sink-owner', applicationId: 'watch-contract',
      sessionId: 'owned-software-' + platform, sourceOperation: 'subscribe', leaseMs: 1000 });
    function emit(hex, enrollment = issued, callback = listener) { callback({ enrollment, data: Buffer.from(hex, 'hex').toString('base64') }); runtime.flush(); }
    async function settle() { await Promise.all([...pendingStops]); await new Promise(resolveTurn => setImmediate(resolveTurn)); }
    try {
      assert.equal((await resources.start()).ok, false); assert.equal(nativeStarts, 0); checks.push(platform + ':source-denial-before-start');
      sourceApproved = true; let started = await resources.start(); assert.equal(started.ok, true);
      const denied = route(started.value); assert.equal(denied.start().ok, false); assert.equal(applied.length, 0); checks.push(platform + ':independent-sink-denial');
      sinkApproved = true; const active = route(started.value); assert.equal(active.start().ok, true);
      emit(nativeBeforeHex, { ...issued }); assert.equal(applied.length, 0); checks.push(platform + ':copied-enrollment-does-not-authorize');
      emit(nativeBeforeHex); assert.equal(applied.length, 1); assert.equal(applied[0].value.sequence, 65535);
      assert.equal(applied[0].timestamp, 0); assert.equal(applied[0].clockDomain, 'contract-host-receipt');
      assert.equal(applied[0].provenance.captureTimeKnown, false); assert.equal(applied[0].value.relayEmissionMs, 1234567);
      checks.push(platform + ':native-bytes-current-route-separate-emission-receipt');
      at = 40; emit(nativeAfterHex); assert.equal(applied.length, 2); assert.equal(applied[1].value.sequence, 0); assert.equal(applied[1].value.relayEmissionMs, 1234568);
      checks.push(platform + ':sequence-wrap-retains-original-emission');
      runtime.revoke(active); assert.equal(releases, 1); at = 80; emit(nativeAfterHex); assert.equal(applied.length, 2);
      checks.push(platform + ':revoke-releases-and-replay-cannot-apply'); await settle();
      const oldEnrollment = issued, oldListener = listener; owner = new AbortController();
      started = await resources.start(); assert.equal(started.ok, true); const replacement = route(started.value); assert.equal(replacement.start().ok, true);
      emit(nativeBeforeHex, oldEnrollment, oldListener); emit(nativeBeforeHex, oldEnrollment); assert.equal(applied.length, 2);
      emit(nativeBeforeHex); assert.equal(applied.length, 3); checks.push(platform + ':fresh-enrollment-stale-epoch-and-callback-fenced');
      owner.abort(); assert.equal(replacement.status().state, 'closed'); assert.equal(releases, 2); await settle();
      owner = new AbortController(); started = await resources.start(); assert.equal(started.ok, true);
      const expires = route(started.value); assert.equal(expires.start().ok, true); at = 2000; resources.sweep();
      assert.equal(expires.status().state, 'closed'); assert.equal(releases, 3); emit(nativeBeforeHex); assert.equal(applied.length, 3);
      checks.push(platform + ':absolute-expiry-releases'); await settle();
    } finally { resources.close(); runtime.close(); await settle(); }
    assert.equal(resources.status().pendingNativeOperations, 0); assert.equal(pendingStops.size, 0); assert.ok(nativeStops >= 3);
  }
  return { checks, nativeBytes: 'actual compiled WatchPayload encoders', nativeBridge: 'explicit software ports, not native OS delivery',
    captureTimeKnown: false, physicalValidity: 'unspecified', sourceAndSinkApprovals: 'independent', cleanup: { pendingNativeOperations: 0, runtimeClosed: true } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === '--fixtures' && process.argv.length === 4) console.log(JSON.stringify(verifyWatchJavaScriptFixtures(readWatchReportFixtures(process.argv[3]))));
  else if (process.argv[2] === '--host-proof' && process.argv.length === 5) console.log(JSON.stringify(await runWatchReportHostProof(process.argv[3], process.argv[4])));
  else throw new Error('Use --fixtures <owned-fixture> or --host-proof <native-before-hex> <native-after-hex>');
}
