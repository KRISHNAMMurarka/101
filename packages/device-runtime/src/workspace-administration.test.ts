import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceRuntime } from './index.ts';
import type { DeliveryContext, Observation } from './types.ts';
import { createWorkspaceAdministration } from './workspace-administration.ts';
import type { WorkspaceAdministrationChange, WorkspaceResource, WorkspaceResourceApprovalRequest, WorkspaceSharingRule } from './workspace-administration.ts';
import type { Connection, EndpointHandle, RouteRequest } from './types.ts';

const modulePath = './workspace-administration.ts';

test('explicit workspace administration requires an exact current actor approval before creation', async () => {
  const api = await import(modulePath).catch(() => ({}));
  assert.equal(typeof api.createWorkspaceAdministration, 'function', 'Missing workspace administration controller');
  const controller = api.createWorkspaceAdministration({ workspaceId: 'workspace', ownerPrincipalId: 'owner', resources: [],
    now: () => 0, authorizeAdministration: () => undefined, authorizeSource: () => undefined, authorizeSink: () => undefined });
  assert.deepEqual(controller.create('owner'), { ok: false, reason: 'denied' });
  controller.close();
});

function device(id: string, sink = false, observe = false, command = false) {
  return { schemaVersion: 1, id, label: id, revision: 1, adapter: { id: 'example:local', version: '1.0.0' }, runtime: { platform: 'local' },
    capabilities: [{ id: 'state', semantic: command ? 'example:command' : 'example:boolean', schemaVersion: 1,
      kind: sink ? command ? 'command' : 'property' : command ? 'event' : 'sample', value: { type: 'boolean' },
      delivery: command ? { mode: 'reliable', maxAgeMs: 1000 } : { mode: 'latest', maxHz: 30, maxAgeMs: 1000 },
      permissions: sink ? [command ? 'invoke' : 'write'] : ['subscribe'], ...(sink ? { ownership: { mode: observe ? 'observe' : 'exclusive' } } : {}) }] };
}
async function fixture() {
  const api = await import(modulePath);
  let at = 0, effect = false, releases = 0;
  let clockCallback: (() => void) | undefined;
  const calls: string[] = [], ownerControllers: AbortController[] = [], contexts: DeliveryContext[] = [];
  let administration: (request: unknown) => unknown = request => ({ request, expiresAt: at + 1000, signal: new AbortController().signal });
  let sourceApproval: (request: unknown) => unknown = request => { calls.push('source'); const controller = new AbortController(); ownerControllers.push(controller);
    return { request, expiresAt: at + 1000, maxHz: 30, maxAgeMs: 1000, signal: controller.signal }; };
  let sinkApproval: (request: unknown) => unknown = request => { calls.push('sink'); const controller = new AbortController(); ownerControllers.push(controller);
    return { request, expiresAt: at + 1000, maxHz: 30, maxAgeMs: 1000, signal: controller.signal }; };
  let apply: (value: Observation, context: DeliveryContext) => void | Promise<void> = (value, context) => { effect = value.value as boolean; contexts.push(context); };
  const runtime = createDeviceRuntime({ now: () => at, maxPendingDeliveries: 1, authorize: request => controller.authorizeRoute(request) });
  const sourceDevice = device('source'), sinkDevice = device('sink', true), observedDevice = device('observed', true, true);
  const commandSourceDevice = device('command-source', false, false, true), commandSinkDevice = device('command-sink', true, false, true);
  const source = runtime.registerSource({ device: sourceDevice, capability: 'state' });
  const sink = runtime.registerSink({ device: sinkDevice, capability: 'state', apply: (value, context) => apply(value, context), release: () => { effect = false; releases++; } });
  const observed = runtime.registerSink({ device: observedDevice, capability: 'state', apply: (value, context) => apply(value, context), release: () => { effect = false; releases++; } });
  const commandSource = runtime.registerSource({ device: commandSourceDevice, capability: 'state' });
  const commandSink = runtime.registerSink({ device: commandSinkDevice, capability: 'state', apply() { effect = true; }, release() { effect = false; releases++; } });
  for (const handle of [source, sink, observed, commandSource, commandSink]) runtime.setReadiness(handle, 'available');
  const controller = api.createWorkspaceAdministration({ workspaceId: 'workspace', ownerPrincipalId: 'owner', now: () => { clockCallback?.(); return at; },
    resources: [{ id: 'source', ownerId: 'device-owner-a', handle: source, device: sourceDevice, capability: 'state' },
      { id: 'sink', ownerId: 'device-owner-b', handle: sink, device: sinkDevice, capability: 'state' },
      { id: 'observed', ownerId: 'device-owner-c', handle: observed, device: observedDevice, capability: 'state', observerOutput: true },
      { id: 'command-source', ownerId: 'device-owner-a', handle: commandSource, device: commandSourceDevice, capability: 'state' },
      { id: 'command-sink', ownerId: 'device-owner-b', handle: commandSink, device: commandSinkDevice, capability: 'state' }],
    authorizeAdministration: (request: unknown) => administration(request), authorizeSource: (request: unknown) => sourceApproval(request), authorizeSink: (request: unknown) => sinkApproval(request) });
  const rule = (principalId = 'member', sinkId = 'sink') => ({ id: 'rule', principalId, applicationId: 'app', sessionId: 'session', sourceId: 'source', sinkId,
    sourceOperation: 'subscribe', sinkOperation: 'write', expiresAt: 1000, maxHz: 30, maxAgeMs: 1000 });
  const request = (principalId = 'member', to = sink) => ({ from: source, to, principalId, applicationId: 'app', sessionId: 'session', leaseMs: 1000, queueCapacity: 1 });
  function setup(role = 'participant', sinkId = 'sink') {
    assert.equal(controller.create('owner').ok, true);
    assert.equal(controller.change('owner', 1, { type: 'add-member', principalId: 'member', role }).ok, true);
    assert.equal(controller.change('owner', 2, { type: 'set-sharing', rule: rule('member', sinkId) }).ok, true);
  }
  return { api, controller, runtime, source, sink, observed, commandSource, commandSink, rule, request, setup, calls, ownerControllers, contexts,
    at: (value: number) => { at = value; }, clock: (value?: () => void) => { clockCallback = value; }, effect: () => effect, releases: () => releases,
    administration: (value: typeof administration) => { administration = value; }, sourceApproval: (value: typeof sourceApproval) => { sourceApproval = value; },
    sinkApproval: (value: typeof sinkApproval) => { sinkApproval = value; }, apply: (value: typeof apply) => { apply = value; },
    close: () => { controller.close(); runtime.close(); } };
}

