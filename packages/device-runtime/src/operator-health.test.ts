import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeInspector } from './inspector.ts';
import type { OperatorHealthOptions, OperatorHealthScope } from './operator-health.ts';
const api = await import('./operator-health.ts').catch(() => undefined);
function required<T>(value: { ok: true; value: T } | { ok: false; reason: string }): T { assert.ok(value.ok, JSON.stringify(value)); return value.value; }
function fixture(config: { poll?: () => unknown; authorize?: OperatorHealthOptions['authorize']; grantMs?: number; signal?: AbortSignal; kind?: 'runtime-inspector' | 'wss-transport' } = {}) {
  let at = 0, allowed = false, polls = 0;
  const inspector = createRuntimeInspector({ now: () => at, authorize: () => undefined });
  assert.ok(api, 'an operator needs an independently approved bounded health projection');
  const monitor = api.createOperatorHealthMonitor({ now: () => at,
    scope: { ownerId: 'private-owner', operatorId: 'private-operator', applicationId: 'private-app', sessionId: 'private-session', purpose: 'private-purpose' },
    sources: [{ id: 'private-source', kind: config.kind ?? 'runtime-inspector', poll() { polls++; return config.poll ? config.poll() : inspector.snapshot(); } }],
    authorize(scope) { return config.authorize ? config.authorize(scope) : allowed ? { scope, expiresAt: at + (config.grantMs ?? 1000), isCurrent: () => allowed, ...(config.signal ? { signal: config.signal } : {}) } : undefined; } });
  return { monitor, inspector, setTime(n: number) { at = n; }, allow(v: boolean) { allowed = v; }, polls: () => polls,
    close() { monitor.close(); inspector.close(); } };
}
test('operator metrics use the actual inspector only after separate current read approval', async () => {
  const f = fixture();
  try {
    assert.equal(f.polls(), 0); assert.equal(f.monitor.sample().ok, false);
    assert.equal((await f.monitor.start()).ok, false); assert.equal(f.polls(), 0);
    f.allow(true); required(await f.monitor.start()); const sample = required(f.monitor.sample());
    assert.equal(f.polls(), 1); assert.equal(sample.sources[0]?.state, 'available');
    assert.equal(sample.sources[0]?.metrics?.kind, 'runtime-inspector');
    const report = JSON.stringify(f.monitor.snapshot());
    for (const secret of ['private-owner', 'private-operator', 'private-app', 'private-session', 'private-purpose', 'private-source']) assert.equal(report.includes(secret), false);
  } finally { f.close(); }
});
test('real runtime denial, queue and fixed failure counts do not imply resource authority', async () => {
  const f = fixture();
  const device = (sink = false) => ({ schemaVersion: 1, id: sink ? 'secret-sink' : 'secret-source', label: 'PRIVATE_LABEL', revision: 1,
    adapter: { id: 'example:secret', version: '1.0.0' }, runtime: { platform: 'test' }, capabilities: [{ id: 'signal', semantic: 'secret:value', schemaVersion: 1,
      kind: sink ? 'command' : 'event', value: { type: 'boolean' }, delivery: { mode: 'reliable', maxAgeMs: 1000 }, permissions: [sink ? 'invoke' : 'subscribe'] }] });
  try {
    const runtime = f.inspector.runtime, source = runtime.registerSource({ device: device(), capability: 'signal' });
    const sink = runtime.registerSink({ device: device(true), capability: 'signal', apply() {}, release() {} });
    runtime.setReadiness(source, 'available'); runtime.setReadiness(sink, 'available');
    f.allow(true); required(await f.monitor.start());
    const route = runtime.route({ from: source, to: sink, principalId: 'PRIVATE_PRINCIPAL', applicationId: 'PRIVATE_APP', sessionId: 'PRIVATE_TOKEN' });
    assert.equal(route.start().ok, false);
    const metrics = required(f.monitor.sample()).sources[0]?.metrics; assert.equal(metrics?.kind, 'runtime-inspector');
    if (metrics?.kind === 'runtime-inspector') {
      assert.equal(metrics.resources, 2); assert.equal(metrics.availableResources, 2); assert.equal(metrics.deniedRoutes, 1);
      assert.equal(metrics.activeRoutes, 0); assert.equal(metrics.queuedOperations, 0); assert.ok(metrics.faultsInTrace >= 1); assert.equal(metrics.rawProviderWork, null);
    }
    const report = JSON.stringify(f.monitor.snapshot()); for (const secret of ['PRIVATE_LABEL', 'PRIVATE_PRINCIPAL', 'PRIVATE_APP', 'PRIVATE_TOKEN', 'secret-source', 'secret-sink']) assert.equal(report.includes(secret), false);
  } finally { f.close(); }
});
test('provider values, keys, reasons and getters are excluded from WSS counts', async () => {
  let getters = 0;
  const value = { sent: 7, received: 9, dropped: 2, pending: 0, bufferedBytes: 50, state: 'connected', reason: 'SECRET_REASON',
    payload: 'SECRET_PAYLOAD', key: 'SECRET_KEY', get credential() { getters++; throw Error('SECRET'); } };
  const f = fixture({ kind: 'wss-transport', poll: () => value });
  try {
    f.allow(true); required(await f.monitor.start()); const sample = required(f.monitor.sample());
    assert.deepEqual(sample.sources[0]?.metrics, { kind: 'wss-transport', sentPackets: 7, receivedPackets: 9, droppedPackets: 2, reportedPending: 0, bufferedBytes: 50, connectionState: 'connected' });
    assert.equal(getters, 0); assert.equal(JSON.stringify(f.monitor.snapshot()).includes('SECRET'), false); assert.ok(Object.isFrozen(sample.sources[0]?.metrics));
  } finally { f.close(); }
});
test('malformed or throwing provider yields unavailable with no stale counters or messages', async () => {
  for (const poll of [() => { throw Error('PRIVATE_ERROR'); }, () => ({ sent: Infinity, received: 0, dropped: 0, pending: 0, bufferedBytes: 0 }),
    () => ({ get sent() { throw Error('PRIVATE_ERROR'); }, received: 0, dropped: 0, pending: 0, bufferedBytes: 0 })]) {
    const f = fixture({ kind: 'wss-transport', poll });
    try { f.allow(true); required(await f.monitor.start()); const row = required(f.monitor.sample()).sources[0];
      assert.equal(row?.state, 'unavailable'); assert.equal(row?.metrics, null); assert.equal(JSON.stringify(f.monitor.snapshot()).includes('PRIVATE'), false);
    } finally { f.close(); }
  }
});
test('abort, currentness loss and clock expiry clear retained metadata and do not stop borrowed runtime', async () => {
  for (const mode of ['abort', 'revoked', 'expired']) {
    const abort = new AbortController(), f = fixture({ signal: abort.signal });
    try {
      f.allow(true); required(await f.monitor.start()); required(f.monitor.sample());
      if (mode === 'abort') abort.abort(); else if (mode === 'revoked') f.allow(false); else f.setTime(1000);
      const report = f.monitor.snapshot(); assert.equal(report.samples.length, 0); assert.equal(report.timerArmed, false);
      assert.equal(report.state, mode === 'expired' ? 'expired' : 'revoked'); assert.equal(f.inspector.snapshot().closed, false);
    } finally { f.close(); }
  }
});
test('quiet wall timer retires the grant even when the declared clock is unchanged', async () => {
  const f = fixture({ grantMs: 15 });
  try { f.allow(true); required(await f.monitor.start()); required(f.monitor.sample());
    await new Promise(resolve => setTimeout(resolve, 35)); assert.equal(f.monitor.snapshot().state, 'expired'); assert.equal(f.monitor.snapshot().samples.length, 0);
  } finally { f.close(); }
});
test('stop during provider polling cannot publish partial metadata or poll the next source', async () => {
  let second = 0;
  assert.ok(api); const scope = { ownerId: 'owner', operatorId: 'operator', applicationId: 'app', sessionId: 'session', purpose: 'health' };
  const monitor = api.createOperatorHealthMonitor({ scope, now: () => 0,
    sources: [{ id: 'first', kind: 'wss-transport', poll() { monitor.stop(); return { sent: 1, received: 1, dropped: 0, pending: 0, bufferedBytes: 0 }; } },
      { id: 'second', kind: 'wss-transport', poll() { second++; return {}; } }],
    authorize: scope => ({ scope, expiresAt: 1000, isCurrent: () => true }) });
  try { required(await monitor.start()); assert.equal(monitor.sample().ok, false); assert.equal(second, 0); assert.equal(monitor.snapshot().samples.length, 0); }
  finally { monitor.close(); }
});
test('unsettled authorization remains reserved through logical stop and cannot resurrect the monitor', async () => {
  let complete!: (grant: undefined) => void;
  const f = fixture({ authorize: () => new Promise(resolve => { complete = resolve; }) });
  try {
    const pending = f.monitor.start(); assert.equal(f.monitor.snapshot().rawAuthorizations, 1); f.monitor.stop(); assert.equal((await pending).ok, false);
    assert.deepEqual(await f.monitor.start(), { ok: false, reason: 'busy' }); assert.equal(f.monitor.snapshot().rawAuthorizations, 1);
    complete(undefined); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(f.monitor.snapshot().rawAuthorizations, 0); assert.equal(f.monitor.snapshot().state, 'stopped'); assert.equal(f.polls(), 0);
  } finally { f.close(); }
});
test('wrong exact scope, accessor grant and excessive grant deadline fail before polling', async () => {
  for (const authorize of [
    (scope: OperatorHealthScope) => ({ scope: { ...scope, operatorId: 'other' }, expiresAt: 1000, isCurrent: () => true }),
    (scope: OperatorHealthScope) => ({ scope, expiresAt: 30001, isCurrent: () => true }),
    () => ({ get scope(): OperatorHealthScope { throw Error('PRIVATE'); }, expiresAt: 1000, isCurrent: () => true }),
  ]) {
    const f = fixture({ authorize });
    try { assert.equal((await f.monitor.start()).ok, false); assert.equal(f.polls(), 0); assert.equal(f.monitor.snapshot().samples.length, 0); assert.equal(f.monitor.snapshot().timerArmed, false); }
    finally { f.close(); }
  }
});
test('authorization elapsed deadline is enforced before a queued timer can run', async () => {
  const f = fixture({ authorize(scope) { f.setTime(1001); return { scope, expiresAt: 2000, isCurrent: () => true }; } });
  try { assert.deepEqual(await f.monitor.start(), { ok: false, reason: 'expired' }); assert.equal(f.polls(), 0); assert.equal(f.monitor.snapshot().timerArmed, false); }
  finally { f.close(); }
});
test('rate and history byte/row ceilings retain no provider output and terminal close releases owned work', async () => {
  const f = fixture({ grantMs: 10000 });
  try {
    f.allow(true); required(await f.monitor.start()); required(f.monitor.sample()); assert.deepEqual(f.monitor.sample(), { ok: false, reason: 'rate-limited' });
    for (let index = 1; index < 40; index++) { f.setTime(index * 100); required(f.monitor.sample()); }
    const report = f.monitor.snapshot(); assert.equal(report.samples.length, 32); assert.ok(report.retainedBytes <= 32768);
    f.monitor.close(); assert.equal(f.monitor.snapshot().samples.length, 0); assert.equal(f.monitor.snapshot().timerArmed, false); assert.equal((await f.monitor.start()).ok, false);
  } finally { f.close(); }
});
test('backward or reentrant clock fails closed and cannot retain previous samples', async () => {
  const f = fixture();
  try { f.allow(true); required(await f.monitor.start()); f.setTime(10); required(f.monitor.sample()); f.setTime(0);
    assert.equal(f.monitor.sample().ok, false); assert.equal(f.monitor.snapshot().state, 'closed'); assert.equal(f.monitor.snapshot().samples.length, 0);
  } finally { f.close(); }
});
test('clock cancellation fences both initial authorization dispatch and final timer publication', async () => {
  assert.ok(api);
  for (const stopOnClockCall of [1, 8]) {
    let calls = 0, authorizations = 0, polls = 0;
    const monitor = api.createOperatorHealthMonitor({
      scope: { ownerId: 'owner', operatorId: 'operator', applicationId: 'app', sessionId: 'session', purpose: 'health' },
      now() { if (++calls === stopOnClockCall) monitor.stop(); return 0; },
      sources: [{ id: 'transport', kind: 'wss-transport', poll() { polls++; return { sent: 0, received: 0, dropped: 0, pending: 0, bufferedBytes: 0 }; } }],
      authorize(scope) { authorizations++; return { scope, expiresAt: 1000, isCurrent: () => true }; },
    });
    try {
      assert.equal((await monitor.start()).ok, false); assert.equal(monitor.sample().ok, false); assert.equal(polls, 0);
      const snapshot = monitor.snapshot(); assert.equal(snapshot.state, 'stopped'); assert.equal(snapshot.timerArmed, false);
      if (stopOnClockCall === 1) assert.equal(authorizations, 0);
    } finally { monitor.close(); }
  }
});
test('stale grant validation cannot retire a fresh explicitly started metadata approval', async () => {
  assert.ok(api); let replace = false, replacement: Promise<unknown> | undefined;
  let authorizations = 0;
  const monitor = api.createOperatorHealthMonitor({
    scope: { ownerId: 'owner', operatorId: 'operator', applicationId: 'app', sessionId: 'session', purpose: 'health' }, now: () => 0,
    sources: [{ id: 'transport', kind: 'wss-transport', poll: () => ({ sent: 0, received: 0, dropped: 0, pending: 0, bufferedBytes: 0 }) }],
    authorize(scope) { authorizations++; return { scope, expiresAt: 1000, isCurrent() {
      if (replace) { replace = false; monitor.stop(); replacement = monitor.start(); } return true;
    } }; },
  });
  try {
    required(await monitor.start()); replace = true; monitor.snapshot(); assert.ok(replacement);
    assert.deepEqual(await replacement, { ok: true, value: undefined }); assert.equal(authorizations, 2); assert.equal(monitor.snapshot().state, 'active');
  } finally { monitor.close(); }
});
test('final grant clock must remain before both grant and authorization deadlines', async () => {
  assert.ok(api);
  for (const [after, expiresAt] of [[1000, 1000], [1500, 2000]]) {
    let calls = 0;
    const monitor = api.createOperatorHealthMonitor({
      scope: { ownerId: 'owner', operatorId: 'operator', applicationId: 'app', sessionId: 'session', purpose: 'health' },
      now: () => ++calls < 8 ? 0 : after!,
      sources: [{ id: 'transport', kind: 'wss-transport', poll: () => ({ sent: 0, received: 0, dropped: 0, pending: 0, bufferedBytes: 0 }) }],
      authorize: scope => ({ scope, expiresAt: expiresAt!, isCurrent: () => true }),
    });
    try { assert.deepEqual(await monitor.start(), { ok: false, reason: 'expired' }); assert.equal(monitor.snapshot().state, 'expired'); assert.equal(monitor.snapshot().timerArmed, false); }
    finally { monitor.close(); }
  }
});
