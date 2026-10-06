import assert from 'node:assert/strict';
import test from 'node:test';
const api = await import('./native-discovery.ts').catch(() => undefined);
// Actual installed dns-sd LocalOnly browse/resolve tuple retained in the initial
// feasibility receipt. Held callbacks below qualify lifecycle only, not native DNS.
const serviceType = '_101l2e8b429e._tcp', name = '101-owned-2e8b429e', port = 50927;
const event = () => ({ version: 1 as const, type: 'resolved' as const, interfaceIndex: 0xffffffff, name, serviceType,
  domain: 'local.', target: 'localhost.', port, txtHex: '0970726f66696c653d31' });
function fixture() {
  assert.ok(api, 'actual native DNS-SD tuples need a current owner-scoped provider controller');
  let now = 1000, allowed = true, current = true, opened = 0, stopped = 0;
  let callbacks: Parameters<import('./native-discovery.ts').NativeDiscoveryProvider['open']>[1] | undefined;
  const abort = new AbortController();
  const scope = { ownerId: 'owner', applicationId: 'local-software', sessionId: 'own-session', serviceType, domain: 'local.' as const,
    interfaceIndex: 0xffffffff as const, profile: 'macos-local-only-dns-sd/1' as const, operation: 'observe' as const };
  const controller = api.createNativeDiscoveryController({ scope, now: () => now,
    provider: { profile: scope.profile, open(_scope, cb) { opened++; callbacks = cb; return { stop() { stopped++; } }; } },
    authorize(request) { return allowed ? { scope: request, expiresAt: now + 10000, isCurrent: () => current, signal: abort.signal } : undefined; } });
  return { controller, scope, abort, now(value: number) { now = value; }, allow(value: boolean) { allowed = value; }, current(value: boolean) { current = value; },
    event(value = event()) { callbacks?.event(value); }, exited() { callbacks?.closed(); }, opened: () => opened, stopped: () => stopped };
}

test('real producer-shaped tuples are inert before explicit grant and create issued observed-only receipts', () => {
  const f = fixture(); try {
    assert.equal(f.opened(), 0); f.allow(false); assert.equal(f.controller.start().ok, false); assert.equal(f.opened(), 0);
    f.allow(true); assert.ok(f.controller.start().ok); f.event();
    const row = f.controller.snapshot().rows[0]; assert.ok(row); assert.equal(row.service.port, port);
    assert.equal(f.controller.assess(row.handle)?.state, 'observed'); assert.equal(f.controller.assess({ ...row.handle }), undefined);
    assert.equal(row.candidate.evidence.length, 1); assert.equal(row.candidate.evidence[0]?.kind, 'observation');
    assert.equal(f.controller.snapshot().rows.length, 1); f.event(); assert.equal(f.controller.snapshot().rows.length, 1);
  } finally { f.controller.close(); }
});

test('withdrawal, quiet expiry, abort and late callbacks remove stale opaque handles and retain raw process reservation', () => {
  for (const mode of ['withdraw', 'expiry', 'abort', 'close'] as const) {
    const f = fixture(); try { assert.ok(f.controller.start().ok); f.event(); const row = f.controller.snapshot().rows[0]!;
      if (mode === 'withdraw') f.event({ version: 1, type: 'removed', interfaceIndex: 0xffffffff, name, serviceType, domain: 'local.' } as unknown as ReturnType<typeof event>);
      if (mode === 'expiry') { f.now(3000); f.controller.sweep(); }
      if (mode === 'abort') f.abort.abort(); if (mode === 'close') f.controller.close();
      assert.equal(f.controller.snapshot().rows.length, 0); assert.equal(f.controller.assess(row.handle), undefined);
      if (mode === 'abort' || mode === 'close') { f.event(); assert.equal(f.controller.snapshot().rows.length, 0);
        assert.equal(f.controller.snapshot().rawReservations, 1); f.exited(); assert.equal(f.controller.snapshot().rawReservations, 0); }
    } finally { f.controller.close(); }
  }
});