test('membership, policy and complete audit revisions commit atomically after actor approval', async () => {
  const h = await fixture(); try {
    h.setup(); const snapshot = h.controller.inspect('owner'); assert.equal(snapshot.ok, true);
    assert.equal(snapshot.value.revision, 3); assert.deepEqual(snapshot.value.members, [{ principalId: 'member', role: 'participant' }]);
    assert.deepEqual(h.controller.audit('owner').value.map((event: { revision: number }) => event.revision), [1, 2, 3]);
    assert.deepEqual(h.controller.change('owner', 2, { type: 'remove-member', principalId: 'member' }), { ok: false, reason: 'stale' });
    h.administration(() => undefined);
    assert.deepEqual(h.controller.change('owner', 3, { type: 'remove-member', principalId: 'member' }), { ok: false, reason: 'denied' });
    h.administration(request => ({ request, expiresAt: 1000, signal: new AbortController().signal }));
    assert.equal(h.controller.inspect('owner').value.revision, 3); assert.equal(h.controller.audit('owner').value.length, 3);
  } finally { h.close(); }
});

test('outsiders, self promotion, owner removal and delegated admin escalation fail before approval', async () => {
  const h = await fixture(); try {
    h.setup(); assert.deepEqual(h.controller.inspect('member'), { ok: false, reason: 'denied' });
    assert.deepEqual(h.controller.change('member', 3, { type: 'set-role', principalId: 'member', role: 'administrator' }), { ok: false, reason: 'denied' });
    assert.deepEqual(h.controller.change('owner', 3, { type: 'remove-member', principalId: 'owner' }), { ok: false, reason: 'denied' });
    assert.equal(h.controller.change('owner', 3, { type: 'add-member', principalId: 'admin', role: 'administrator' }).ok, true);
    assert.deepEqual(h.controller.change('admin', 4, { type: 'set-role', principalId: 'member', role: 'administrator' }), { ok: false, reason: 'denied' });
    assert.deepEqual(h.controller.change('admin', 4, { type: 'remove-member', principalId: 'admin' }), { ok: false, reason: 'denied' });
    assert.equal(h.controller.change('admin', 4, { type: 'set-role', principalId: 'member', role: 'observer' }).ok, true);
  } finally { h.close(); }
});

