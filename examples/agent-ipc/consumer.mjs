import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createScopedAgentIpc, SCOPED_AGENT_IPC_LIMITS, SCOPED_AGENT_IPC_SOURCE_SHA256 } from '@101/hub-server';
import { createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';

const routeKey = request => JSON.stringify([request.principalId, request.applicationId, request.sessionId,
  request.source.registrationId, request.sink.registrationId, request.sourceOperation, request.sinkOperation]);
async function until(check, message) { const end = performance.now() + 2500;
  while (!check()) { assert.ok(performance.now() < end, message); await new Promise(resolve => setTimeout(resolve, 5)); } }
async function foreignCaller(socketPath, frame) {
  // A genuinely separate owned process, with no inherited agent IPC capability.
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
    import net from 'node:net';const s=net.createConnection(process.argv[1]);let bytes=0,text='';
    s.on('connect',()=>s.end(process.argv[2]+'\\n'));s.on('data',c=>{bytes+=c.byteLength;if(bytes>4096)process.exit(65);text+=c;});
    s.on('end',()=>process.stdout.write(text));s.on('error',()=>process.exit(66));setTimeout(()=>process.exit(67),2000).unref();
  `, socketPath, JSON.stringify(frame)], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', NODE_OPTIONS: '', NODE_PATH: '' } });
  let output = '', errors = '', bytes = 0;
  child.stdout.on('data', chunk => { bytes += chunk.byteLength; assert.ok(bytes <= 4096); output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const code = await new Promise(resolve => child.once('close', resolve)); assert.equal(code, 0); assert.equal(errors, '');
  return JSON.parse(output);
}

/** One fixed agent reads only its own process RSS. Private socket capability,
 * agent registration, operation approval and SDK route grants are distinct.
 * No executable/path selection, account authentication or install/update work. */
export async function runScopedAgentIpcExample() {
  const owner = new AbortController(), observations = [], samples = [], checks = [], exactApprovals = [];
  let allowRegistration = false, allowRead = false, registration = new AbortController(), read = new AbortController();
  let registrationCalls = 0, readCalls = 0, runtime, currentSource, invocation, deviceEpoch;
  const controller = createScopedAgentIpc({ ownerId: 'owned-native-agent-operator', signal: owner.signal,
    authorizeRegistration(request) { registrationCalls++; assert.equal(request.action, 'register'); assert.ok(Object.isFrozen(request));
      if (!allowRegistration) return; exactApprovals.push({ action: request.action, epoch: request.epoch, version: request.version });
      return { request, signal: registration.signal, expiresAt: performance.now() + 9000 }; },
    authorizeRead(request) { readCalls++; assert.equal(request.action, 'read'); assert.ok(Object.isFrozen(request));
      if (!allowRead || request.epoch !== deviceEpoch) return;
      exactApprovals.push({ action: request.action, epoch: request.epoch, version: request.version });
      return { request, signal: read.signal, expiresAt: performance.now() + 1500 }; },
    onAgent(observation) { observations.push(observation); assert.ok(observations.length <= 2); },
    onRetire(observation) {
      if (observation.epoch !== deviceEpoch) return;
      if (currentSource) { runtime.setReadiness(currentSource, 'unavailable'); runtime.unregister(currentSource); }
      invocation?.stop('owned-agent-retired'); currentSource = undefined;
    } });
  const statusBefore = controller.status(); assert.equal(statusBefore.starts, 0);
  assert.equal((await controller.start({ purpose: 'read-own-rss', version: 1 })).ok, false); assert.equal(controller.status().starts, 0);
  checks.push('inert-construction-and-denied-registration-no-child');
  const scope = { principalId: 'owned-native-agent-operator', applicationId: 'agent-ipc-example', sessionId: 'first-agent' };
  let routeApproval = new AbortController(), allowRoutes = false, commandSource, commandSink, viewer;
  const routeApprovals = new Map(), viewed = [], commandResults = [];
  runtime = createDeviceRuntime({ clockDomain: 'agent-example-host:' + process.pid, now: () => performance.now(), maxPendingDeliveries: 1,
    authorize(request) { const signal = routeApprovals.get(routeKey(request));
      return allowRoutes && signal && !signal.aborted ? { expiresAt: performance.now() + 1500, maxAgeMs: 1000, maxHz: 100 } : undefined; } });
  function descriptor(id) {
    return parseDeviceDescriptor({ schemaVersion: 1, id, label: 'Owned native Node RSS agent', revision: 1,
      adapter: { id: 'example:private-node-agent', version: '1.0.0' }, runtime: { platform: 'node-private-ipc' }, capabilities: [
        { id: 'request', semantic: 'example:agent-rss-request', schemaVersion: 1, kind: 'event', value: { type: 'boolean' }, permissions: ['subscribe'], delivery: { mode: 'reliable', maxAgeMs: 1000 } },
        { id: 'invoke', semantic: 'example:agent-rss-request', schemaVersion: 1, kind: 'job', value: { type: 'boolean' }, permissions: ['invoke'], ownership: { mode: 'exclusive' }, delivery: { mode: 'reliable', maxAgeMs: 1000 } },
        { id: 'rss', semantic: 'example:agent-own-rss', schemaVersion: 1, kind: 'property', value: { type: 'scalar', unit: 'By', min: 1, max: Number.MAX_SAFE_INTEGER }, permissions: ['read'], delivery: { mode: 'latest', maxHz: 100, maxAgeMs: 1000 } },
        { id: 'viewer', semantic: 'example:agent-own-rss', schemaVersion: 1, kind: 'property', value: { type: 'scalar', unit: 'By', min: 1, max: Number.MAX_SAFE_INTEGER }, permissions: ['write'], ownership: { mode: 'observe' }, delivery: { mode: 'latest', maxHz: 100, maxAgeMs: 1000 } },
      ] });
  }
  function connect(from, to, sourceOperation, sinkOperation, permitted) {
    if (permitted) routeApprovals.set(JSON.stringify([scope.principalId, scope.applicationId, scope.sessionId, from.id, to.id, sourceOperation, sinkOperation]), routeApproval.signal);
    return runtime.route({ from, to, ...scope, sourceOperation, queueCapacity: 1, leaseMs: 1000 });
  }
  let currentHandle, operation = 0;
  async function bind(handle) {
    currentHandle = handle; const observed = observations.at(-1); deviceEpoch = observed.epoch;
    const device = descriptor(`owned-agent:${observed.pid}:${observed.epoch}`);
    currentSource = runtime.registerSource({ device, capability: 'rss' }); commandSource = runtime.registerSource({ device, capability: 'request' });
    commandSink = runtime.registerSink({ device, capability: 'invoke', async apply(observation, context) {
      assert.equal(observation.value, true); const result = await controller.readRss(handle, { purpose: 'read-own-rss',
        signal: AbortSignal.any([context.signal, routeApproval.signal]) });
      commandResults.push(result);
      if (!result.ok || context.signal.aborted || !context.isCurrent()) throw Error('Owned native agent unavailable');
      const sample = result.value; samples.push(sample);
      assert.notEqual(sample.sourceTime.clockId, sample.receiptClockId); assert.equal(sample.sourceTime.clockId, `agent-rss:${observed.pid}:${observed.epoch}`);
      assert.equal(sample.quality, 'valid'); assert.equal(sample.sequence, samples.filter(item => item.sourceTime.clockId === sample.sourceTime.clockId).length);
      runtime.setReadiness(currentSource, 'available', performance.now() + 1000);
      assert.ok(runtime.publish(currentSource, sample.rssBytes, { timestamp: performance.now(), clockDomain: 'agent-example-host:' + process.pid,
        quality: sample.quality, provenance: { sourceTime: sample.sourceTime, sourceQuality: sample.quality,
          nativeReceiptClockId: sample.receiptClockId, nativeReceivedAt: sample.receivedAt, reviewedChildSha256: SCOPED_AGENT_IPC_SOURCE_SHA256 } }).ok);
      if (!context.signal.aborted && context.isCurrent()) context.reportEvidence('target-acknowledged');
    }, release() {} });
    viewer = runtime.registerSink({ device, capability: 'viewer', apply(observation) { viewed.push(observation); }, release() {} });
    for (const endpoint of [commandSource, commandSink, viewer]) runtime.setReadiness(endpoint, 'available');
  }
  async function invoke(permitted) {
    invocation = connect(commandSource, commandSink, 'subscribe', 'invoke', permitted);
    const started = invocation.start();
    if (!started.ok) return { started };
    const before = commandResults.length, id = String(++operation);
    assert.ok(runtime.publish(commandSource, true, { operationId: id, deadline: performance.now() + 1000 }).ok); runtime.flush();
    await until(() => commandResults.length > before, 'Actual agent request settles');
    await until(() => invocation.operations().some(row => ['failed', 'returned'].includes(row.handlerResult)), 'Runtime callback settles');
    const result = commandResults.at(-1), operations = invocation.operations(); invocation.stop(); return { result, operations };
  }
  async function observe(permitted) {
    const connection = connect(currentSource, viewer, 'read', 'write', permitted), before = viewed.length, started = connection.start();
    if (started.ok) runtime.flush(); connection.stop(); assert.equal(viewed.length, before + Number(started.ok)); return started;
  }
  try {
    allowRegistration = true; const first = await controller.start({ purpose: 'read-own-rss', version: 1 }); assert.ok(first.ok); await bind(first.value);
    assert.equal((await stat(observations[0].socketPath)).mode & 0o777, 0o600);
    assert.equal((await stat(new URL('.', 'file://' + observations[0].socketPath))).mode & 0o777, 0o700);
    for (const frame of [{ version: 1, epoch: deviceEpoch, action: 'read-rss', id: 'foreign' },
      { version: 1, epoch: deviceEpoch, action: 'read-rss', id: 'foreign', capability: 'f'.repeat(64) },
      { version: 2, epoch: deviceEpoch, action: 'read-rss', id: 'foreign', capability: 'é'.repeat(64) }]) {
      assert.deepEqual(await foreignCaller(observations[0].socketPath, frame), { ok: false, reason: 'denied' });
    }
    checks.push('actual-separate-native-callers-without-inherited-capability-denied-before-RSS', 'owned-directory0700-socket0600');
    assert.equal((await invoke(false)).started.ok, false); assert.equal(controller.status().reads, 0);
    allowRoutes = true; assert.equal((await invoke(true)).result.reason, 'denied'); assert.equal(controller.status().reads, 0);
    checks.push('SDK-invoke-grant-independent-of-agent-registration', 'native-read-grant-independent-of-SDK-invoke');
    allowRead = true; const actual = await invoke(true); assert.ok(actual.result.ok); assert.equal(actual.result.value.sequence, 1);
    assert.equal((await observe(false)).ok, false); assert.equal(viewed.length, 0); assert.equal((await observe(true)).ok, true);
    assert.equal(viewed[0].value, actual.result.value.rssBytes); assert.deepEqual(viewed[0].provenance.sourceTime, actual.result.value.sourceTime);
    assert.ok(actual.operations.some(row => row.effectEvidence === 'target-acknowledged'));
    checks.push('actual-child-memoryUsage-RSS-through-current-public-runtime-route', 'source-clock-quality-preserved-separate-host-receipt', 'sensitive-RSS-result-separate-current-read-grant');
    const oldSource = currentSource, oldHandle = first.value, oldPid = observations[0].pid;
    process.kill(oldPid, 'SIGKILL'); await until(() => controller.status().phase !== 'ready', 'Actual native crash retires epoch'); await controller.stop();
    assert.equal(currentSource, undefined); assert.equal(connect(oldSource, viewer, 'read', 'write', true).start().ok, false);
    assert.equal((await controller.readRss(oldHandle, { purpose: 'read-own-rss', signal: owner.signal })).ok, false);
    assert.equal(controller.status().nativeChildren, 0); checks.push('actual-crash-retires-agent-resource-and-all-old-authority');
    allowRegistration = false; assert.equal((await controller.start({ purpose: 'fresh-own-rss', version: 1 })).ok, false);
    assert.equal(controller.status().starts, 1); checks.push('replacement-denied-without-fresh-explicit-registration');
    for (const endpoint of [commandSource, commandSink, viewer]) runtime.unregister(endpoint);
    routeApproval.abort(); routeApprovals.clear(); registration = new AbortController(); read = new AbortController(); routeApproval = new AbortController();
    allowRegistration = true; allowRead = true; allowRoutes = false; scope.sessionId = 'fresh-agent';
    const replacement = await controller.start({ purpose: 'fresh-own-rss', version: 1 }); assert.ok(replacement.ok); assert.notEqual(replacement.value, oldHandle); await bind(replacement.value);
    assert.notEqual(observations[1].pid, oldPid); assert.equal((await invoke(false)).started.ok, false);
    assert.equal((await controller.readRss(oldHandle, { purpose: 'read-own-rss', signal: owner.signal })).ok, false);
    assert.deepEqual(await foreignCaller(observations[1].socketPath, { version: 1, epoch: observations[0].epoch,
      action: 'read-rss', id: 'old-epoch', capability: 'f'.repeat(64) }), { ok: false, reason: 'denied' });
    allowRoutes = true; const fresh = await invoke(true); assert.ok(fresh.result.ok); assert.equal(fresh.result.value.sequence, 1); assert.equal((await observe(true)).ok, true);
    checks.push('fresh-process-epoch-identity-registration-and-resource-route-required', 'old-native-epoch-and-old-handles-cannot-control-replacement');
    registration.abort(); await controller.stop(); assert.equal(currentSource, undefined);
    assert.equal((await controller.readRss(currentHandle, { purpose: 'read-own-rss', signal: owner.signal })).ok, false);
    checks.push('actual-registration-abort-retires-native-agent-and-runtime-resource');
  } finally { owner.abort(); routeApproval.abort(); runtime.close(); await controller.close(); }
  const terminal = controller.status(); assert.equal(terminal.nativePending, 0); assert.equal(terminal.nativeChildren, 0); assert.equal(terminal.timers, 0); assert.equal(terminal.cleanupVerified, true);
  for (const observation of observations) await assert.rejects(stat(observation.socketPath), error => error.code === 'ENOENT');
  checks.push('actual-child-socket-owned-directory-timer-and-raw-slot-cleanup');
  return { result: 'pass', profile: 'private-node-agent-rss/1', node: process.version, platform: process.platform, checks,
    childCodeSha256: SCOPED_AGENT_IPC_SOURCE_SHA256, nativeChildrenStarted: terminal.starts, registrationCalls, readCalls,
    approvals: exactApprovals, samples, terminal, limits: SCOPED_AGENT_IPC_LIMITS, syntheticPositiveResponses: false,
    cleanup: { nativeChildrenAlive: 0, socketsRemaining: 0, operationTimers: 0, rawPending: 0 },
    excluded: ['account-authentication', 'malicious-same-user-host', 'sandbox', 'installed-agent', 'update-qualification', 'other-OS', 'other-process-memory', 'physical-sensor', 'UI', 'phone', 'remote'] };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(await runScopedAgentIpcExample()));
