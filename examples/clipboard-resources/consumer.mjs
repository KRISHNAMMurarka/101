import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import { createMacosPrivatePasteboardAdapter, PRIVATE_PASTEBOARD_LIMITS } from './process-port.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const byte = { type: 'scalar', unit: '1', min: 0, max: 255 }, revision = { type: 'scalar', unit: '1', min: 0, max: 0x7fffffff };
const array = (min, max) => ({ type: 'array', minItems: min, maxItems: max, items: byte });
const record = fields => ({ type: 'record', fields });
const encodeHash = value => value === 'absent' ? [] : Array.from(Buffer.from(value, 'hex'));
function decodeHash(value) { assert.ok(value.length === 0 || value.length === 32 && value.every(Number.isInteger)); return value.length ? Buffer.from(value).toString('hex') : 'absent'; }
const key = request => JSON.stringify([request.principalId, request.applicationId, request.sessionId,
  request.source.registrationId, request.sink.registrationId, request.sourceOperation, request.sinkOperation]);
function deferred() { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; }
async function until(check, duration = 1500) { const end = performance.now() + duration;
  while (!check()) { assert.ok(performance.now() < end, 'Owned native pasteboard callback did not settle'); await new Promise(resolve => setTimeout(resolve, 5)); } }

/** Actual AppKit on two newly issued private named boards. The independently
 * provisioned helper is fixed and source/binary pinned; no name or program comes
 * from device values. Importing performs no native or clipboard operation.
 * Runtime invoke, owner action and sensitive result reads are distinct grants.
 * Native observation is published using the host receipt clock, with no claim
 * about physical acquisition timing or general/system clipboard support. */