test('exact administration scope, native signals and final clock fence are required', async () => {
  for (const kind of ['copied', 'callback', 'spoof', 'aborted', 'clock-abort', 'clock-close']) {
    const h = await fixture(); try {
      const signal = new AbortController();
      h.administration(request => {
        if (kind === 'clock-abort') h.clock(() => signal.abort());
        if (kind === 'clock-close') h.clock(() => h.controller.close());
        if (kind === 'aborted') signal.abort();
        return kind === 'callback' ? { request, expiresAt: 1000, isCurrent: () => true } :
          { request: kind === 'copied' ? { ...request as object } : request, expiresAt: 1000,
            signal: kind === 'spoof' ? { aborted: false } : signal.signal };
      });
      assert.equal(h.controller.create('owner').ok, false, kind);
    } finally { h.close(); }
  }
});

test('reentrant administration is busy and close prevents late state publication', async () => {
  const h = await fixture(); try {
    h.administration(request => {
      assert.deepEqual(h.controller.create('owner'), { ok: false, reason: 'busy' });
      return { request, expiresAt: 1000, signal: new AbortController().signal };
    });
    assert.equal(h.controller.create('owner').ok, true);
    h.administration(request => { h.controller.close(); return { request, expiresAt: 1000, signal: new AbortController().signal }; });
    assert.deepEqual(h.controller.change('owner', 1, { type: 'add-member', principalId: 'member', role: 'participant' }), { ok: false, reason: 'closed' });
  } finally { h.close(); }
});

test('actual runtime delivery requires membership policy plus separate source and sink consent', async () => {
  const h = await fixture(); try {
    h.setup(); const result = h.controller.route(h.runtime, h.request()); assert.equal(result.ok, true);
    assert.equal(result.value.start().ok, true); assert.deepEqual(h.calls, ['source', 'sink']);
    assert.equal(h.runtime.publish(h.source, true, { sequence: 1, timestamp: 0, clockDomain: h.runtime.clockDomain, provenance: { producer: 'test' } }).ok, true);
    h.runtime.flush(); assert.equal(h.effect(), true);
    assert.equal(h.controller.change('owner', 3, { type: 'remove-member', principalId: 'member' }).ok, true);
    assert.equal(result.value.status().state, 'closed'); assert.equal(h.effect(), false); assert.equal(h.contexts[0]?.isCurrent(), false);
    h.runtime.publish(h.source, true); h.runtime.flush(); assert.equal(h.effect(), false);
  } finally { h.close(); }
});

test('each resource owner can deny independently and copied scope cannot grant', async () => {
  for (const side of ['source', 'sink', 'copied-source']) {
    const h = await fixture(); try {
      h.setup();
      if (side === 'source') h.sourceApproval(() => undefined);
      if (side === 'sink') h.sinkApproval(() => undefined);
      if (side === 'copied-source') h.sourceApproval(request => ({ request: { ...request as object }, expiresAt: 1000, maxHz: 30, maxAgeMs: 1000, signal: new AbortController().signal }));
      const route = h.controller.route(h.runtime, h.request()); assert.equal(route.ok, true); assert.deepEqual(route.value.start(), { ok: false, reason: 'denied' });
      h.runtime.publish(h.source, true); h.runtime.flush(); assert.equal(h.effect(), false);
      assert.deepEqual(h.calls, side === 'sink' ? ['source'] : []);
    } finally { h.close(); }
  }
});

