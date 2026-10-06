import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import { createOwnedFilesystemAdapter, OWNED_FILESYSTEM_LIMITS } from './adapter.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const clientBytes = 128;
const byteArray = { type: 'array', minItems: 0, maxItems: clientBytes, items: { type: 'scalar', unit: '1', min: 0, max: 255 } };
const digestByte = { type: 'scalar', unit: '1', min: 0, max: 255 };
const shaSchema = { type: 'array', minItems: 32, maxItems: 32, items: digestByte };
const expectedSchema = { type: 'array', minItems: 0, maxItems: 32, items: digestByte };
const wireHash = value => value === 'absent' ? [] : Array.from(Buffer.from(value, 'hex'));
function decodeHash(value, absent = false) {
  if (absent && value.length === 0) return 'absent';
  assert.ok(value.length === 32 && value.every(Number.isInteger)); return Buffer.from(value).toString('hex');
}
const sizeSchema = { type: 'scalar', unit: 'By', min: 0, max: OWNED_FILESYSTEM_LIMITS.fileBytes };
const record = fields => ({ type: 'record', fields });
const key = request => JSON.stringify([request.principalId, request.applicationId, request.sessionId,
  request.source.registrationId, request.sink.registrationId, request.sourceOperation, request.sinkOperation]);
function deferred() { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; }
async function until(check) { const end = performance.now() + 1500;
  while (!check()) { assert.ok(performance.now() < end, 'Owned filesystem callback did not settle'); await new Promise(resolve => setTimeout(resolve, 2)); } }
async function independentRead(root, leaf) {
  const file = await open(join(root, leaf), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const bytes = Buffer.alloc(OWNED_FILESYSTEM_LIMITS.fileBytes + 1); let length = 0;
    for (let turn = 0; turn < 16; turn++) { const next = await file.read(bytes, length, bytes.length - length, length); length += next.bytesRead;
      assert.ok(length <= OWNED_FILESYSTEM_LIMITS.fileBytes); if (!next.bytesRead) return new Uint8Array(bytes.subarray(0, length)); }
    throw Error('Owned verifier read limit');
  } finally { await file.close(); }
}

/** Explicit disposable filesystem selection. Importing this module creates no
 * root, performs no native IO and grants no resource permission. File operations
 * and result reads have different exact runtime grants; the file owner also
 * approves each current action. This Node example is not a user-path sandbox. */