test('foreign interface/domain/type/target and malformed TXT never create authority', () => {
  const f = fixture(); try { assert.ok(f.controller.start().ok);
    for (const change of [{ interfaceIndex: 0 }, { domain: 'external.example.' }, { serviceType: '_other._tcp' },
      { target: 'external.example.' }, { txtHex: 'ff00' }, { port: 0 }]) {
      f.event({ ...event(), ...change }); assert.equal(f.controller.snapshot().rows.length, 0);
    }
  } finally { f.controller.close(); }
});

test('candidate and event quotas are finite; raw exit is required before explicit new start', () => {
  const f = fixture(); try {
    assert.ok(f.controller.start().ok);
    for (let index = 0; index < 17; index++) f.event({ ...event(), name: 'owned-' + index });
    assert.equal(f.controller.snapshot().rows.length, 16); assert.ok(f.controller.snapshot().transitions.some(item => item.event === 'candidate-capacity'));
    f.controller.stop(); assert.deepEqual(f.controller.start(), { ok: false, reason: 'busy' }); assert.equal(f.controller.snapshot().rawReservations, 1);
    f.event(); assert.equal(f.controller.snapshot().rows.length, 0); f.exited(); assert.ok(f.controller.start().ok);
    for (let index = 0; index < 65; index++) f.event();
    assert.equal(f.controller.snapshot().phase, 'unavailable'); assert.equal(f.controller.snapshot().rows.length, 0);
  } finally { f.controller.close(); }
});

test('provider loss retires every observation without automatic restart or restored grants', () => {
  const f = fixture(); try { assert.ok(f.controller.start().ok); f.event(); const row = f.controller.snapshot().rows[0]!;
    f.exited(); assert.equal(f.controller.assess(row.handle), undefined); assert.equal(f.controller.snapshot().rows.length, 0);
    assert.equal(f.controller.snapshot().timerArmed, false); assert.equal(f.opened(), 1);
    assert.ok(f.controller.start().ok); assert.equal(f.opened(), 2); assert.equal(f.controller.assess(row.handle), undefined);
  } finally { f.controller.close(); }
});

test('missing host backend is truthfully unsupported and construction performs no clock or authorization callbacks', () => {
  assert.ok(api); let calls = 0;
  const controller = api.createNativeDiscoveryController({ scope: fixture().scope, now() { calls++; return 1000; }, authorize() { calls++; return undefined; } });
  try { assert.equal(calls, 0); assert.equal(controller.snapshot().phase, 'unsupported'); assert.deepEqual(controller.start(), { ok: false, reason: 'unsupported' }); assert.equal(calls, 0); }
  finally { controller.close(); }
});

test('returned nested candidate bytes cannot extend observed receipt lifetime or mutate scope', () => {
  const f = fixture(); try { assert.ok(f.controller.start().ok); f.event(); const row = f.controller.snapshot().rows[0]!;
    assert.throws(() => { (row.candidate as unknown as { expiresAt: number }).expiresAt = 20000; });
    assert.throws(() => { (row.candidate.evidence[0]!.scope as unknown as { id: string }).id = 'another-owner'; });
    f.now(3000); f.controller.sweep(); assert.equal(f.controller.snapshot().rows.length, 0);
  } finally { f.controller.close(); }
});

test('a malformed returned operation cannot falsely release already issued raw reservation', () => {
  assert.ok(api); const f = fixture(); let closed!: () => void;
  const controller = api.createNativeDiscoveryController({ scope: f.scope, now: () => 1000,
    provider: { profile: f.scope.profile, open(_scope, callbacks) { closed = callbacks.closed; return undefined as unknown as import('./native-discovery.ts').NativeDiscoveryOperation; } },
    authorize: scope => ({ scope, expiresAt: 10000, isCurrent: () => true }) });
  try { assert.equal(controller.start().ok, false); assert.equal(controller.snapshot().rawReservations, 1);
    assert.deepEqual(controller.start(), { ok: false, reason: 'busy' }); closed(); assert.equal(controller.snapshot().rawReservations, 0);
  } finally { controller.close(); f.controller.close(); }
});