test('observer routes require immutable trusted observe output and deny command effects', async () => {
  const h = await fixture(); try {
    h.setup('observer', 'observed'); const route = h.controller.route(h.runtime, h.request('member', h.observed));
    assert.equal(route.ok, true); assert.equal(route.value.start().ok, true); h.runtime.publish(h.source, true); h.runtime.flush(); assert.equal(h.effect(), true);
    assert.deepEqual(h.controller.change('owner', 3, { type: 'set-sharing', rule: h.rule() }), { ok: false, reason: 'denied' });
    assert.deepEqual(h.controller.change('owner', 3, { type: 'set-sharing', rule: { ...h.rule(), sourceId: 'command-source', sinkId: 'command-sink', sinkOperation: 'invoke' } }), { ok: false, reason: 'denied' });
    assert.deepEqual(h.controller.route(h.runtime, h.request()), { ok: false, reason: 'denied' });
  } finally { h.close(); }
});

test('resource grant cross-callout abortion and shadowed native signal cannot authorize', async () => {
  for (const kind of ['sink-aborts-source', 'clock-aborts-sink', 'shadowed-aborted']) {
    const h = await fixture(); try {
      h.setup(); const source = new AbortController(), sink = new AbortController();
      if (kind === 'shadowed-aborted') { source.abort(); Object.defineProperty(source.signal, 'aborted', { value: false }); }
      h.sourceApproval(request => ({ request, expiresAt: 1000, maxHz: 30, maxAgeMs: 1000, signal: source.signal }));
      h.sinkApproval(request => { if (kind === 'sink-aborts-source') source.abort(); if (kind === 'clock-aborts-sink') h.clock(() => sink.abort());
        return { request, expiresAt: 1000, maxHz: 30, maxAgeMs: 1000, signal: sink.signal }; });
      const route = h.controller.route(h.runtime, h.request()); assert.equal(route.ok, true); assert.equal(route.value.start().ok, false);
      h.runtime.publish(h.source, true); h.runtime.flush(); assert.equal(h.effect(), false);
    } finally { h.close(); }
  }
});

test('signal revocation, policy replacement and downgrade retire real handles and fresh routes need fresh consent', async () => {
  for (const kind of ['source', 'sink', 'policy', 'downgrade']) {
    const h = await fixture(); try {
      h.setup(); const route = h.controller.route(h.runtime, h.request()); assert.equal(route.value.start().ok, true);
      h.runtime.publish(h.source, true); h.runtime.flush();
      if (kind === 'source' || kind === 'sink') h.ownerControllers[kind === 'source' ? 0 : 1]!.abort();
      else if (kind === 'policy') assert.equal(h.controller.change('owner', 3, { type: 'revoke-sharing', ruleId: 'rule' }).ok, true);
      else assert.equal(h.controller.change('owner', 3, { type: 'set-role', principalId: 'member', role: 'observer' }).ok, true);
      assert.equal(route.value.status().state, 'closed', kind); assert.equal(h.effect(), false, kind);
      if (kind === 'source' || kind === 'sink') {
        const replacement = h.controller.route(h.runtime, h.request()); assert.equal(replacement.ok, true); assert.equal(replacement.value.start().ok, true);
        assert.equal(h.ownerControllers.length, 4); assert.equal(route.value.start().ok, false);
      }
    } finally { h.close(); }
  }
});

test('retirement does not release actual unresolved core provider reservation', async () => {
  const h = await fixture(); try {
    h.setup(); let finish: (() => void) | undefined;
    h.apply((_value, context) => { h.contexts.push(context); return new Promise<void>(resolve => { finish = resolve; }); });
    const first = h.controller.route(h.runtime, h.request()); assert.equal(first.value.start().ok, true);
    h.runtime.publish(h.source, true); h.runtime.flush(); assert.equal(h.contexts.length, 1);
    h.ownerControllers[0]!.abort(); assert.equal(h.contexts[0]!.signal.aborted, true);
    const next = h.controller.route(h.runtime, h.request()); assert.equal(next.value.start().ok, true);
    h.runtime.publish(h.source, false); h.runtime.flush(); assert.equal(h.contexts.length, 1);
    finish!(); await Promise.resolve(); await Promise.resolve(); h.runtime.flush(); assert.equal(h.contexts.length, 2);
  } finally { h.close(); }
});

