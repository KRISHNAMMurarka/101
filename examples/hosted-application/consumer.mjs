import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { channel } from 'node:diagnostics_channel';
import { EmbeddedRuntime, createApplicationViews, createWorkloadHandoff, parseWorkloadRequirements, createApplicationSnapshot, restoreApplicationSnapshot } from '@101/connect';
import { createHostedApplication, hostedApplicationRequirements, HOSTED_APPLICATION_SOURCE_SHA256, HOSTED_APPLICATION_PROFILE, HOSTED_APPLICATION_LIMITS } from '@101/hub-server';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { const until = performance.now() + 2500; while (!check()) { assert.ok(performance.now() < until, 'Owned native operation must finish within the selected proof window'); await pause(5); } }
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function stateValid(state) { return !!state && typeof state === 'object' && !Array.isArray(state) && Object.keys(state).length === 3 && Number.isInteger(state.x) && state.x >= 0 && state.x <= 3 && Number.isInteger(state.y) && state.y >= 0 && state.y <= 3 && Number.isInteger(state.revision) && state.revision >= 0 && state.revision <= 32; }
function projected(frame) { return { pixels: frame.pixels, sequence: frame.sequence, providerEpoch: frame.providerEpoch, sourceTime: frame.sourceTime, quality: frame.quality, receivedAt: frame.receivedAt, receiptClockId: frame.receiptClockId }; }
function verifyRaster(pixels, x, y) {
  assert.equal(pixels.length, 64);
  for (let row = 0; row < 4; row++) for (let column = 0; column < 4; column++) {
    const offset = (row * 4 + column) * 4;
    assert.deepEqual(Array.from(pixels.slice(offset, offset + 4)), column === x && row === y ? [255, 0, 64, 255] : [0, 32, 0, 255]);
  }
}
async function unauthorized(path, version = 1) {
  const socket = createConnection(path), buffers = [];
  socket.on('error', () => {}); socket.on('data', data => buffers.push(Buffer.from(data)));
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.once('connect', () => socket.end(JSON.stringify({ version, epoch: 1, capability: '0'.repeat(64), id: 'f'.repeat(32), action: 'frame' }) + '\n'));
  await closed; assert.deepEqual(JSON.parse(Buffer.concat(buffers).toString()), { ok: false, reason: 'denied' });
}

