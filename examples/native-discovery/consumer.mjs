import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, get } from 'node:http';
import * as sdk from '@101/connect';
import * as runtime from '@101/device-runtime';
import { createMacosDnsSdProvider } from './process-port.mjs';

export async function runNativeDiscoveryExample({ executable, sha256, featureRed = false }) {
  assert.equal(process.platform, 'darwin', 'This proof requires installed macOS DNS-SD, never a simulated backend');
  const tag = randomBytes(4).toString('hex'), serviceType = `_101l${tag}._tcp`, name = `101-owned-${tag}`;
  const scope = Object.freeze({ ownerId: 'owned-operator', applicationId: 'native-discovery-caller', sessionId: `owned-${tag}`,
    serviceType, domain: 'local.', interfaceIndex: 0xffffffff, profile: 'macos-local-only-dns-sd/1', operation: 'observe' });
  const processes = new Set(), transcripts = [], checks = [], controllerRows = [];
  let registration, controller, allowed = false, nativeOpened = 0, rawExited = 0, ownerRequests = 0, ownedChild, grantAbort = new AbortController();
  const server = createServer((request, response) => { if (request.url !== '/owned-software') { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ profile: 'owned-software/1', tag })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(predicate, message, timeout = 5000) {
    const end = performance.now() + timeout; while (performance.now() < end) { if (predicate()) return; await pause(5); }
    throw new Error(`Owned native check failed: ${message}`);
  }
  async function register() {
    let text = '', ready = false; const child = spawn(executable, ['register', serviceType, name, String(port), '30000'],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, timeout: 30000 });
    processes.add(child); child.stdin.on('error', () => {}); child.on('error', () => {});
    const done = new Promise(resolve => child.once('close', (code, signal) => { processes.delete(child); resolve({ code, signal }); }));
    child.stdout.on('data', chunk => { text += String(chunk); assert.ok(text.length <= 512); if (text.includes('"ready"')) ready = true; });
    child.stderr.on('data', () => { ready = false; });
    await until(() => ready, 'actual LocalOnly registration');
    return { child, done, async stop() { child.stdin.end('stop\n'); return done; } };
  }
  const provider = createMacosDnsSdProvider({ executable, sha256, onProcess(child) { ownedChild = child; processes.add(child); child.once('close', () => processes.delete(child)); } });
  assert.ok(provider);
  const tracedProvider = Object.freeze({ profile: provider.profile, open(request, callbacks, signal) {
    nativeOpened++; return provider.open(request, { event(event) { assert.ok(transcripts.length < 128); transcripts.push(event); callbacks.event(event); },
      closed() { rawExited++; callbacks.closed(); } }, signal);
  } });
  function snapshot(action) { const state = controller.snapshot(); controllerRows.push({ action, phase: state.phase, count: state.rows.length,
    rawReservations: state.rawReservations, timerArmed: state.timerArmed }); return state; }
  try {
    registration = await register();
    if (featureRed) {
      const abort = new AbortController(); const operation = tracedProvider.open(scope, { event() {}, closed() {} }, abort.signal);
      try {
        await until(() => transcripts.some(event => event.type === 'resolved' && event.name === name && event.port === port && event.interfaceIndex === 0xffffffff), 'real native producer before absent old SDK API');
        console.error(JSON.stringify({ featureRed: true, actualNativeProducer: transcripts.find(event => event.type === 'resolved'), oldSdkControllerType: typeof sdk.createNativeDiscoveryController }));
        assert.equal(typeof sdk.createNativeDiscoveryController, 'function', 'Real LocalOnly native callback has no owner-scoped SDK provider in the old public closure');
      } finally { abort.abort(); operation.stop(); await until(() => rawExited > 0, 'red native process exit'); }
      return;
    }
    assert.equal(sdk.createNativeDiscoveryController, runtime.createNativeDiscoveryController);
    controller = sdk.createNativeDiscoveryController({ scope, now: Date.now, provider: tracedProvider, authorize(request) {
      ownerRequests++; return allowed ? { scope: request, expiresAt: Date.now() + 10000, isCurrent: () => allowed, signal: grantAbort.signal } : undefined;
    } });
    assert.equal(nativeOpened, 0); assert.equal(controller.start().ok, false); assert.equal(nativeOpened, 0); snapshot('Denied fresh host grant');
    allowed = true; assert.ok(controller.start().ok); await until(() => controller.snapshot().rows.some(row => row.service.name === name), 'real resolved SDK row');
    let row = controller.snapshot().rows.find(row => row.service.name === name); assert.equal(row.service.interfaceIndex, 0xffffffff);
    assert.equal(row.service.target, 'localhost.'); assert.equal(row.service.port, port); assert.equal(row.service.txtHex, '0970726f66696c653d31');
    assert.equal(row.candidate.evidence.length, 1); assert.equal(controller.assess(row.handle).state, 'observed'); assert.equal(controller.assess({ ...row.handle }), undefined);
    snapshot('Actual native callback observed'); checks.push('inert constructor and denied start; native LocalOnly callback/port/TXT reaches public SDK');
    // This endpoint is provisioned by the owner who created the fixture. No URL
    // is built from discovery metadata and discovery supplies no request grant.
    let requestAllowed = false; assert.equal(requestAllowed, false); requestAllowed = true;
    assert.ok(requestAllowed && controller.assess(row.handle).state === 'observed');
    const reply = await new Promise((resolve, reject) => { get({ host: '127.0.0.1', port, path: '/owned-software' }, response => {
      let bytes = ''; response.on('data', chunk => { bytes += String(chunk); assert.ok(bytes.length <= 256); }); response.on('end', () => resolve(JSON.parse(bytes)));
    }).on('error', reject); }); assert.deepEqual(reply, { profile: 'owned-software/1', tag });
    checks.push('independently selected/authorized owned loopback software reply; observed metadata has no identity/capability/resource grant');
    // No new native frame or manual sweep renews this observation while the
    // authoritative registration remains present. SDK-owned expiry removes it.
    const observedHandle = row.handle; await until(() => controller.snapshot().rows.length === 0, 'quiet observation expiry', 3500);
    assert.equal(controller.assess(observedHandle), undefined); assert.equal(registration.child.exitCode, null); snapshot('Quiet observed receipt expiry');
    controller.stop(); assert.equal(controller.snapshot().rawReservations, 1); assert.deepEqual(controller.start(), { ok: false, reason: 'busy' });
    await until(() => controller.snapshot().rawReservations === 0, 'real provider exit'); assert.ok(controller.start().ok);
    await until(() => controller.snapshot().rows.length > 0, 'explicit fresh-grant native rescan'); row = controller.snapshot().rows[0];
    assert.equal(controller.assess(observedHandle), undefined); checks.push('quiet expiry; cancellation retains actual process reservation; explicit rescan obtains fresh owner grant/handle');
    const removedBefore = transcripts.filter(event => event.type === 'removed').length;
    assert.deepEqual(await registration.stop(), { code: 0, signal: null }); registration = undefined;
    await until(() => transcripts.filter(event => event.type === 'removed').length > removedBefore, 'genuine native withdrawal');
    assert.equal(controller.snapshot().rows.length, 0); assert.equal(controller.assess(row.handle), undefined); snapshot('Native registration deallocation withdraws row');
    checks.push('real native withdrawal removes row and opaque handle');
    registration = await register(); await until(() => controller.snapshot().rows.length > 0, 'native add after withdrawal');
    grantAbort.abort(); assert.equal(controller.snapshot().rows.length, 0); assert.equal(controller.snapshot().rawReservations, 1);
    await until(() => controller.snapshot().rawReservations === 0, 'revoked actual raw process close'); assert.equal(controller.snapshot().timerArmed, false);
    snapshot('Owner grant revoked'); checks.push('owner signal revocation fences late native frames and tracks actual exit');
    grantAbort = new AbortController(); assert.ok(controller.start().ok); await until(() => controller.snapshot().rows.length > 0, 'fresh grant after revocation');
    const crashCount = nativeOpened, handle = controller.snapshot().rows[0].handle; ownedChild.kill('SIGKILL');
    await until(() => controller.snapshot().rawReservations === 0, 'actual native provider crash'); assert.equal(controller.assess(handle), undefined);
    await pause(80); assert.equal(nativeOpened, crashCount); assert.equal(controller.snapshot().rows.length, 0); assert.equal(controller.snapshot().timerArmed, false);
    snapshot('Owned native process crash'); checks.push('actual provider crash retires observations and cannot automatically restart');
    const wrongOwner = sdk.createNativeDiscoveryController({ scope, now: Date.now, provider: tracedProvider, authorize(request) {
      return { scope: { ...request, ownerId: 'other-owner' }, expiresAt: Date.now() + 10000, isCurrent: () => true };
    } }); assert.equal(wrongOwner.start().ok, false); wrongOwner.close(); assert.equal(nativeOpened, crashCount);
    const unsupported = sdk.createNativeDiscoveryController({ scope, now: Date.now, authorize: () => undefined });
    assert.deepEqual(unsupported.start(), { ok: false, reason: 'unsupported' }); unsupported.close(); checks.push('wrong owner exact grant denied; missing native host backend truthfully unsupported');
    controller.close(); assert.equal(controller.snapshot().phase, 'closed');
    return { kind: 'actual-macos-local-only-dns-sd', profile: sdk.NATIVE_DISCOVERY_PROFILE, ownerRequests, nativeOpened, rawExited, nativeFrames: transcripts,
      originalResolvedSha256: createHash('sha256').update(JSON.stringify(transcripts.find(event => event.type === 'resolved'))).digest('hex'),
      steps: controllerRows, actualOwnedReply: reply, checks, cleanup: { controllerClosed: true, noRawReservation: controller.snapshot().rawReservations === 0 },
      scope: 'Native LocalOnly authoritative DNS-SD records only. No LAN multicast, other platform, authenticated identity, advertised capability, optical/phone or discovery-derived resource permission.' };
  } finally {
    controller?.close(); if (registration) await registration.stop();
    for (const child of processes) { try { child.stdin.end('stop\n'); } catch { /* A stopped child may already have closed stdin. */ } if (child.exitCode === null) child.kill('SIGTERM'); }
    await until(() => processes.size === 0, 'every owned native child/listener exits'); await new Promise(resolve => server.close(resolve));
  }
}
if (process.argv[1]?.endsWith('/consumer.mjs')) {
  try { const config = JSON.parse(process.env.NATIVE_DISCOVERY_CALLER_CONFIG ?? '{}'); const result = await runNativeDiscoveryExample(config); console.log(JSON.stringify(result)); }
  catch (error) { console.error(String(error)); process.exitCode = 1; }
}