test('managed route reservation fences a real handle returned after synchronous host reentry', async () => {
  for (const kind of ['close', 'remove']) {
    const h = await fixture(); try {
      h.setup(); let actual;
      const port = { route(request: Parameters<typeof h.runtime.route>[0]) { actual = h.runtime.route(request);
        if (kind === 'close') h.controller.close(); else h.controller.change('owner', 3, { type: 'remove-member', principalId: 'member' }); return actual; },
        revoke(connection: Parameters<typeof h.runtime.revoke>[0]) { h.runtime.revoke(connection); } };
      const result = h.controller.route(port, h.request()); assert.equal(result.ok, false); assert.equal(actual!.status().state, 'closed');
      h.runtime.publish(h.source, true); h.runtime.flush(); assert.equal(h.effect(), false);
    } finally { h.close(); }
  }
});

test('closed dense changes and resource identity validation cannot execute accessors or trust forged handles', async () => {
  const h = await fixture(); try {
    h.setup(); let reads = 0;
    const change = { type: 'remove-member', get principalId() { reads++; return 'member'; } };
    assert.deepEqual(h.controller.change('owner', 3, change), { ok: false, reason: 'invalid' }); assert.equal(reads, 0);
    assert.deepEqual(h.controller.change('owner', 3, { type: 'remove-member', principalId: 'member', extra: true }), { ok: false, reason: 'invalid' });
    assert.deepEqual(h.controller.route(h.runtime, { ...h.request(), from: { ...h.source } }), { ok: false, reason: 'denied' });
    assert.deepEqual(h.controller.route(h.runtime, { ...h.request(), applicationId: 'other' }), { ok: false, reason: 'denied' });
    assert.deepEqual(h.controller.route(h.runtime, { ...h.request(), queueCapacity: 2 }), { ok: false, reason: 'invalid' });
  } finally { h.close(); }
});

test('expired policy and grant do not revive; regressing clock closes handles permanently', async () => {
  const h = await fixture(); try {
    h.setup(); const route = h.controller.route(h.runtime, h.request()); assert.equal(route.value.start().ok, true);
    h.at(1000); assert.equal(h.controller.route(h.runtime, h.request()).ok, false); assert.equal(route.value.status().state, 'closed');
    h.at(999); assert.equal(h.controller.inspect('owner').ok, false); assert.equal(h.controller.create('owner').ok, false);
  } finally { h.close(); }
});

test('finite membership, delegation, managed route and lifetime attempt quotas reject without partial changes', async () => {
  const h = await fixture(); try {
    h.setup(); let revision = 3;
    for (const principalId of ['admin-a', 'admin-b']) assert.equal(h.controller.change('owner', revision++, { type: 'add-member', principalId, role: 'administrator' }).ok, true);
    assert.deepEqual(h.controller.change('owner', revision, { type: 'add-member', principalId: 'admin-c', role: 'administrator' }), { ok: false, reason: 'capacity' });
    const requests = [h.request()];
    for (let count = 1; count < 16; count++) {
      const sessionId = `session-${count}`;
      assert.equal(h.controller.change('owner', revision++, { type: 'set-sharing', rule: { ...h.rule(), id: `rule-${count}`, sessionId } }).ok, true);
      requests.push({ ...h.request(), sessionId });
    }
    const routes = [];
    for (const request of requests) { const result = h.controller.route(h.runtime, request); assert.equal(result.ok, true); routes.push(result.value); }
    assert.deepEqual(h.controller.route(h.runtime, h.request()), { ok: false, reason: 'capacity' });
    for (const route of routes) route.stop();
    for (let count = 0; count < 48; count++) { const result = h.controller.route(h.runtime, h.request()); assert.equal(result.ok, true); result.value.stop(); }
    assert.deepEqual(h.controller.route(h.runtime, h.request()), { ok: false, reason: 'capacity' });
    assert.equal(h.controller.inspect('owner').value.revision, revision);
  } finally { h.close(); }
});

test('policy revocation during resource consent prevents final activation and does not recreate membership', async () => {
  const h = await fixture(); try {
    h.setup(); h.sourceApproval(request => {
      assert.equal(h.controller.change('owner', 3, { type: 'remove-member', principalId: 'member' }).ok, true);
      return { request, expiresAt: 1000, maxHz: 30, maxAgeMs: 1000, signal: new AbortController().signal };
    });
    const route = h.controller.route(h.runtime, h.request()); assert.equal(route.value.start().ok, false);
    assert.equal(route.value.status().state, 'closed'); assert.deepEqual(h.controller.inspect('owner').value.members, []);
  } finally { h.close(); }
});