/** Real fixed authored child application; no host-generated raster or selected host program. */
export async function runHostedApplicationExample() {
  const checks = [], owners = [], observations = [], phases = [], grants = [], scopes = [], providers = [];
  const record = name => checks.push(name);
  let launchAllowed = false;
  function make(providerId) {
    const owner = new AbortController(), allowed = new Set(['pause', 'stage', 'resume']), approvals = new Map(); owners.push(owner);
    const provider = createHostedApplication({ ownerId: 'native-owner', providerId, applicationId: 'raster-app', sessionId: 'owned-hosted-session', signal: owner.signal,
      authorize(request) {
        assert.ok(Object.isFrozen(request)); assert.equal(request.codeSha256, HOSTED_APPLICATION_SOURCE_SHA256);
        assert.equal(request.providerId, providerId); assert.equal(request.applicationId, 'raster-app'); assert.equal(request.sessionId, 'owned-hosted-session');
        assert.equal(request.profile, HOSTED_APPLICATION_PROFILE); scopes.push({ action: request.action, resource: request.resourceId, operation: request.operation, epoch: request.epoch });
        if (request.action === 'launch' ? !launchAllowed : !allowed.has(request.action)) return;
        const grant = new AbortController(); grants.push(grant); approvals.set(request.action, grant);
        return { request, signal: grant.signal, expiresAt: performance.now() + 9000 };
      }, onChild(observation) { observations.push({ ...observation, providerId }); },
      onRetire() { for (const phase of phases) if (phase.provider === provider) phase.stop(); } });
    providers.push(provider); return { provider, owner, allowed, approvals };
  }
  const source = make('source-host'), target = make('target-host');
  const definition = hostedApplicationRequirements('source-host'), parsed = parseWorkloadRequirements(definition.workload, definition.context);
  assert.equal(parsed.application.codeSha256, HOSTED_APPLICATION_SOURCE_SHA256); assert.equal(parsed.restart.mode, 'snapshot');
  const handoff = createWorkloadHandoff({ workload: definition.workload, context: definition.context, source: source.provider.handoffHost(), validateState: stateValid });
  function phaseFor(selected, epoch) {
    const sourceGrant = new AbortController(), sinkGrant = new AbortController(), viewSourceGrant = new AbortController();
    let outputGrant = new AbortController(), routeApproved = false, outputApproved = false, closed = false, operation = 0, pendingResult, commandSignal;
    const display = Buffer.alloc(64), foreignDisplay = Buffer.alloc(64); let copies = 0, foreignCopies = 0, releases = 0, lastObservation;
    const requirements = hostedApplicationRequirements(selected === source ? 'source-host' : 'target-host');
    const runtime = new EmbeddedRuntime({ clockDomain: 'input-receipt-clock', now: () => performance.now(), maxPendingDeliveries: 1,
      authorize(request) {
        if (!closed && routeApproved && !sourceGrant.signal.aborted && !sinkGrant.signal.aborted && selected.provider.epoch() === epoch && selected.provider.status().phase === 'active' &&
          request.principalId === 'input-owner' && request.applicationId === 'raster-app' && request.sessionId === 'owned-hosted-session' &&
          request.source.deviceId === requirements.inputSource.id && request.source.capabilityId === 'cursor' && request.sink.deviceId === requirements.inputSink.id && request.sink.capabilityId === 'cursor' &&
          request.sourceOperation === 'subscribe' && request.sinkOperation === 'invoke') return { expiresAt: performance.now() + 3000, maxAgeMs: 250, maxHz: 120 };
      } });
    const input = runtime.registerSource({ device: requirements.inputSource, capability: 'cursor' });
    const sink = runtime.registerSink({ device: requirements.inputSink, capability: 'cursor',
      async apply(observation, context) {
        if (closed || sourceGrant.signal.aborted || sinkGrant.signal.aborted || !context.isCurrent() || context.signal.aborted) return;
        context.reportEvidence('dispatched');
        const result = await selected.provider.input(epoch, observation.value, { purpose: 'explicit-cursor-input', signal: commandSignal.signal, context });
        pendingResult = result;
        if (result.ok && context.isCurrent() && !context.signal.aborted && !closed) context.reportEvidence('target-acknowledged');
      }, release() {} });
    runtime.setReadiness(input, 'available'); runtime.setReadiness(sink, 'available');
    const inputRoute = runtime.route({ from: input, to: sink, principalId: 'input-owner', applicationId: 'raster-app', sessionId: 'owned-hosted-session', leaseMs: 3000, queueCapacity: 1 });
    let views;
    function currentViews() {
      if (views) return views;
      const observed = selected.provider.currentFrame(epoch);
      if (closed || !observed) throw new Error('Native frame unavailable');
      const { frameValue } = hostedApplicationRequirements(selected === source ? 'source-host' : 'target-host', {
        sourceClockId: observed.sourceTime.clockId, receiptClockId: observed.receiptClockId });
      assert.ok(frameValue);
      views = createApplicationViews({ applicationId: 'raster-app', sessionId: 'owned-hosted-session', clockDomain: 'host-projection-clock', now: () => performance.now(),
      engine: { step() { const current = selected.provider.currentFrame(epoch); if (closed || !current || viewSourceGrant.signal.aborted) throw new Error('Native frame unavailable'); return projected(current); }, stop() { void selected.provider.stop(); } },
      views: [{ id: 'native-raster', value: frameValue, project: value => value }],
      authorize(request) {
        if (!closed && outputApproved && !viewSourceGrant.signal.aborted && !outputGrant.signal.aborted && selected.provider.currentFrame(epoch) &&
          request.applicationId === 'raster-app' && request.sessionId === 'owned-hosted-session' && request.principalId === 'display-owner' && request.viewId === 'native-raster' && request.outputId === 'owned-output' &&
          request.source.deviceId === 'view-native-raster' && request.source.capabilityId === 'native-raster' && request.sourceOperation === 'subscribe' && request.sink.deviceId === 'display-owned-output' && request.sinkOperation === 'write') return { expiresAt: performance.now() + 3000, maxAgeMs: 250, maxHz: 120 };
      } });
      return views;
    }
    const output = () => ({ viewId: 'native-raster', outputId: 'owned-output', principalId: 'display-owner',
      apply(observation, context) {
        const staged = Buffer.from(observation.value.pixels);
        const current = selected.provider.currentFrame(epoch);
        if (closed || outputGrant.signal.aborted || viewSourceGrant.signal.aborted || !context.isCurrent() || context.signal.aborted || !current || observation.value.providerEpoch !== current.providerEpoch || observation.value.sequence !== current.sequence) return;
        staged.copy(display); copies++; lastObservation = observation;
      }, release() { display.fill(0); releases++; } });
    const revoke = () => { views?.revoke('display-owner'); };
    outputGrant.signal.addEventListener('abort', revoke, { once: true });
    const phase = { provider: selected.provider, display, foreignDisplay, runtime, get views() { return currentViews(); }, inputRoute, sourceGrant, sinkGrant,
      approveInput() { routeApproved = true; return inputRoute.start(); },
      async command(x, y, cancelIssued = false) {
        operation++; pendingResult = undefined; commandSignal = new AbortController();
        let remove = () => {};
        if (cancelIssued) {
          const events = channel('net.client.socket'), observe = ({ socket }) => { socket.once('connect', () => queueMicrotask(() => commandSignal.abort())); };
          events.subscribe(observe); remove = () => events.unsubscribe(observe);
        }
        try {
          const at = performance.now(), result = runtime.publish(input, { x, y }, { operationId: String(operation), deadline: at + 200, timestamp: at, clockDomain: runtime.clockDomain, quality: 'valid' });
          if (!result.ok) return result; runtime.flush(); await until(() => { runtime.flush(); return pendingResult !== undefined; }); runtime.flush(); return pendingResult;
        } finally { remove(); }
      },
      denyOutput() { return currentViews().attach(output()); },
      denyForeign() { return currentViews().attach({ ...output(), outputId: 'foreign-output', principalId: 'foreign-owner', apply() { foreignCopies++; foreignDisplay.fill(255); }, release() { foreignDisplay.fill(0); } }); },
      approveOutput() { outputApproved = true; return currentViews().attach(output()); },
      revokeOutput() { outputGrant.abort(); },
      retryOutput() { outputGrant.signal.removeEventListener('abort', revoke); outputGrant = new AbortController(); outputGrant.signal.addEventListener('abort', revoke, { once: true }); return currentViews().attach(output()); },
      stats: () => ({ copies, foreignCopies, releases, lastObservation }),
      stop() { if (closed) return; closed = true; inputRoute.stop(); runtime.close(); views?.stop(); display.fill(0); foreignDisplay.fill(0); outputGrant.signal.removeEventListener('abort', revoke); }
    }; phases.push(phase); return phase;
  }
  try {
    assert.equal(source.provider.status().nativeChildren, 0); assert.deepEqual(await source.provider.start({ purpose: 'denied-launch', version: 1 }), { ok: false, reason: 'denied' }); assert.equal(observations.length, 0);
    record('inert-construction-and-declined-launch-no-child-no-provider');
    launchAllowed = true; const started = await source.provider.start({ purpose: 'explicit-reviewed-launch', version: 1 }); assert.ok(started.ok); await source.provider.handoffHost().resume(handoff.authority());
    assert.notEqual(observations[0].pid, process.pid); assert.equal(observations[0].codeSha256, HOSTED_APPLICATION_SOURCE_SHA256);
    record('fixed-hash-owned-independently-executing-native-application');
    await unauthorized(observations[0].socketPath); await unauthorized(observations[0].socketPath, 2); assert.equal(source.provider.status().inputs, 0);
    record('real-native-wrong-capability-and-version-deny-before-engine-input-render');
    const sourceEpoch = started.value, first = phaseFor(source, sourceEpoch);
    assert.equal((await first.command(3, 2)).ok, false); assert.equal(source.provider.status().inputs, 0);
    record('SDK-source-sink-route-grants-separate-from-native-launch');
    assert.ok(first.approveInput().ok); assert.equal((await first.command(3, 2)).ok, false); assert.equal(source.provider.status().inputs, 0);
    source.allowed.add('input'); assert.ok((await first.command(3, 2)).ok); assert.equal(first.inputRoute.operations().at(-1).effectEvidence, 'target-acknowledged');
    record('real-public-runtime-invoke-target-and-native-owner-input-grant-with-ACK');
    assert.equal((await source.provider.frame(sourceEpoch, { purpose: 'declined-frame', signal: source.owner.signal })).ok, false);
    source.allowed.add('frame'); const frame = await source.provider.frame(sourceEpoch, { purpose: 'approved-frame', signal: source.owner.signal }); assert.ok(frame.ok); verifyRaster(frame.value.pixels, 3, 2);
    record('separate-sensitive-frame-approval-actual-child-rendered-RGBA64');
    assert.equal(first.denyOutput().ok, false); assert.equal(first.denyForeign().ok, false); assert.equal(first.stats().copies, 0); assert.equal(first.stats().foreignCopies, 0);
    assert.ok(first.approveOutput().ok); assert.equal(first.views.tick(), true); verifyRaster(first.display, 3, 2); assert.equal(first.stats().copies, 1);
    assert.deepEqual(first.stats().lastObservation.value.sourceTime, frame.value.sourceTime); assert.equal(first.stats().lastObservation.value.receiptClockId, frame.value.receiptClockId); assert.notEqual(first.stats().lastObservation.clockDomain, frame.value.sourceTime.clockId);
    record('independent-ApplicationViews-output-current-grant-exact-native-bytes-source-clock-preserved');
    first.revokeOutput(); assert.equal(first.display.every(byte => byte === 0), true); assert.equal(first.views.status().outputs, 0); assert.ok(first.retryOutput().ok);
    record('output-revoke-clears-owned-memory-and-explicit-output-retry');
    const capsule = createApplicationSnapshot(definition.workload, definition.context, { ...frame.value.state });
    const restored = await restoreApplicationSnapshot(definition.workload, definition.context, capsule, [], stateValid); assert.ok(restored.ok); assert.equal(capsule.application.codeSha256, HOSTED_APPLICATION_SOURCE_SHA256);
    const oldToken = handoff.authority(), transferred = await handoff.transfer(target.provider.handoffHost()); assert.ok(transferred.ok);
    assert.equal(oldToken.signal.aborted, true); assert.equal(source.provider.status().nativeChildren, 0); assert.equal(first.views.status().state, 'stopped'); assert.equal(first.display.every(byte => byte === 0), true);
    assert.equal((await source.provider.input(sourceEpoch, { x: 0, y: 0 }, { purpose: 'stale-input', signal: source.owner.signal, context: { signal: source.owner.signal, isCurrent: () => true } })).ok, false);
    record('pinned-snapshot-two-real-local-child-handoff-old-settlement-before-new-resume');
    assert.notEqual(observations[0].pid, observations[1].pid); target.allowed.add('frame');
    const targetEpoch = target.provider.epoch(), targetFrame = await target.provider.frame(targetEpoch, { purpose: 'fresh-target-frame', signal: target.owner.signal }); assert.ok(targetFrame.ok); assert.deepEqual(targetFrame.value.state, frame.value.state); verifyRaster(targetFrame.value.pixels, 3, 2);
    assert.equal(targetFrame.value.sourceTime.clockId, `hosted-raster:${observations[1].pid}:${observations[1].epoch}`);
    assert.notEqual(targetFrame.value.sourceTime.clockId, frame.value.sourceTime.clockId); assert.notEqual(targetFrame.value.receiptClockId, frame.value.receiptClockId);
    const second = phaseFor(target, targetEpoch); assert.ok(second.approveInput().ok); assert.ok(second.approveOutput().ok); second.views.tick(); verifyRaster(second.display, 3, 2);
    target.allowed.add('input'); assert.ok((await second.command(0, 1)).ok); const changed = await target.provider.frame(targetEpoch, { purpose: 'new-child-frame', signal: target.owner.signal }); assert.ok(changed.ok); verifyRaster(changed.value.pixels, 0, 1); assert.notEqual(digest(Buffer.from(changed.value.pixels)), digest(Buffer.from(targetFrame.value.pixels)));
    await pause(10); second.views.tick(); verifyRaster(second.display, 0, 1);
    assert.deepEqual(second.stats().lastObservation.value.sourceTime, changed.value.sourceTime); assert.equal(second.stats().lastObservation.value.receiptClockId, changed.value.receiptClockId);
    assert.equal(second.stats().lastObservation.clockDomain, 'host-projection-clock'); assert.notEqual(changed.value.sourceTime.clockId, 'host-projection-clock');
    record('target-needs-fresh-input-frame-output-approvals-real-render-changes');
    await pause(260); assert.equal(target.provider.currentFrame(targetEpoch), undefined); assert.equal(second.views.tick(), false); await target.provider.stop(); assert.equal(second.display.every(byte => byte === 0), true);
    record('quiet-native-frame-receipt-expiry-cannot-be-refreshed-by-host-projection-turn');
    const replacement = await target.provider.start({ purpose: 'fresh-native-registration', version: 1 }); assert.ok(replacement.ok); await target.provider.handoffHost().resume(handoff.authority());
    assert.notEqual(replacement.value, targetEpoch); assert.equal((await target.provider.frame(targetEpoch, { purpose: 'stale-frame', signal: target.owner.signal })).ok, false);
    assert.ok((await target.provider.frame(replacement.value, { purpose: 'fresh-replacement-frame', signal: target.owner.signal })).ok);
    const third = phaseFor(target, replacement.value); assert.ok(third.approveInput().ok);
    const cancelled = await third.command(1, 1, true); assert.equal(cancelled.ok, false); assert.equal(cancelled.issued, true); assert.equal(cancelled.uncertain, true); await target.provider.stop();
    assert.equal(third.display.every(byte => byte === 0), true); assert.equal(target.provider.status().nativePending, 0);
    record('actual-native-connect-then-cancel-issued-input-is-uncertain-no-late-delivery');
    record('native-stop-epoch-replacement-requires-fresh-exact-approval');
    for (const phase of phases) phase.stop(); for (const provider of providers) await provider.close();
    for (const provider of providers) assert.equal(provider.status().cleanupVerified, true);
    for (const observation of observations) assert.equal(existsSync(observation.socketPath.slice(0, -2)), false);
    record('actual-child-socket-IPC-callback-timer-view-runtime-directory-settlement-cleanup');
    return { result: 'pass', profile: HOSTED_APPLICATION_PROFILE, node: process.version, platform: process.platform, checks, childSourceSha256: HOSTED_APPLICATION_SOURCE_SHA256,
      actualChildStarts: providers.reduce((sum, provider) => sum + provider.status().starts, 0), nativeInputs: providers.reduce((sum, provider) => sum + provider.status().inputs, 0), nativeOperations: providers.reduce((sum, provider) => sum + provider.status().operations, 0),
      approvalScopes: scopes, limits: HOSTED_APPLICATION_LIMITS, nativeRaster: { width: 4, height: 4, format: 'raw-rgba8', bytes: 64, verifiedInIndependentConsumer: true, syntheticPositiveFrames: false },
      cleanup: { children: 0, rawPending: 0, timers: 0, ownedDirectories: 0, retainedDisplayBytes: 0 },
      excluded: ['cross-host', 'network-service', 'encoded-media', 'audio', 'arbitrary-application', 'OS-input', 'OS-sandbox', 'account-authentication', 'physical-display', 'phone', 'UI', 'general-platform-qualification'] };
  } finally {
    for (const phase of phases) phase.stop(); for (const owner of owners) owner.abort(); for (const grant of grants) grant.abort(); for (const provider of providers) await provider.close();
  }
}