test('current grant loss/expiry stops rows and native work without claiming raw exit', () => {
  for (const mode of ['revoked', 'expired'] as const) {
    const f = fixture(); try { assert.ok(f.controller.start().ok); f.event();
      if (mode === 'revoked') f.current(false); else f.now(11000); f.controller.sweep();
      assert.equal(f.controller.snapshot().rows.length, 0); assert.equal(f.controller.snapshot().timerArmed, false);
      assert.equal(f.controller.snapshot().rawReservations, 1); assert.equal(f.stopped(), 1);
      f.event(); assert.equal(f.controller.snapshot().rows.length, 0); f.exited(); assert.equal(f.controller.snapshot().rawReservations, 0);
    } finally { f.controller.close(); }
  }
});

test('approval accessors and reentrant current callbacks cannot activate native resources after closure', () => {
  assert.ok(api); const original = fixture(); let opened = 0, reads = 0;
  for (const mode of ['accessor', 'reentrant'] as const) {
    const controller = api.createNativeDiscoveryController({ scope: original.scope, now: () => 1000,
      provider: { profile: original.scope.profile, open() { opened++; return { stop() {} }; } },
      authorize: scope => mode === 'accessor' ? { scope, get expiresAt() { reads++; return 10000; }, isCurrent: () => true } :
        { scope, expiresAt: 10000, isCurrent() { controller.close(); return true; } } });
    try { assert.equal(controller.start().ok, false); assert.equal(opened, 0); assert.equal(reads, 0); assert.equal(controller.snapshot().timerArmed, false); }
    finally { controller.close(); }
  }
  original.controller.close();
});

test('provider activation reentrancy fences returned operation and waits for real closed callback', () => {
  assert.ok(api); const original = fixture(); let closed!: () => void, stops = 0;
  const controller = api.createNativeDiscoveryController({ scope: original.scope, now: () => 1000,
    provider: { profile: original.scope.profile, open(_scope, callbacks) { closed = callbacks.closed; controller.close(); callbacks.event(event()); return { stop() { stops++; } }; } },
    authorize: scope => ({ scope, expiresAt: 10000, isCurrent: () => true }) });
  assert.equal(controller.start().ok, false); assert.equal(controller.snapshot().phase, 'closed'); assert.equal(controller.snapshot().rows.length, 0);
  assert.equal(controller.snapshot().timerArmed, false); assert.equal(controller.snapshot().rawReservations, 1); assert.equal(stops, 1);
  closed(); assert.equal(controller.snapshot().rawReservations, 0); original.controller.close();
});

for (const mode of ['clock', 'authorize'] as const) test(`stop during initial ${mode} cancels pending admission before native open`, () => {
  assert.ok(api); const original = fixture();
    let cancel = true, cancelled = false, opened = 0, authorizations = 0;
    const controller = api.createNativeDiscoveryController({ scope: original.scope,
      now() { if (cancel && !cancelled && mode === 'clock') { cancelled = true; controller.stop(); } return 1000; },
      provider: { profile: original.scope.profile, open() { opened++; return { stop() {} }; } },
      authorize(scope) { authorizations++; if (cancel && !cancelled && mode === 'authorize') { cancelled = true; controller.stop(); } return { scope, expiresAt: 10000, isCurrent: () => true }; } });
    try {
      assert.equal(controller.start().ok, false); assert.equal(opened, 0); assert.equal(controller.snapshot().rawReservations, 0);
      assert.equal(controller.snapshot().timerArmed, false); assert.equal(authorizations, mode === 'clock' ? 0 : 1);
      cancel = false; assert.ok(controller.start().ok); assert.equal(opened, 1);
    } finally { controller.close(); }
  original.controller.close();
});