test('late close-listener cleanup returned after synchronous close is released exactly once', async () => {
  const h = await fixture(); try {
    h.setup(); let removed = 0;
    const port = { route(request: Parameters<typeof h.runtime.route>[0]) {
      const actual = h.runtime.route(request), observe = actual.onClose.bind(actual);
      actual.onClose = listener => { const remove = observe(listener); h.controller.close(); return () => { removed++; remove(); }; };
      return actual;
    }, revoke: h.runtime.revoke.bind(h.runtime) };
    assert.equal(h.controller.route(port, h.request()).ok, false); assert.equal(removed, 1);
  } finally { h.close(); }
});

test('sharing expiry during actor approval rejects without committing policy or audit', async () => {
  const h = await fixture(); try {
    h.setup(); h.administration(request => { h.at(1000); return { request, expiresAt: 2000, signal: new AbortController().signal }; });
    assert.deepEqual(h.controller.change('owner', 3, { type: 'set-sharing', rule: h.rule() }), { ok: false, reason: 'expired' });
    h.administration(request => ({ request, expiresAt: 2000, signal: new AbortController().signal }));
    assert.equal(h.controller.inspect('owner').value.revision, 3); assert.equal(h.controller.audit('owner').value.length, 3);
  } finally { h.close(); }
});

test('identical live managed authorization tuples reject before dispatch and owner abort retires the actual active handle', async () => {
  const h = await fixture(); try {
    h.setup(); let dispatched = 0;
    const port = { route(request: Parameters<typeof h.runtime.route>[0]) { dispatched++; return h.runtime.route(request); }, revoke: h.runtime.revoke.bind(h.runtime) };
    const first = h.controller.route(port, h.request()); assert.equal(first.ok, true);
    const duplicate = h.controller.route(port, { ...h.request(), leaseMs: 500, constraints: { expiresAt: 500, maxHz: 20, maxAgeMs: 500 } });
    assert.deepEqual(duplicate, { ok: false, reason: 'busy' }); assert.equal(dispatched, 1);
    assert.equal(first.value.start().ok, true); h.runtime.publish(h.source, true); h.runtime.flush(); assert.equal(h.effect(), true);
    h.ownerControllers[0]!.abort(); assert.equal(first.value.status().state, 'closed'); assert.equal(h.effect(), false); assert.equal(h.releases(), 1);
    assert.equal(h.contexts[0]!.isCurrent(), false);
  } finally { h.close(); }
});

test('provisional exact tuple reservation rejects synchronous duplicate host-route method and getter reentry', async () => {
  for (const kind of ['method', 'getter']) {
    const h = await fixture(); try {
      h.setup(); let nested, dispatched = 0;
      const reenter = () => { nested = h.controller.route(h.runtime, h.request()); };
      const port = { get route() {
        if (kind === 'getter') reenter();
        return (request: Parameters<typeof h.runtime.route>[0]) => { if (kind === 'method') reenter(); dispatched++; return h.runtime.route(request); };
      }, revoke: h.runtime.revoke.bind(h.runtime) };
      const outer = h.controller.route(port, h.request()); assert.equal(outer.ok, true, kind);
      assert.deepEqual(nested, { ok: false, reason: 'busy' }, kind); assert.equal(dispatched, 1);
      assert.equal(outer.value.start().ok, true); h.runtime.publish(h.source, true); h.runtime.flush();
      assert.equal(h.effect(), true); h.ownerControllers[0]!.abort(); assert.equal(outer.value.status().state, 'closed'); assert.equal(h.effect(), false);
    } finally { h.close(); }
  }
});

test('actual first stop permits unique fresh replacement with new owner signals and abort releases only its current handle', async () => {
  const h = await fixture(); try {
    h.setup(); const first = h.controller.route(h.runtime, h.request()); assert.equal(first.value.start().ok, true);
    assert.equal(h.ownerControllers.length, 2); first.value.stop();
    const next = h.controller.route(h.runtime, h.request()); assert.equal(next.ok, true); assert.equal(next.value.start().ok, true); assert.equal(h.ownerControllers.length, 4);
    h.ownerControllers[0]!.abort(); assert.equal(next.value.status().state, 'active');
    h.runtime.publish(h.source, true); h.runtime.flush(); assert.equal(h.effect(), true);
    h.ownerControllers[2]!.abort(); assert.equal(next.value.status().state, 'closed'); assert.equal(h.effect(), false); assert.equal(h.releases(), 2);
  } finally { h.close(); }
});