export async function runPrivateClipboardExample(provisioned) {
  assert.equal(process.platform, 'darwin');
  const checks = [], sessions = [], original = new TextEncoder().encode('private native pasteboard sensitive fixture'), changed = new TextEncoder().encode('fresh explicitly approved replacement');
  for (const path of ['process-port.mjs', 'macos-pasteboard.swift']) assert.equal(hash(readFileSync(new URL('./' + path, import.meta.url))), provisioned.sourceSha256[path]);
  const schemas = {
    read: { command: { type: 'boolean' }, result: record({ bytes: array(0, 128), sha256: array(0, 32), revision, hasValue: { type: 'boolean' } }) },
    write: { command: record({ bytes: array(0, 128), expectedRevision: revision, expectedSha256: array(0, 32) }),
      result: record({ revision, sha256: array(32, 32), byteLength: { type: 'scalar', unit: 'By', min: 0, max: 128 } }) },
    clear: { command: record({ expectedRevision: revision, expectedSha256: array(0, 32) }), result: record({ revision, empty: { type: 'boolean' } }) },
  };
  async function session(index, priorBoard) {
    const scope = Object.freeze({ principalId: 'private-pasteboard-owner', applicationId: 'native-clipboard-client', sessionId: 'fresh-' + index });
    const clockDomain = 'pasteboard-host-receipt:' + index, approved = new Set(), approvedOwner = new Map(), commands = new Map(), entries = new Map();
    let child, adapter, viewerCalls = 0, closed = false;
    const runtime = createDeviceRuntime({ now: () => performance.now(), clockDomain, maxRoutes: 4, maxPendingDeliveries: 2,
      authorize(request) { return approved.has(key(request)) ? { expiresAt: performance.now() + 2000, maxAgeMs: 1000, maxHz: 1000 } : undefined; } });
    const startedAt = performance.now();
    adapter = await createMacosPrivatePasteboardAdapter({ scope, now: () => performance.now(), executableSha256: provisioned.executableSha256, deadlineMs: 1000,
      authorize(request) {
        const current = () => !closed && request.boardId === adapter.boardId && request.scope.principalId === scope.principalId && request.scope.applicationId === scope.applicationId &&
          request.scope.sessionId === scope.sessionId && approvedOwner.has(request.route.routeId) && commands.get(request.route.routeId)?.action === request.resource &&
          commands.get(request.route.routeId)?.route.status().state === 'active';
        return current() ? { request, expiresAt: request.expiresAt, signal: approvedOwner.get(request.route.routeId).signal } : undefined;
      }, onProcess(value) { child = value; value.once('close', () => { approved.clear(); for (const owner of approvedOwner.values()) owner.abort(); approvedOwner.clear();
        for (const entry of entries.values()) runtime.setReadiness(entry.output, 'unavailable'); for (const current of commands.values()) runtime.revoke(current.route); }); } });
    try {
      assert.notEqual(adapter.boardId, priorBoard);
      const capability = (id, action, direction) => ({ id, semantic: 'example:private-pasteboard-' + action + (direction < 2 ? '-command' : '-result'),
        schemaVersion: direction < 2 && action === 'read' ? 1 : 2,
        kind: ['event', 'job', 'property', 'property'][direction], value: direction < 2 ? schemas[action].command : schemas[action].result,
        permissions: [['subscribe'], ['invoke'], ['read'], ['write']][direction],
        delivery: direction < 2 ? { mode: 'reliable', maxAgeMs: 1000 } : { mode: 'latest', maxHz: 1000, maxAgeMs: 1000 },
        ...(direction === 1 || direction === 3 ? { ownership: { mode: direction === 3 ? 'observe' : 'exclusive' } } : {}) });
      const device = parseDeviceDescriptor({ schemaVersion: 1, id: adapter.boardId, label: 'Explicit owned private pasteboard', revision: 1,
        adapter: { id: 'example:private-macos-pasteboard', version: '1.0.0' }, runtime: { platform: 'macos-node-AppKit' },
        capabilities: ['read', 'write', 'clear'].flatMap(action => ['control', 'command', 'result', 'viewer'].map((suffix, direction) => capability(action + '-' + suffix, action, direction))) });
      for (const action of ['read', 'write', 'clear']) {
        const entry = { action, sequence: 0, pending: undefined, viewed: undefined };
        entry.control = runtime.registerSource({ device, capability: action + '-control' }); entry.output = runtime.registerSource({ device, capability: action + '-result' });
        entry.command = runtime.registerSink({ device, capability: action + '-command', async apply(observation, context) {
          const pending = entry.pending; assert.equal(pending?.id, context.operationId);
          let args;
          if (action === 'read') { assert.equal(observation.value, true); args = {}; }
          else { args = { expectedRevision: observation.value.expectedRevision, expectedSha256: decodeHash(observation.value.expectedSha256) };
            if (action === 'write') { assert.ok(observation.value.bytes.every(Number.isInteger)); args.bytes = Uint8Array.from(observation.value.bytes); } }
          const result = await adapter.execute(action, args, context); pending.done.resolve(result);
          if (!result.ok || !context.isCurrent() || context.signal.aborted || !approvedOwner.has(context.routeId)) { result.value?.bytes?.fill(0); throw Error('Private pasteboard unavailable'); }
          const value = action === 'read' ? { bytes: Array.from(result.value.bytes), sha256: encodeHash(result.value.sha256), revision: result.value.revision, hasValue: result.value.hasValue } :
            action === 'write' ? { ...result.value, sha256: encodeHash(result.value.sha256) } : result.value;
          runtime.setReadiness(entry.output, 'available', performance.now() + 1000);
          const sent = runtime.publish(entry.output, value, { timestamp: performance.now(), clockDomain }); result.value?.bytes?.fill(0); assert.ok(sent.ok);
          if (context.isCurrent() && !context.signal.aborted) context.reportEvidence('target-acknowledged');
        }, release() { runtime.setReadiness(entry.output, 'unavailable'); } });
        entry.viewer = runtime.registerSink({ device, capability: action + '-viewer', apply(observation, context) {
          if (!context.isCurrent() || context.signal.aborted) return; viewerCalls++;
          entry.viewed = action === 'clear' ? observation.value : { ...observation.value, sha256: decodeHash(observation.value.sha256) };
        }, release() {} });
        for (const endpoint of [entry.control, entry.command, entry.viewer]) runtime.setReadiness(endpoint, 'available'); entries.set(action, entry);
      }
      function route(from, to, sourceOperation, sinkOperation, allow) {
        if (allow) approved.add(JSON.stringify([scope.principalId, scope.applicationId, scope.sessionId, from.id, to.id, sourceOperation, sinkOperation]));
        return runtime.route({ from, to, ...scope, sourceOperation, queueCapacity: 1, leaseMs: 1000 });
      }
      function begin(action, value, owner = true, permitted = true) {
        const entry = entries.get(action); assert.equal(entry.pending, undefined);
        const connection = route(entry.control, entry.command, 'subscribe', 'invoke', permitted), start = connection.start();
        if (!start.ok) { connection.stop(); return { start, route: connection }; }
        commands.set(connection.id, { action, route: connection }); if (owner) approvedOwner.set(connection.id, new AbortController());
        const done = deferred(), id = String(++entry.sequence); entry.pending = { id, done };
        const wire = action === 'read' ? value : { ...value, expectedSha256: encodeHash(value.expectedSha256) };
        assert.ok(runtime.publish(entry.control, wire, { operationId: id, deadline: performance.now() + 1000 }).ok); runtime.flush();
        return { entry, route: connection, done: done.promise };
      }
      async function finish(work, readApproved = true) {
        const result = await work.done; await until(() => work.route.operations().some(row => ['failed', 'returned'].includes(row.handlerResult)));
        let viewed;
        if (result.ok) { const before = viewerCalls, reader = route(work.entry.output, work.entry.viewer, 'read', 'write', readApproved), started = reader.start();
          if (readApproved) { assert.ok(started.ok); runtime.flush(); assert.equal(viewerCalls, before + 1); viewed = work.entry.viewed; }
          else { assert.equal(started.ok, false); assert.equal(viewerCalls, before); } reader.stop(); }
        const operations = work.route.operations(); work.route.stop(); commands.delete(work.route.id); approvedOwner.get(work.route.id)?.abort(); approvedOwner.delete(work.route.id); work.entry.pending = undefined; work.entry.viewed = undefined;
        return { result, viewed, operations };
      }
      const create = { bytes: Array.from(original), expectedRevision: adapter.initialRevision, expectedSha256: 'absent' };
      assert.equal(begin('write', create, true, false).start.ok, false); assert.equal(adapter.status().nativeCommands, 0); checks.push('denied-exact-invoke-before-native-command-' + index);
      assert.equal((await finish(begin('read', true, false))).result.reason, 'denied'); assert.equal(adapter.status().nativeCommands, 0); checks.push('independent-owner-action-grant-' + index);
      const write = await finish(begin('write', create)); assert.ok(write.result.ok); assert.ok(write.viewed.revision > adapter.initialRevision);
      const deniedRead = await finish(begin('read', true), false); assert.ok(deniedRead.result.ok); assert.equal(deniedRead.viewed, undefined);
      const read = await finish(begin('read', true)); assert.deepEqual(read.viewed.bytes, Array.from(original)); assert.equal(read.viewed.sha256, hash(original));
      assert.ok(write.operations.some(row => row.effectEvidence === 'target-acknowledged')); checks.push('actual-AppKit-private-write-and-independent-native-read-' + index, 'sensitive-result-needs-separate-read-grant-' + index);
      const stale = await finish(begin('clear', { expectedRevision: adapter.initialRevision, expectedSha256: 'absent' })); assert.equal(stale.result.reason, 'conflict');
      const preserved = await finish(begin('read', true)); assert.equal(preserved.viewed.sha256, hash(original)); checks.push('stale-CAS-clear-preserves-native-value-' + index);
      assert.ok(child.kill('SIGSTOP'));
      const cancelled = begin('write', { bytes: Array.from(changed), expectedRevision: preserved.viewed.revision, expectedSha256: preserved.viewed.sha256 });
      await until(() => adapter.status().nativeCommands > 0 && adapter.status().rawPending === 1 && !adapter.status().stdinCallbackPending);
      runtime.revoke(cancelled.route); const uncertain = await cancelled.done; assert.equal(uncertain.ok, false); assert.equal(uncertain.issuedEffect, true);
      assert.equal(adapter.status().rawPending, 1); assert.equal(adapter.status().timerArmed, false); const beforeLate = viewerCalls;
      child.kill('SIGCONT'); await adapter.drain(); const cancelledFinished = await finish(cancelled); assert.equal(viewerCalls, beforeLate);
      assert.ok(cancelledFinished.operations.every(row => !['target-acknowledged', 'observed'].includes(row.effectEvidence)));
      const observed = await finish(begin('read', true)); assert.deepEqual(observed.viewed.bytes, Array.from(changed));
      checks.push('actual-paused-native-stdin-reservation-after-revoke-' + index, 'issued-effect-uncertainty-no-stale-ACK-or-data-' + index, 'fresh-granted-native-read-confirms-issued-effect-' + index);
      const cleared = await finish(begin('clear', { expectedRevision: observed.viewed.revision, expectedSha256: observed.viewed.sha256 })); assert.ok(cleared.result.ok);
      assert.ok(cleared.viewed.revision > observed.viewed.revision); const empty = await finish(begin('read', true)); assert.equal(empty.viewed.hasValue, false); assert.deepEqual(empty.viewed.bytes, []);
      checks.push('actual-clear-and-fresh-observed-empty-state-' + index);
      if (index === 1) {
        assert.ok((await finish(begin('write', { bytes: Array.from(original), expectedRevision: empty.viewed.revision, expectedSha256: 'absent' }))).result.ok);
        await until(() => !adapter.status().nativeAlive, 11500); const elapsed = performance.now() - startedAt;
        assert.ok(elapsed >= 9000 && elapsed < 11500); assert.equal((await adapter.execute('read', {}, {})).reason, 'closed');
        checks.push('fixed-original-native-lifetime-clears-owned-data-and-retires-admission');
      }
      sessions.push({ session: index, contentSha256: [hash(original), hash(changed)], byteLengths: [original.byteLength, changed.byteLength],
        nativeStatus: adapter.status(), viewerCalls, uncertainIssuedWrite: { reason: uncertain.reason, issuedEffect: true, acknowledgementReleased: false } });
      return adapter.boardId;
    } finally {
      child?.kill('SIGCONT'); closed = true; approved.clear(); for (const owner of approvedOwner.values()) owner.abort(); approvedOwner.clear(); runtime.close(); const removed = await adapter.close();
      assert.deepEqual(removed, { closed: true, cleared: true, released: true }); assert.equal(adapter.status().rawPending, 0); assert.equal(adapter.status().nativeAlive, false);
      assert.equal(adapter.status().nativeExitGuardArmed, false); checks.push('verified-owned-board-clear-release-and-native-exit-' + index);
    }
  }
  const first = await session(1); await session(2, first); checks.push('fresh-native-board-identity-session-and-explicit-new-approvals');
  return Object.freeze({ result: 'pass', kind: 'actual-macos-private-named-pasteboard', platform: process.platform, node: process.version, checks, sessions,
    limits: PRIVATE_PASTEBOARD_LIMITS, nativeSourceSha256: provisioned.sourceSha256['macos-pasteboard.swift'], nativeExecutableSha256: provisioned.executableSha256,
    cleanup: { nativeChildrenAlive: 0, operationTimers: 0, verifiedClearedReleasedBoards: 2 },
    exclusions: ['general-or-user-clipboard', 'application-control', 'UI-permission-work', 'arbitrary-pasteboard-name-or-program', 'same-user-malicious-board-takeover',
      'physical-capture-clock', 'malicious-host-sandbox', 'rollback-of-issued-effect', 'guaranteed-native-cleanup-after-SIGKILL'] });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = readFileSync(new URL('./caller-inputs.json', import.meta.url)); assert.ok(input.byteLength <= 2048);
  console.log(JSON.stringify(await runPrivateClipboardExample(JSON.parse(input.toString('utf8')))));
}
