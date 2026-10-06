import assert from 'node:assert/strict';
import { createDeviceRuntime, createWorkspaceAdministration, WORKSPACE_ADMINISTRATION_PROFILE, WORKSPACE_ADMINISTRATION_LIMITS } from '@101/connect';
import * as runtimeApi from '@101/device-runtime';

assert.equal(createWorkspaceAdministration, runtimeApi.createWorkspaceAdministration);
assert.equal(WORKSPACE_ADMINISTRATION_PROFILE, 'local-workspace-administration/1');
assert.equal(WORKSPACE_ADMINISTRATION_LIMITS.routes, 16);
const checks = [];
function check(name, run) { run(); checks.push(name); }
function device(id, { sink = false, observe = false, command = false } = {}) {
  return { schemaVersion: 1, id, label: id, revision: 1, adapter: { id: 'example:local-host', version: '1.0.0' }, runtime: { platform: 'local-node' },
    capabilities: [{ id: 'enabled', semantic: command ? 'example:enabled-command' : 'example:enabled-state', schemaVersion: 1,
      kind: sink ? command ? 'command' : 'property' : command ? 'event' : 'sample', value: { type: 'boolean' },
      delivery: command ? { mode: 'reliable', maxAgeMs: 1000 } : { mode: 'latest', maxHz: 30, maxAgeMs: 1000 },
      permissions: sink ? [command ? 'invoke' : 'write'] : ['subscribe'], ...(sink ? { ownership: { mode: observe ? 'observe' : 'exclusive' } } : {}) }] };
}
function fixture({ nativeTime = false, grantMs = 1000 } = {}) {
  let virtualAt = 0, active = false, released = 0, sequence = 0, rawPending = 0;
  let sourceDenied = false, sinkDenied = false, copiedSource = false;
  let apply = (observation, context) => { active = observation.value; observations.push(observation); contexts.push(context); };
  const time = () => nativeTime ? performance.now() : virtualAt;
  const actorSignals = [], sourceSignals = [], sinkSignals = [], approvals = [], observations = [], contexts = [];
  const authenticatedActors = new Set(['owner', 'admin']);
  const runtime = createDeviceRuntime({ now: time, clockDomain: 'owned-local-producer', maxPendingDeliveries: 1,
    authorize: request => controller.authorizeRoute(request) });
  const sourceDevice = device('source'), sinkDevice = device('sink', { sink: true }), observerDevice = device('observer-output', { sink: true, observe: true });
  const commandSourceDevice = device('command-source', { command: true }), commandSinkDevice = device('command-sink', { sink: true, command: true });
  const source = runtime.registerSource({ device: sourceDevice, capability: 'enabled' });
  const sink = runtime.registerSink({ device: sinkDevice, capability: 'enabled', apply: (observation, context) => apply(observation, context),
    release() { active = false; released++; } });
  const observer = runtime.registerSink({ device: observerDevice, capability: 'enabled', apply: (observation, context) => apply(observation, context),
    release() { active = false; released++; } });
  const commandSource = runtime.registerSource({ device: commandSourceDevice, capability: 'enabled' });
  const commandSink = runtime.registerSink({ device: commandSinkDevice, capability: 'enabled', apply() { assert.fail('Observer command effect'); }, release() {} });
  for (const handle of [source, sink, observer, commandSource, commandSink]) runtime.setReadiness(handle, 'available');
  function resourceApproval(request, side) {
    approvals.push({ owner: request.ownerId, side: request.side, operation: side === 'source' ? request.route.sourceOperation : request.route.sinkOperation });
    assert.equal(request.workspaceId, 'workspace'); assert.equal(request.side, side);
    assert.equal(request.ownerId, side === 'source' ? 'source-owner' : request.route.sink.registrationId === observer.id ? 'observer-owner' : 'sink-owner');
    assert.equal(Object.isFrozen(request), true); assert.equal(Object.isFrozen(request.route), true);
    if (side === 'source' ? sourceDenied : sinkDenied) return;
    const signal = new AbortController(); (side === 'source' ? sourceSignals : sinkSignals).push(signal);
    return { request: side === 'source' && copiedSource ? { ...request } : request, expiresAt: time() + grantMs, maxHz: 30, maxAgeMs: 1000, signal: signal.signal };
  }
  const controller = createWorkspaceAdministration({ workspaceId: 'workspace', ownerPrincipalId: 'owner', now: time,
    resources: [{ id: 'source', ownerId: 'source-owner', handle: source, device: sourceDevice, capability: 'enabled' },
      { id: 'sink', ownerId: 'sink-owner', handle: sink, device: sinkDevice, capability: 'enabled' },
      { id: 'observer', ownerId: 'observer-owner', handle: observer, device: observerDevice, capability: 'enabled', observerOutput: true },
      { id: 'command-source', ownerId: 'source-owner', handle: commandSource, device: commandSourceDevice, capability: 'enabled' },
      { id: 'command-sink', ownerId: 'sink-owner', handle: commandSink, device: commandSinkDevice, capability: 'enabled' }],
    authorizeAdministration(request) {
      if (!authenticatedActors.has(request.actorId)) return;
      const signal = new AbortController(); actorSignals.push(signal);
      return { request, expiresAt: time() + 1000, signal: signal.signal };
    }, authorizeSource: request => resourceApproval(request, 'source'), authorizeSink: request => resourceApproval(request, 'sink') });
  function revision() { const result = controller.inspect('owner'); assert.equal(result.ok, true); return result.value.revision; }
  function change(value, actor = 'owner') { return controller.change(actor, revision(), value); }
  function rule(principalId = 'participant', sinkId = 'sink') { return { id: principalId, principalId, applicationId: 'local-app', sessionId: 'local-session',
    sourceId: 'source', sinkId, sourceOperation: 'subscribe', sinkOperation: 'write', expiresAt: time() + 1000, maxHz: 30, maxAgeMs: 1000 }; }
  function route(principalId = 'participant', to = sink) { return controller.route(runtime, { from: source, to, principalId, applicationId: 'local-app', sessionId: 'local-session', leaseMs: 1000, queueCapacity: 1 }); }
  function setup() {
    assert.equal(controller.create('owner').ok, true);
    assert.equal(change({ type: 'add-member', principalId: 'admin', role: 'administrator' }).ok, true);
    assert.equal(change({ type: 'add-member', principalId: 'participant', role: 'participant' }, 'admin').ok, true);
    assert.equal(change({ type: 'add-member', principalId: 'observer', role: 'observer' }, 'admin').ok, true);
    assert.equal(change({ type: 'set-sharing', rule: rule() }, 'admin').ok, true);
    assert.equal(change({ type: 'set-sharing', rule: rule('observer', 'observer') }, 'admin').ok, true);
  }
  function publish(value) { return runtime.publish(source, value, { sequence: ++sequence, timestamp: time(), clockDomain: runtime.clockDomain,
    quality: 'valid', provenance: { producer: 'owned-local-software-state', privatePayload: 'not-administration-data' } }); }
  return { controller, runtime, source, sink, observer, rule, route, setup, change, revision, publish, approvals, observations, contexts, sourceSignals, sinkSignals,
    time: value => { virtualAt = value; }, active: () => active, released: () => released, rawPending: () => rawPending,
    denied: (side, value) => { if (side === 'source') sourceDenied = value; else sinkDenied = value; }, copied: value => { copiedSource = value; },
    held() { let finish; apply = (observation, context) => { active = observation.value; observations.push(observation); contexts.push(context); rawPending++;
      return new Promise(resolve => { finish = () => { rawPending--; resolve(); }; }); }; return () => finish(); },
    close() { controller.close(); runtime.close(); } };
}
const h = fixture();
try {
  check('default denial before explicit creation', () => { assert.deepEqual(h.controller.create('stranger'), { ok: false, reason: 'denied' }); assert.equal(h.route().ok, false); });
  h.setup();
  check('explicit create delegated membership and complete audit', () => { assert.equal(h.revision(), 6); const audit = h.controller.audit('owner'); assert.equal(audit.ok, true);
    assert.deepEqual(audit.value.map(item => item.revision), [1, 2, 3, 4, 5, 6]); assert.deepEqual(h.controller.inspect('participant'), { ok: false, reason: 'denied' }); });
  check('delegated admin cannot appoint admin remove owner or self promote', () => {
    for (const value of [{ type: 'set-role', principalId: 'participant', role: 'administrator' }, { type: 'remove-member', principalId: 'owner' },
      { type: 'set-role', principalId: 'admin', role: 'administrator' }]) assert.deepEqual(h.change(value, 'admin'), { ok: false, reason: 'denied' }); });
  check('observer output classification is trusted options only', () => {
    assert.deepEqual(h.change({ type: 'set-sharing', rule: h.rule('observer', 'sink') }), { ok: false, reason: 'denied' });
    assert.deepEqual(h.change({ type: 'set-sharing', rule: { ...h.rule('observer'), sourceId: 'command-source', sinkId: 'command-sink', sinkOperation: 'invoke' } }), { ok: false, reason: 'denied' });
    assert.deepEqual(h.change({ type: 'set-sharing', rule: { ...h.rule('observer'), observerOutput: true } }), { ok: false, reason: 'invalid' }); });
  check('closed inputs and actual registration identity', () => {
    let invoked = false; const value = { type: 'remove-member', get principalId() { invoked = true; return 'participant'; } };
    assert.deepEqual(h.change(value), { ok: false, reason: 'invalid' }); assert.equal(invoked, false);
    assert.equal(h.controller.route(h.runtime, { from: { ...h.source }, to: h.sink, principalId: 'participant', applicationId: 'local-app', sessionId: 'local-session' }).ok, false); });
  check('stale expected revision cannot commit', () => { assert.deepEqual(h.controller.change('owner', 1, { type: 'remove-member', principalId: 'participant' }), { ok: false, reason: 'stale' }); });
  for (const side of ['source', 'sink']) check(`separate ${side} owner denial`, () => {
    h.denied(side, true); const route = h.route(); assert.equal(route.ok, true); assert.deepEqual(route.value.start(), { ok: false, reason: 'denied' });
    h.publish(true); h.runtime.flush(); assert.equal(h.active(), false); route.value.stop(); h.denied(side, false); });
  check('copied resource approval scope cannot authorize', () => { h.copied(true); const route = h.route(); assert.deepEqual(route.value.start(), { ok: false, reason: 'denied' }); route.value.stop(); h.copied(false); });
  const route = h.route(); assert.equal(route.ok, true);
  check('actual runtime prepare then fresh activation', () => { assert.equal(route.value.prepare().ok, true); assert.equal(h.active(), false); assert.equal(route.value.activate().ok, true); });
  check('genuine typed publisher observation and local sink effect', () => { assert.equal(h.publish(true).ok, true); h.runtime.flush(); assert.equal(h.active(), true);
    const observed = h.observations.at(-1); assert.equal(observed.value, true); assert.equal(observed.clockDomain, 'owned-local-producer');
    assert.equal(observed.quality, 'valid'); assert.equal(observed.provenance.producer, 'owned-local-software-state'); assert.equal(observed.source.registrationId, h.source.id); });
  check('administration snapshot and audit exclude payload signals and credentials', () => {
    const serialized = JSON.stringify({ snapshot: h.controller.inspect('owner').value, audit: h.controller.audit('owner').value });
    for (const forbidden of ['not-administration-data', 'privatePayload', 'AbortSignal', 'signal', 'credential', 'token']) assert.equal(serialized.includes(forbidden), false); });
  check('membership removal retires actual connection releases held output', () => { assert.equal(h.change({ type: 'remove-member', principalId: 'participant' }, 'admin').ok, true);
    assert.equal(route.value.status().state, 'closed'); assert.equal(h.active(), false); assert.equal(h.released(), 1); assert.equal(h.contexts.at(-1).isCurrent(), false);
    h.publish(true); h.runtime.flush(); assert.equal(h.active(), false); assert.equal(h.route().ok, false); });
  check('re-enrollment requires fresh resource approvals old handle stays closed', () => { assert.equal(h.change({ type: 'add-member', principalId: 'participant', role: 'participant' }, 'admin').ok, true);
    assert.equal(h.change({ type: 'set-sharing', rule: h.rule() }, 'admin').ok, true); const count = h.approvals.length;
    const replacement = h.route(); assert.equal(replacement.value.start().ok, true); assert.equal(h.approvals.length, count + 2);
    assert.equal(route.value.start().ok, false); replacement.value.stop(); });
  check('observer receives only separately approved observe-owned output', () => { const output = h.route('observer', h.observer); assert.equal(output.value.start().ok, true);
    h.publish(true); h.runtime.flush(); assert.equal(h.active(), true); output.value.stop(); assert.equal(h.active(), false); });
  const finish = h.held(), held = h.route(); assert.equal(held.value.start().ok, true); h.publish(true); h.runtime.flush();
  check('owner signal revocation aborts active native delivery context', () => { assert.equal(h.rawPending(), 1); h.sourceSignals.at(-1).abort();
    assert.equal(held.value.status().state, 'closed'); assert.equal(h.contexts.at(-1).signal.aborted, true); assert.equal(h.active(), false); });
  const waiting = h.route(); assert.equal(waiting.value.start().ok, true); h.publish(false); h.runtime.flush();
  check('logical retirement retains actual raw provider quota', () => { assert.equal(h.rawPending(), 1); assert.equal(h.observations.at(-1).value, true); });
  finish(); await Promise.resolve(); await Promise.resolve(); h.runtime.flush();
  check('actual raw settlement permits queued delivery', () => { assert.equal(h.observations.at(-1).value, false); assert.equal(h.rawPending(), 1); });
  finish(); await Promise.resolve(); await Promise.resolve(); waiting.value.stop();
  check('policy withdrawal retires idle managed handle', () => { const pending = h.route(); assert.equal(pending.ok, true);
    assert.equal(h.change({ type: 'revoke-sharing', ruleId: 'participant' }, 'admin').ok, true); assert.equal(pending.value.status().state, 'closed'); });
  check('close retires all handles and requires fresh controller recovery', () => { h.close(); assert.deepEqual(h.controller.create('owner'), { ok: false, reason: 'closed' }); });
} finally { h.close(); }
const unique = fixture();
try {
  unique.setup(); const first = unique.route(); assert.equal(first.ok, true);
  check('live duplicate authorization tuple denied while first is idle', () => {
    const duplicate = unique.route(); assert.equal(duplicate.ok, false, 'Duplicate live tuple must be denied before runtime dispatch'); assert.equal(duplicate.reason, 'busy');
    assert.equal(unique.approvals.length, 0);
  });
  assert.equal(first.value.start().ok, true); unique.publish(true); unique.runtime.flush();
  check('unique tuple owner signal retires the actually active local output', () => {
    assert.equal(unique.active(), true); unique.sourceSignals.at(-1).abort(); assert.equal(first.value.status().state, 'closed');
    assert.equal(unique.active(), false); assert.equal(unique.released(), 1); assert.equal(unique.contexts.at(-1).isCurrent(), false);
  });
  check('actual first stop permits replacement with fresh owner approvals', () => {
    first.value.stop(); const count = unique.approvals.length, replacement = unique.route(); assert.equal(replacement.ok, true);
    assert.equal(replacement.value.start().ok, true); assert.equal(unique.approvals.length, count + 2);
    unique.publish(true); unique.runtime.flush(); assert.equal(unique.active(), true); unique.sourceSignals.at(-1).abort();
    assert.equal(replacement.value.status().state, 'closed'); assert.equal(unique.active(), false); assert.equal(unique.released(), 2);
  });
  check('provisional exact tuple blocks native host-route getter reentry', () => {
    let nested, dispatched = 0;
    const port = { get route() { nested = unique.route(); return request => { dispatched++; return unique.runtime.route(request); }; },
      revoke: connection => unique.runtime.revoke(connection) };
    const outer = unique.controller.route(port, { from: unique.source, to: unique.sink, principalId: 'participant', applicationId: 'local-app', sessionId: 'local-session', leaseMs: 1000, queueCapacity: 1 });
    assert.equal(outer.ok, true); assert.equal(nested.ok, false, 'Provisional tuple must deny duplicate before real handle exists'); assert.equal(nested.reason, 'busy'); assert.equal(dispatched, 1);
    assert.equal(outer.value.start().ok, true); unique.publish(true); unique.runtime.flush(); assert.equal(unique.active(), true);
    unique.sourceSignals.at(-1).abort(); assert.equal(outer.value.status().state, 'closed'); assert.equal(unique.active(), false);
  });
} finally { unique.close(); }
const timed = fixture({ nativeTime: true, grantMs: 40 });
try {
  timed.setup(); const route = timed.route(); assert.equal(route.value.start().ok, true); timed.publish(true); timed.runtime.flush(); assert.equal(timed.active(), true);
  await new Promise(resolve => setTimeout(resolve, 70));
  check('owned native expiry timer retires output without a runtime flush', () => { assert.equal(route.value.status().state, 'closed'); assert.equal(timed.active(), false); assert.equal(timed.released(), 1); });
} finally { timed.close(); }
const fresh = fixture();
try {
  fresh.setup(); const route = fresh.route(); assert.equal(route.value.start().ok, true); fresh.publish(true); fresh.runtime.flush();
  check('fresh explicitly approved owner recovers without executable or persisted authority', () => assert.equal(fresh.active(), true));
} finally { fresh.close(); }
process.stdout.write(JSON.stringify({ status: 'pass', profile: WORKSPACE_ADMINISTRATION_PROFILE, checks, limits: WORKSPACE_ADMINISTRATION_LIMITS,
  transport: 'none', target: 'actual public JS runtime and local software publisher/sink', persistentAuthority: false,
  scope: 'ephemeral cooperative host composition; all routes use the administration controller',
  excluded: ['accounts', 'persistent team administration', 'unmanaged or malicious host routes', 'physical devices', 'transport authentication', 'cross-process administration'] }) + '\n');