export async function runOwnedFilesystemExample() {
  const checks = [], receipts = [], cleanup = [];
  const original = new TextEncoder().encode('owned private filesystem fixture');
  const replacement = new TextEncoder().encode('reviewed replacement fixture');
  async function session(index, oldRootId) {
    const scope = Object.freeze({ principalId: 'filesystem-owner', applicationId: 'selected-filesystem-client', sessionId: 'fresh-' + index });
    const approved = new Set(), approvedFiles = new Set(), commands = new Map(), endpoints = new Map();
    const clockDomain = 'filesystem-host-receipt:' + index;
    let root, adapter, gate, viewerCalls = 0, closed = false;
    const runtime = createDeviceRuntime({ now: () => performance.now(), clockDomain, maxRoutes: 4, maxPendingDeliveries: 2,
      authorize(request) { return approved.has(key(request)) ? { expiresAt: performance.now() + 2000, maxAgeMs: 1000, maxHz: 1000 } : undefined; } });
    adapter = await createOwnedFilesystemAdapter({ scope, destinations: [{ id: 'note', leaf: 'note.txt' }, { id: 'settings', leaf: 'settings.json' }],
      now: () => performance.now(), deadlineMs: 1000, onRoot(path) { root = path; },
      onNative(event) { if (gate?.stage === event.stage) { gate.entered.resolve(); return gate.release.promise; } },
      authorize(request) {
        const current = () => !closed && approvedFiles.has(request.route.routeId) && commands.get(request.route.routeId)?.resourceId === request.resource.resourceId &&
          commands.get(request.route.routeId)?.route.status().state === 'active' && request.rootId === adapter.rootId &&
          request.scope.principalId === scope.principalId && request.scope.applicationId === scope.applicationId && request.scope.sessionId === scope.sessionId;
        if (!current()) return;
        return { request, expiresAt: request.expiresAt, isCurrent: current };
      } });
    try {
    assert.notEqual(adapter.rootId, oldRootId); assert.equal((await lstat(root)).mode & 0o777, 0o700);
    const schema = resource => ({
      command: resource.action === 'write' ? record({ bytes: byteArray, expectedSha256: expectedSchema }) :
        resource.action === 'delete' ? record({ expectedSha256: shaSchema }) : { type: 'boolean' },
      outcome: resource.action === 'read' ? record({ bytes: byteArray, sha256: shaSchema, byteLength: sizeSchema }) :
        resource.action === 'write' ? record({ sha256: shaSchema, byteLength: sizeSchema }) :
          resource.action === 'delete' ? { type: 'boolean' } : { type: 'array', minItems: 0, maxItems: 4,
            items: record({ destinationId: { type: 'enum', values: ['note', 'settings'] }, byteLength: sizeSchema }) },
    });
    const capability = (id, semantic, kind, value, permissions, reliable, observe = false) => ({ id, semantic,
      schemaVersion: ['record', 'array', 'text'].includes(value.type) ? 2 : 1, kind, value,
      permissions, delivery: reliable ? { mode: 'reliable', maxAgeMs: 1000 } : { mode: 'latest', maxAgeMs: 1000, maxHz: 1000 },
      ...(permissions.includes('invoke') || permissions.includes('write') ? { ownership: { mode: observe ? 'observe' : 'exclusive' } } : {}) });
    const caps = adapter.resources.flatMap(resource => { const values = schema(resource), semantic = 'example:owned-filesystem-' + resource.resourceId;
      return [capability(resource.resourceId + '-control', semantic + '-command', 'event', values.command, ['subscribe'], true),
        capability(resource.resourceId + '-command', semantic + '-command', 'job', values.command, ['invoke'], true),
        capability(resource.resourceId + '-result', semantic + '-result', 'property', values.outcome, ['read'], false),
        capability(resource.resourceId + '-viewer', semantic + '-result', 'property', values.outcome, ['write'], false, true)]; });
    const device = parseDeviceDescriptor({ schemaVersion: 1, id: adapter.rootId, label: 'Explicit owned temporary files', revision: 1,
      adapter: { id: 'example:owned-filesystem', version: '1.0.0' }, runtime: { platform: process.platform + '-node' }, capabilities: caps });
    for (const resource of adapter.resources) {
      const entry = { resource, sequence: 0, pending: undefined, lastView: undefined };
      entry.control = runtime.registerSource({ device, capability: resource.resourceId + '-control' });
      entry.result = runtime.registerSource({ device, capability: resource.resourceId + '-result' });
      entry.command = runtime.registerSink({ device, capability: resource.resourceId + '-command', async apply(observation, context) {
        const pending = entry.pending; if (!pending || pending.operationId !== context.operationId) throw Error('Owned operation unavailable');
        let args;
        if (resource.action === 'write') {
          if (!observation.value.bytes.every(Number.isInteger)) { pending.done.resolve({ ok: false, reason: 'invalid', issuedMutation: false }); throw Error('Owned operation unavailable'); }
          args = { bytes: Uint8Array.from(observation.value.bytes), expectedSha256: decodeHash(observation.value.expectedSha256, true) };
        } else if (resource.action === 'delete') args = { expectedSha256: decodeHash(observation.value.expectedSha256) };
        else { if (observation.value !== true) throw Error('Owned operation unavailable'); args = {}; }
        const result = await adapter.execute(resource.resourceId, args, context); pending.done.resolve(result);
        if (!result.ok || !context.isCurrent() || context.signal.aborted || !approvedFiles.has(context.routeId)) {
          result.value?.bytes?.fill(0); throw Error('Owned operation unavailable');
        }
        const value = resource.action === 'read' ? { ...result.value, bytes: Array.from(result.value.bytes), sha256: wireHash(result.value.sha256) } :
          resource.action === 'list' ? result.value.entries : resource.action === 'delete' ? true : { ...result.value, sha256: wireHash(result.value.sha256) };
        runtime.setReadiness(entry.result, 'available', performance.now() + 1000);
        const published = runtime.publish(entry.result, value, { timestamp: performance.now(), clockDomain }); result.value?.bytes?.fill(0);
        assert.ok(published.ok); context.reportEvidence('target-acknowledged');
      }, release() { runtime.setReadiness(entry.result, 'unavailable'); } });
      entry.viewer = runtime.registerSink({ device, capability: resource.resourceId + '-viewer', apply(observation, context) {
        if (!context.isCurrent() || context.signal.aborted) return; viewerCalls++;
        entry.lastView = ['read', 'write'].includes(resource.action) ? { ...observation.value, sha256: decodeHash(observation.value.sha256) } : observation.value;
      }, release() {} });
      for (const endpoint of [entry.control, entry.command, entry.viewer]) runtime.setReadiness(endpoint, 'available');
      endpoints.set(resource.resourceId, entry);
    }
    function route(from, to, sourceOperation, sinkOperation, allow) {
      if (allow) approved.add(JSON.stringify([scope.principalId, scope.applicationId, scope.sessionId, from.id, to.id, sourceOperation, sinkOperation]));
      return runtime.route({ from, to, ...scope, sourceOperation, queueCapacity: 1, leaseMs: 1000 });
    }
    function begin(id, value, fileApproved = true, runtimeApproved = true) {
      const entry = endpoints.get(id); assert.ok(entry); assert.equal(entry.pending, undefined);
      const commandRoute = route(entry.control, entry.command, 'subscribe', 'invoke', runtimeApproved);
      const start = commandRoute.start(); if (!start.ok) { commandRoute.stop(); return { start, route: commandRoute }; }
      commands.set(commandRoute.id, { resourceId: id, route: commandRoute }); if (fileApproved) approvedFiles.add(commandRoute.id);
      const operationId = String(++entry.sequence), done = deferred(); entry.pending = { operationId, done };
      const wire = ['write', 'delete'].includes(entry.resource.action) ? { ...value, expectedSha256: wireHash(value.expectedSha256) } : value;
      assert.ok(runtime.publish(entry.control, wire, { operationId, deadline: performance.now() + 1000 }).ok); runtime.flush();
      return { start, route: commandRoute, entry, done: done.promise, operationId };
    }
    async function finish(work, allowRead = true) {
      const result = await work.done; await until(() => work.route.operations().some(row => row.handlerResult === 'failed' || row.handlerResult === 'returned'));
      let viewed;
      if (result.ok) {
        const before = viewerCalls, reader = route(work.entry.result, work.entry.viewer, 'read', 'write', allowRead);
        const started = reader.start();
        if (allowRead) { assert.ok(started.ok); runtime.flush(); assert.equal(viewerCalls, before + 1); viewed = work.entry.lastView; }
        else { assert.equal(started.ok, false); assert.equal(viewerCalls, before); }
        reader.stop();
      }
      const operations = work.route.operations(); work.route.stop(); approvedFiles.delete(work.route.id); commands.delete(work.route.id); work.entry.pending = undefined;
      work.entry.lastView = undefined; return { result, viewed, operations };
    }
      assert.deepEqual(await readdir(root), []); assert.equal(adapter.status().attempts, 0);
      const denied = begin('note-write', { bytes: Array.from(original), expectedSha256: 'absent' }, true, false);
      assert.equal(denied.start.ok, false); assert.equal(adapter.status().attempts, 0); checks.push('runtime-denial-before-native-issue-' + index);
      const ownerDenied = await finish(begin('note-write', { bytes: Array.from(original), expectedSha256: 'absent' }, false));
      assert.equal(ownerDenied.result.reason, 'denied'); assert.deepEqual(await readdir(root), []); checks.push('separate-current-file-owner-approval-' + index);
      const written = await finish(begin('note-write', { bytes: Array.from(original), expectedSha256: 'absent' }));
      assert.ok(written.result.ok); assert.equal(written.viewed.sha256, hash(original)); assert.deepEqual(await independentRead(root, 'note.txt'), original);
      assert.equal((await lstat(join(root, 'note.txt'))).mode & 0o777, 0o600); checks.push('real-create-mode-and-independent-bytes-' + index);
      const hidden = await finish(begin('note-read', true), false); assert.ok(hidden.result.ok); assert.equal(hidden.viewed, undefined);
      const read = await finish(begin('note-read', true)); assert.ok(read.result.ok); assert.deepEqual(read.viewed.bytes, Array.from(original));
      assert.ok(read.operations.some(row => row.handlerResult === 'returned' && row.effectEvidence === 'target-acknowledged'));
      const listed = await finish(begin('list', true)); assert.deepEqual(listed.viewed, [{ destinationId: 'note', byteLength: original.byteLength }]);
      checks.push('sensitive-result-requires-distinct-read-grant-' + index, 'selected-list-and-read-' + index);
      const conflict = await finish(begin('note-delete', { expectedSha256: '0'.repeat(64) })); assert.equal(conflict.result.reason, 'conflict');
      assert.deepEqual(await independentRead(root, 'note.txt'), original); checks.push('stale-delete-precondition-preserves-data-' + index);
      gate = { stage: 'write-staged', entered: deferred(), release: deferred() };
      const cancelled = begin('note-write', { bytes: Array.from(replacement), expectedSha256: hash(original) }); await gate.entered.promise;
      runtime.revoke(cancelled.route); const cancelledResult = await cancelled.done;
      assert.equal(cancelledResult.ok, false); assert.equal(cancelledResult.issuedMutation, false); assert.equal(adapter.status().rawPending, 1);
      assert.equal(adapter.status().timerArmed, false); const beforeLate = viewerCalls;
      gate.release.resolve(); await adapter.drain(); gate = undefined; await finish(cancelled);
      assert.equal(viewerCalls, beforeLate); assert.deepEqual(await independentRead(root, 'note.txt'), original); checks.push('revoke-retains-real-staging-slot-and-fences-late-results-' + index);
      const changed = await finish(begin('note-write', { bytes: Array.from(replacement), expectedSha256: hash(original) }));
      assert.ok(changed.result.ok); assert.deepEqual(await independentRead(root, 'note.txt'), replacement); checks.push('fresh-approved-cas-retry-' + index);
      gate = { stage: 'write-issued', entered: deferred(), release: deferred() };
      const uncertain = begin('note-write', { bytes: Array.from(original), expectedSha256: hash(replacement) }); await gate.entered.promise;
      runtime.revoke(uncertain.route); const late = await uncertain.done; assert.equal(late.ok, false); assert.equal(late.issuedMutation, true);
      const beforeIssuedLate = viewerCalls; assert.deepEqual(await independentRead(root, 'note.txt'), original);
      gate.release.resolve(); await adapter.drain(); gate = undefined; const uncertainFinished = await finish(uncertain);
      assert.equal(viewerCalls, beforeIssuedLate); assert.ok(uncertainFinished.operations.every(row => row.effectEvidence !== 'target-acknowledged' && row.effectEvidence !== 'observed'));
      checks.push('issued-rename-is-uncertain-without-stale-ack-or-result-' + index);
      const confirmed = await finish(begin('note-read', true)); assert.equal(confirmed.viewed.sha256, hash(original));
      const deleted = await finish(begin('note-delete', { expectedSha256: hash(original) })); assert.ok(deleted.result.ok); assert.equal(deleted.viewed, true);
      assert.deepEqual(await readdir(root), []); checks.push('fresh-read-confirms-issued-effect-and-exact-delete-' + index);
      const status = adapter.status(); assert.equal(status.rawPending, 0); assert.equal(status.timerArmed, false);
      receipts.push({ session: index, selectedActions: ['read', 'list', 'write', 'delete'], contentSha256: [hash(original), hash(replacement)],
        bytes: [original.byteLength, replacement.byteLength], nativeStatus: status, viewerCalls,
        issuedCancellation: { reason: late.reason, issuedMutation: late.issuedMutation, acknowledgementReleased: false } });
      return adapter.rootId;
    } finally {
      gate?.release.resolve(); closed = true; approved.clear(); approvedFiles.clear();
      for (const entry of endpoints.values()) runtime.setReadiness(entry.result, 'unavailable'); runtime.close();
      const disposed = await adapter.close(); assert.equal(disposed.removed, true);
      await assert.rejects(lstat(root), { code: 'ENOENT' }); cleanup.push({ session: index, removedOwnedRoot: true });
      assert.equal((await adapter.execute('note-read', {}, {})).reason, 'closed');
    }
  }
  const first = await session(1); await session(2, first); checks.push('fresh-owned-root-identity-session-and-new-grants', 'closed-adapters-reject-old-work', 'all-owned-roots-removed');
  return Object.freeze({ result: 'pass', kind: 'actual-node-owned-filesystem-resources', platform: process.platform, node: process.version, checks, receipts, cleanup,
    limits: { ...OWNED_FILESYSTEM_LIMITS, clientBytes, pendingClientOperations: 1, routeQueue: 1, resultRows: 1 },
    exclusions: ['clipboard', 'application-control', 'user-files', 'arbitrary-paths', 'same-user-malicious-filesystem-substitution', 'openat-sandbox', 'rollback-of-issued-syscalls', 'physical-device-qualification'] });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(await runOwnedFilesystemExample()));