test('removed participant recovery cannot reuse retired consent or disturb an independent participant', { timeout: 5000 }, t => {
  type Who = "a" | "b";
  let at = 0, revision = 0;
  const effects = { a: false, b: false }, releases = { a: 0, b: 0 };
  const contexts: Record<Who, DeliveryContext[]> = { a: [], b: [] };
  const calls: { side: "source" | "sink"; ownerId: string; principalId: string }[] = [];
  const grants: { principalId: string; side: "source" | "sink"; owner: AbortController }[] = [];
  const runtime = createDeviceRuntime({ now: () => at, clockDomain: 's06-software-clock',
    authorize: request => controller.authorizeRoute(request) });
  const resources: WorkspaceResource[] = [];
  const handles = {} as Record<Who, { source: EndpointHandle; sink: EndpointHandle }>;
  for (const who of ['a', 'b'] as const) {
    const sourceDevice = device(`source-${who}`), sinkDevice = device(`sink-${who}`, true);
    const source = runtime.registerSource({ device: sourceDevice, capability: 'state' });
    const sink = runtime.registerSink({ device: sinkDevice, capability: 'state',
      apply(observation, context) { if (context.isCurrent()) { effects[who] = observation.value as boolean; contexts[who].push(context); } },
      release() { effects[who] = false; releases[who]++; } });
    runtime.setReadiness(source, 'available'); runtime.setReadiness(sink, 'available');
    handles[who] = { source, sink };
    resources.push({ id: `source-${who}`, ownerId: `source-owner-${who}`, handle: source, device: sourceDevice, capability: 'state' },
      { id: `sink-${who}`, ownerId: `sink-owner-${who}`, handle: sink, device: sinkDevice, capability: 'state' });
  }
  const approveResource = (request: WorkspaceResourceApprovalRequest) => {
    const owner = new AbortController();
    calls.push({ side: request.side, ownerId: request.ownerId, principalId: request.route.principalId });
    grants.push({ principalId: request.route.principalId, side: request.side, owner });
    return { request, expiresAt: 1000, maxHz: 30, maxAgeMs: 1000, signal: owner.signal };
  };
  const controller = createWorkspaceAdministration({ workspaceId: 's06-isolation', ownerPrincipalId: 'owner', resources, now: () => at,
    authorizeAdministration: request => ({ request, expiresAt: 1000, signal: new AbortController().signal }),
    authorizeSource: approveResource, authorizeSink: approveResource });
  const mutate = (change: WorkspaceAdministrationChange) => { const result = controller.change('owner', revision, change); assert.equal(result.ok, true); revision++; };
  const rule = (who: Who): WorkspaceSharingRule => ({ id: `rule-${who}`, principalId: `member-${who}`, applicationId: 'app', sessionId: 'session',
    sourceId: `source-${who}`, sinkId: `sink-${who}`, sourceOperation: 'subscribe', sinkOperation: 'write',
    expiresAt: 1000, maxHz: 30, maxAgeMs: 1000 });
  const request = (who: Who, to = handles[who].sink): RouteRequest => ({ from: handles[who].source, to, principalId: `member-${who}`,
    applicationId: 'app', sessionId: 'session', leaseMs: 1000, queueCapacity: 1 });
  const publish = (who: Who, value: boolean) => { assert.equal(runtime.publish(handles[who].source, value).ok, true); runtime.flush(); };
  let aFirst: Connection | undefined, aFresh: Connection | undefined, b: Connection | undefined;
  try {
    assert.equal(controller.create('owner').ok, true); revision = 1;
    for (const who of ['a', 'b'] as const) mutate({ type: 'add-member', principalId: `member-${who}`, role: 'participant' });
    for (const who of ['a', 'b'] as const) mutate({ type: 'set-sharing', rule: rule(who) });
    const aResult = controller.route(runtime, request('a')), bResult = controller.route(runtime, request('b'));
    assert.equal(aResult.ok, true); assert.equal(bResult.ok, true); aFirst = aResult.value; b = bResult.value;
    assert.equal(aFirst.start().ok, true); assert.equal(b.start().ok, true);
    assert.equal(calls.length, 4); publish('a', true); publish('b', true);
    assert.deepEqual(effects, { a: true, b: true });
    const retiredAContext = contexts.a[0]!, incumbentBContext = contexts.b[0]!;
    const retiredAGrants = grants.filter(value => value.principalId === 'member-a');
    assert.equal(retiredAGrants.length, 2);
    mutate({ type: 'remove-member', principalId: 'member-a' });
    assert.equal(aFirst.status().state, 'closed'); assert.equal(retiredAContext.isCurrent(), false);
    assert.equal(effects.a, false); assert.equal(releases.a, 1);
    assert.equal(b.status().state, 'active'); assert.equal(incumbentBContext.isCurrent(), true);
    assert.equal(effects.b, true); assert.equal(releases.b, 0);
    at = 40; publish('a', true); assert.equal(effects.a, false); assert.equal(contexts.a.length, 1);
    assert.equal(controller.route(runtime, request('a')).ok, false); assert.equal(calls.length, 4);
    mutate({ type: 'add-member', principalId: 'member-a', role: 'participant' });
    assert.equal(controller.route(runtime, request('a')).ok, false, 're-add cannot restore removed sharing policy');
    assert.equal(aFirst.start().ok, false, 'retired public handle cannot restart'); assert.equal(calls.length, 4);
    assert.equal(controller.route(runtime, request('a', handles.b.sink)).ok, false, 'recovery cannot select participant B resource');
    assert.equal(controller.route(runtime, request('b', handles.a.sink)).ok, false, 'B cannot acquire A resource');
    assert.equal(calls.length, 4, 'denied cross-participant paths must not ask resource owners');
    mutate({ type: 'set-sharing', rule: rule('a') });
    const freshResult = controller.route(runtime, request('a')); assert.equal(freshResult.ok, true); aFresh = freshResult.value;
    assert.notEqual(aFresh, aFirst); assert.equal(aFresh.start().ok, true); assert.equal(calls.length, 6);
    for (const grant of retiredAGrants) grant.owner.abort();
    assert.equal(aFresh.status().state, 'active'); assert.equal(b.status().state, 'active');
    assert.equal(retiredAContext.isCurrent(), false); assert.equal(incumbentBContext.isCurrent(), true);
    at = 80; publish('a', true); publish('b', false);
    assert.deepEqual(effects, { a: true, b: false }); assert.equal(contexts.a.length, 2); assert.equal(contexts.b.length, 2);
    const freshAGrants = grants.filter(value => value.principalId === 'member-a' && !retiredAGrants.includes(value));
    assert.equal(freshAGrants.length, 2); freshAGrants[0]!.owner.abort();
    assert.equal(aFresh.status().state, 'closed'); assert.equal(contexts.a[1]!.isCurrent(), false);
    assert.equal(b.status().state, 'active'); assert.equal(contexts.b[1]!.isCurrent(), true);
    assert.equal(releases.a, 2); assert.equal(releases.b, 0);
    at = 120; publish('a', true); publish('b', true);
    assert.deepEqual(effects, { a: false, b: true }); assert.equal(contexts.a.length, 2); assert.equal(contexts.b.length, 3);
    t.diagnostic(JSON.stringify({ removedAReleased: releases.a, independentBReleasesBeforeCleanup: releases.b,
      actualResourceOwnerApprovals: calls, freshOwnerGrants: freshAGrants.length,
      retiredHandleRestartRefused: true, readdWithoutPolicyRefused: true, crossParticipantRoutesRefused: 2,
      staleOwnerAbortLeavesFreshRoutesActive: true, actualFinalEffects: effects,
      scope: 'Actual software runtime/member policy only; no invitation/TLS/account/device identity or physical/network acceptance.' }));
  } finally {
    controller.close(); runtime.close();
    assert.equal(aFirst?.status().state, 'closed'); assert.equal(aFresh?.status().state, 'closed'); assert.equal(b?.status().state, 'closed');
    assert.equal(controller.inspect('owner').ok, false); assert.deepEqual(effects, { a: false, b: false });
    t.diagnostic(JSON.stringify({ cleanup: { allActualHandlesClosed: true, effectsReleased: true } }));
  }
});
