import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Root owns execution, the already-built loopback server and actual source/resolver
// capture. This helper never starts a server, compiles, installs or touches devices.
const args = process.argv.slice(2), featureRed = args.includes('--feature-red');
const value = flag => { const index = args.indexOf(flag); assert.ok(index >= 0 && args[index + 1] && !args[index + 1].startsWith('--'), 'required owned QA input'); return args[index + 1]; };
const origin = new URL(args[0]);
assert.ok(origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) && origin.pathname === '/' && !origin.search && !origin.hash && !origin.username && !origin.password, 'owned loopback application origin');
const servedProof = resolve(value('--served-proof'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const servedBytes = readFileSync(servedProof), served = JSON.parse(servedBytes);
assert.ok(served.schemaVersion === 1 && served.origin === origin.origin && typeof served.sourceRoot === 'string' &&
  /^[a-f0-9]{40}$/.test(served.sourceTree) && served.sourcePins && Array.isArray(served.buildInputs) && served.buildRecord, 'owned served source/build proof');
const root = resolve(served.sourceRoot), sdkEntry = args.includes('--sdk-entry') ? resolve(value('--sdk-entry')) : resolve(root, 'packages/connect/src/index.ts');
const selectedEngine = args.includes('--engine') ? value('--engine') : undefined;
assert.ok(selectedEngine === undefined || ['chromium', 'webkit'].includes(selectedEngine), 'explicit supported QA engine');
const work = mkdtempSync(join(tmpdir(), '101-reading-connections-'));
const output = args.includes('--output') ? resolve(value('--output')) : join(work, 'receipt.json');
assert.ok(!existsSync(output), 'QA receipt must be new');
const report = { schemaVersion: 1, status: 'pending', mode: featureRed ? 'old-feature-absence' : 'selected-source-ui',
  phase: 'source-build-pins', servedProofSHA: hash(servedBytes), servedSourceTree: served.sourceTree,
  sdkEntrySHA: undefined, publicPrefix: undefined,
  oldHydratedPrefix: false, oldStructuredEntryCount: undefined,
  checks: [], engines: [], retirements: [], pageErrors: 0, pageErrorDetails: [], foreignRequests: 0, contextsClosed: 0, browsersClosed: 0,
  failure: undefined,
  cleanup: { pagesClosed: false, contextCloseAwaited: false, browserClosed: false },
  productStateHook: 'redacted101-readings-retired event only', workerExitObserved: false,
  scope: 'Selected local software route/UI only; no installed-UI, physical device, OS input, relay, phone or named-reader claim.' };
let browser, context, contextsOpened = 0, browsersOpened = 0, activeEngine = 'unstarted', activeBrowserVersion;
const ownedPages = [];
const diagnosticRedactions = new Set();
function rememberPrivateCode(code) {
  assert.ok(typeof code === 'string' && code.length <= 65536 && diagnosticRedactions.size < 24, 'owned private code diagnostic bound');
  if (code) diagnosticRedactions.add(code);
}
function failureDetails(error) {
  const bounded = (value, limit) => {
    let text = typeof value === 'string' ? value : '';
    for (const code of diagnosticRedactions) text = text.replaceAll(code, '[pairing code redacted]');
    text = text.replace(/101-readings-1\.[A-Za-z0-9_-]+/g, '[pairing code redacted]');
    return text.slice(0, limit);
  };
  return { name: bounded(error instanceof Error ? error.name : 'UnknownThrownValue', 128),
    message: bounded(error instanceof Error ? error.message : typeof error === 'string' ? error : 'QA failed with an unsupported error value', 4096),
    stack: bounded(error instanceof Error ? error.stack : '', 8192), engine: activeEngine,
    phase: report.phase, browserVersion: activeBrowserVersion,
    policy: 'Bounded original developer diagnostics; exact owned exchanged codes and complete comparison strings are removed before truncation.' };
}
async function closeBrowserOwner() {
  try { if (context) { await context.close(); context = undefined; report.contextsClosed++; } }
  finally { if (browser) { await browser.close(); browser = undefined; report.browsersClosed++; } }
  report.cleanup = { pagesClosed: ownedPages.every(page => page.isClosed()),
    contextCloseAwaited: report.contextsClosed === contextsOpened, browserClosed: report.browsersClosed === browsersOpened };
}

class Channel {
  readyState = 'open'; bufferedAmount = 0; binaryType = 'arraybuffer'; bufferedAmountLowThreshold = 0;
  onmessage = null; onclose = null; onerror = null; target;
  constructor(label, options, queue) { this.label = label; this.queue = queue; this.ordered = options.ordered ?? true;
    this.maxRetransmits = options.maxRetransmits ?? null; this.maxPacketLifeTime = options.maxPacketLifeTime ?? null; }
  send(data) {
    assert.ok(this.queue.length < 512, 'owned prefix queue bounded');
    const copy = typeof data === 'string' ? data : data instanceof Uint8Array ? new Uint8Array(data).buffer : data.slice(0);
    this.queue.push(() => { if (this.target?.readyState === 'open') this.target.onmessage?.({ data: copy }); });
  }
  close() { this.readyState = 'closed'; this.onclose?.({}); }
}
const sdp = byte => `v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 ${Array(32).fill(byte).join(':')}\r\na=sctp-port:5000\r\n`;
class Port {
  connectionState = 'new'; iceGatheringState = 'complete'; localDescription = null; onconnectionstatechange = null; ondatachannel = null;
  channels = new Map();
  constructor(queue) { this.queue = queue; }
  createDataChannel(label, options) { const channel = new Channel(label, options, this.queue); this.channels.set(label, channel); return channel; }
  async createOffer() { return { type: 'offer', sdp: sdp('11') }; }
  async createAnswer() { return { type: 'answer', sdp: sdp('22') }; }
  async setLocalDescription(input) { this.localDescription = { type: input.type, sdp: input.sdp }; }
  async setRemoteDescription() {}
  addEventListener() {} removeEventListener() {}
  async getStats() { return new Map(); }
  close() { this.connectionState = 'closed'; }
}
async function publicStructuredPrefix(sdk) {
  // This independent OLD prerequisite uses no new readings implementation. Ports
  // are cooperative software; every identity, proof, wire codec and route is real.
  const queue = [], sourcePort = new Port(queue), receiverPort = new Port(queue), at = 1000;
  const sourcePeer = new sdk.PeerDataTransport({ initiator: true, createPeer: () => sourcePort });
  const receiverPeer = new sdk.PeerDataTransport({ initiator: false, createPeer: () => receiverPort });
  let sourceAuth, receiverAuth, publisher, receiver, runtime, detach;
  let sourceAllowed = false, displayAllowed = false, applications = 0, selectedJSON2 = 0;
  const observed = new Map(), sinks = new Map();
  const record = { type: 'record', fields: { step: { type: 'scalar', unit: '1', min: 0, max: 100 },
    ready: { type: 'boolean' }, mode: { type: 'enum', values: ['count-up', 'count-down'] } }, optional: ['ready'] };
  const device = sdk.parseDeviceDescriptor({ schemaVersion: 1, id: 'owned-structured-prefix', label: 'Owned software readings', revision: 1,
    adapter: { id: 'owned:structured-prefix', version: '1' }, runtime: { platform: 'cooperative-software' }, capabilities: [
      { id: 'row', semantic: 'owned:reading', schemaVersion: 1, kind: 'sample', value: record, permissions: ['subscribe'], delivery: { mode: 'latest', maxHz: 4, maxAgeMs: 1000 } },
      { id: 'rows', semantic: 'owned:reading-table', schemaVersion: 1, kind: 'sample', value: { type: 'array', items: record, minItems: 1, maxItems: 8 },
        permissions: ['subscribe'], delivery: { mode: 'latest', maxHz: 4, maxAgeMs: 1000 } },
    ] });
  const sinkDevice = sdk.parseDeviceDescriptor({ ...device, id: 'owned-structured-display', capabilities: device.capabilities.map(capability => ({
    ...capability, kind: 'property', permissions: ['write'], ownership: { mode: 'observe' } })) });
  const invitation = sdk.createReceiverInvitation({ applicationId: 'owned-structured-prefix', sessionId: 'owned-structured-prefix-session',
    now: 10000, randomBytes: size => sdk.webEndpointCrypto.randomBytes(size) });
  const epoch = invitation.epoch, grant = Object.freeze({ expiresAt: 31000, maxHz: 4, maxAgeMs: 1000 });
  const pump = async condition => {
    for (let turn = 0; turn < 2000 && !condition(); turn++) {
      sourceAuth.tick(); receiverAuth.tick(); publisher.tick(); receiver.tick();
      while (queue.length) queue.shift()(); await new Promise(done => setImmediate(done));
    }
    assert.ok(condition(), 'genuine public structured prerequisite phase');
  };
  const result = { genuineIssuedScopes: false, json2Bindings: 0, recordDelivered: false, arrayDelivered: false,
    applications: 0, sourcePermission: false, displayPermission: false, rawNegotiationsSettled: false,
    peerDisconnectsSettled: false, registrationsReleased: false, queueEntries: 0, nativeRTC: false };
  try {
    sourceAuth = new sdk.AuthenticatedResourcePeer({ transport: sourcePeer, identity: await sdk.createEphemeralWebIdentity(), crypto: sdk.webEndpointCrypto,
      ...invitation, role: 'source', now: () => at, timeoutMs: 60000 });
    receiverAuth = new sdk.AuthenticatedResourcePeer({ transport: receiverPeer, identity: await sdk.createEphemeralWebIdentity(), crypto: sdk.webEndpointCrypto,
      ...invitation, role: 'receiver', now: () => at, timeoutMs: 60000 });
    runtime = sdk.createDeviceRuntime({ now: () => at, clockDomain: 'owned-structured-display-clock', maxRoutes: 2, maxRegistrations: 4, maxPendingDeliveries: 2,
      authorize(request) {
        const sink = sinks.get(request.source.capabilityId);
        if (!displayAllowed || !sink || request.principalId !== 'owned-display-owner' || request.applicationId !== invitation.applicationId || request.sessionId !== invitation.sessionId ||
          request.source.deviceId !== device.id || request.source.descriptorRevision !== 1 || request.source.schemaVersion !== 1 ||
          request.sink.deviceId !== sinkDevice.id || request.sink.registrationId !== sink.id || request.sink.capabilityId !== request.source.capabilityId ||
          request.sink.descriptorRevision !== 1 || request.sink.schemaVersion !== 1 || request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write' || request.partition !== undefined) return;
        return grant;
      } });
    for (const capability of device.capabilities) {
      const sink = runtime.registerSink({ device: sinkDevice, capability: capability.id, apply(observation, delivery) {
        if (!delivery.signal.aborted && delivery.isCurrent()) { observed.set(capability.id, sdk.parseSignalValue(observation.value, capability.value)); applications++; }
      }, release() { observed.delete(capability.id); } });
      sinks.set(capability.id, sink); runtime.setReadiness(sink, 'available');
    }
    receiver = new sdk.RemoteResourceReceiver({ peer: receiverAuth, epoch, clockId: runtime.clockDomain, runtime, now: () => at,
      principalId: 'owned-display-owner', applicationId: invitation.applicationId, sessionId: invitation.sessionId });
    publisher = new sdk.RemoteResourcePublisher({ peer: sourceAuth, epoch, clockId: 'owned-structured-source-clock', now: () => at, device,
      available: capability => sourceAllowed && (capability === 'row' || capability === 'rows') });
    detach = sourceAuth.onData((lane, bytes) => { const decoded = sdk.decodePacket(bytes, lane); if (decoded?.packet.type === 'bind' && decoded.packet.codec === 'json/2') selectedJSON2++; });
    const offer = await sourcePeer.createOffer(), answer = await receiverPeer.acceptOffer(offer); await sourcePeer.acceptAnswer(answer);
    result.rawNegotiationsSettled = true;
    for (const [label, channel] of sourcePort.channels) {
      const remote = new Channel(label, { ordered: channel.ordered, maxRetransmits: channel.maxRetransmits ?? undefined }, queue);
      remote.target = channel; channel.target = remote; receiverPort.channels.set(label, remote); receiverPort.ondatachannel?.({ channel: remote });
    }
    for (const port of [sourcePort, receiverPort]) { port.connectionState = 'connected'; port.onconnectionstatechange?.({}); }
    await pump(() => sourceAuth.status().phase === 'awaiting-enrollment' && receiverAuth.status().phase === 'awaiting-enrollment');
    const digest = sourceAuth.status().comparisonDigest;
    assert.ok(/^[0-9a-f]{64}$/.test(digest) && receiverAuth.status().comparisonDigest === digest, 'actual complete endpoint comparison');
    assert.ok(sourceAuth.confirmEnrollment(digest) && receiverAuth.confirmEnrollment(digest), 'independent endpoint enrollment');
    await pump(() => !!sdk.authenticatedPeerScope(sourceAuth) && !!sdk.authenticatedPeerScope(receiverAuth));
    result.genuineIssuedScopes = true;
    assert.ok(publisher.start(), 'public source starts only after issued authentication');
    await pump(() => !!receiver.description() && receiver.status().clockReady);
    assert.ok(applications === 0 && publisher.status().active === 0, 'pairing and description supply no resource grant');
    sourceAllowed = true; displayAllowed = true;
    for (const capability of device.capabilities) assert.ok(receiver.approve({ capability: capability.id, sink: sinks.get(capability.id), sinkDevice,
      sinkCapability: capability.id, grant }) !== undefined, 'explicit compatible source/display approval');
    await pump(() => receiver.status().active === 2 && publisher.status().active === 2);
    assert.ok(publisher.publish('row', { step: 42, ready: true, mode: 'count-up' }, { capturedAt: at }), 'actual record publication');
    assert.ok(publisher.publish('rows', [{ step: 7, ready: false, mode: 'count-down' }, { step: 42, mode: 'count-up' }], { capturedAt: at }), 'actual array publication');
    await pump(() => observed.size === 2);
    const row = observed.get('row'), rows = observed.get('rows');
    assert.ok(row?.step === 42 && row.ready === true && row.mode === 'count-up', 'actual validated record effect');
    assert.ok(Array.isArray(rows) && rows.length === 2 && rows[0].step === 7 && rows[0].ready === false && rows[1].step === 42 && !Object.hasOwn(rows[1], 'ready'), 'actual validated array and optional absence effect');
    assert.ok(selectedJSON2 === 2 && applications === 2, 'actual json2 route and application counts');
    Object.assign(result, { json2Bindings: selectedJSON2, recordDelivered: true, arrayDelivered: true, applications,
      sourcePermission: sourceAllowed, displayPermission: displayAllowed });
  } finally {
    sourceAllowed = false; displayAllowed = false; publisher?.stop(); receiver?.stop();
    for (const sink of sinks.values()) runtime?.unregister(sink); sinks.clear(); runtime?.close(); detach?.(); sourceAuth?.stop(); receiverAuth?.stop();
    await Promise.all([sourcePeer.disconnect(), receiverPeer.disconnect()]); while (queue.length) queue.shift()();
    result.peerDisconnectsSettled = sourcePort.connectionState === 'closed' && receiverPort.connectionState === 'closed';
    result.registrationsReleased = sinks.size === 0; result.queueEntries = queue.length;
  }
  assert.ok(result.peerDisconnectsSettled && result.registrationsReleased && result.queueEntries === 0, 'actual owned prefix settlement');
  return Object.freeze(result);
}

async function activate(page, name) {
  const button = page.getByRole('button', { name, exact: true }); await button.waitFor();
  const handle = await button.elementHandle(); assert.ok(handle, 'owned keyboard target exists');
  try { await page.waitForFunction(element => element instanceof HTMLButtonElement && !element.disabled, handle); }
  finally { await handle.dispose(); }
  await button.focus();
  assert.ok(await button.evaluate(element => element === document.activeElement), 'native keyboard focus'); await page.keyboard.press('Space');
}
async function fits(page) { assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'reading flow fits viewport'); }
async function retirementCount(expected) {
  const until = performance.now() + 5000;
  while (report.retirements.length < expected && performance.now() < until) await new Promise(done => setTimeout(done, 20));
  assert.ok(report.retirements.length === expected, 'actual product owners reached close settlement');
}
async function exchange(receiverPage, sourcePage) {
  await activate(receiverPage, 'Prepare receiving page');
  const invitation = await receiverPage.getByRole('textbox', { name: 'Receiving invitation', exact: true }).inputValue();
  rememberPrivateCode(invitation);
  await activate(sourcePage, 'Send readings from this page');
  await sourcePage.getByRole('textbox', { name: 'Invitation from receiving page', exact: true }).fill(invitation);
  await activate(sourcePage, 'Review invitation'); await activate(sourcePage, 'Make sending offer');
  const offerBox = sourcePage.getByRole('textbox', { name: 'Sending offer', exact: true }); await offerBox.waitFor();
  const offer = await offerBox.inputValue(); rememberPrivateCode(offer);
  await receiverPage.getByRole('textbox', { name: 'Offer from sending page', exact: true }).fill(offer);
  await activate(receiverPage, 'Use sending offer');
  const answerBox = receiverPage.getByRole('textbox', { name: 'Receiving answer', exact: true }); await answerBox.waitFor();
  const answer = await answerBox.inputValue(); rememberPrivateCode(answer);
  await sourcePage.getByRole('textbox', { name: 'Answer from receiving page', exact: true }).fill(answer);
  await activate(sourcePage, 'Use receiving answer');
  const comparison = page => page.getByLabel('Complete comparison code', { exact: true });
  await comparison(receiverPage).waitFor(); await comparison(sourcePage).waitFor();
  const receiverText = await comparison(receiverPage).textContent(), sourceText = await comparison(sourcePage).textContent();
  rememberPrivateCode(receiverText); rememberPrivateCode(sourceText);
  const receiverDigest = receiverText.replace(/\s/g, ''), sourceDigest = sourceText.replace(/\s/g, '');
  rememberPrivateCode(receiverDigest); rememberPrivateCode(sourceDigest);
  assert.ok(/^[0-9a-f]{64}$/.test(receiverDigest) && receiverDigest === sourceDigest, 'complete actual product endpoint comparison');
  await activate(sourcePage, 'The complete codes match'); await activate(receiverPage, 'The complete codes match');
  await receiverPage.getByRole('combobox', { name: 'Reading resource', exact: true }).waitFor();
}
async function productJourney(engine, type) {
  activeEngine = engine; activeBrowserVersion = undefined;
  browser = await type.launch({ headless: true }); browsersOpened++;
  const browserVersion = browser.version(); assert.ok(typeof browserVersion === 'string' && browserVersion.length <= 128, 'actual owned browser version bound');
  activeBrowserVersion = browserVersion;
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', colorScheme: 'dark' }); contextsOpened++;
  context.on('page', page => page.on('pageerror', error => {
    report.pageErrors++;
    if (report.pageErrorDetails.length < 8) report.pageErrorDetails.push({ ...failureDetails(error), pagePath: new URL(page.url()).pathname });
  }));
  await context.route('**/*', route => new URL(route.request().url()).origin === origin.origin ? route.continue() : (report.foreignRequests++, route.abort()));
  await context.exposeBinding('__ownedReadingRetired', (_, detail) => {
    assert.ok(detail && detail.rawPending === 0 && detail.owned && detail.owned.registrations === 0 && detail.owned.routes === 0 &&
      detail.owned.producerTimers === 0 && detail.owned.expiryTimers === 0 && detail.cleanupUnconfirmed === false, 'owned product retirement settled');
    assert.ok(report.retirements.length < 16, 'bounded retirement receipt');
    report.retirements.push({ engine, rawPending: 0, registrations: 0, routes: 0, producerTimers: 0, expiryTimers: 0, cleanupUnconfirmed: false });
  });
  await context.addInitScript(() => {
    const NativePeer = globalThis.RTCPeerConnection;
    globalThis.__readingNative = { created: 0, closed: 0 };
    if (typeof NativePeer === 'function') globalThis.RTCPeerConnection = new Proxy(NativePeer, {
      construct(target, values) {
        const peer = Reflect.construct(target, values); globalThis.__readingNative.created++;
        const nativeClose = peer.close.bind(peer); let closed = false;
        peer.close = () => { const result = nativeClose(); if (!closed) { closed = true; globalThis.__readingNative.closed++; } return result; };
        return peer;
      },
    });
    window.addEventListener('101-readings-retired', event => {
      void globalThis.__ownedReadingRetired({ rawPending: event.detail.rawPending,
        owned: event.detail.owned, cleanupUnconfirmed: event.detail.cleanupUnconfirmed });
    });
  });
  const page = await context.newPage(); ownedPages.push(page); await page.goto(new URL('/connections', origin).href);
  await page.getByRole('button', { name: 'Create invitation', exact: true }).waitFor();
  await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some(button => button.textContent.trim() === 'Create invitation' && !button.disabled));
  assert.ok(await page.getByRole('link', { name: 'Connect page controls', exact: true }).count() === 1, 'existing player task entry prefix');
  if (featureRed) {
    report.phase = 'old-hydrated-player-feature-absence';
    report.oldHydratedPrefix = true;
    report.oldStructuredEntryCount = await page.getByRole('link', { name: 'View shared readings', exact: true }).count();
    assert.ok(report.oldStructuredEntryCount === 1, 'hydrated player lacks structured reading task');
    return;
  }
  report.phase = `${engine}-record`;
  await page.getByRole('link', { name: 'View shared readings', exact: true }).click();
  await page.getByRole('heading', { name: 'View shared readings', exact: true }).waitFor();
  const source = await context.newPage(); ownedPages.push(source); await source.goto(new URL('/connections/readings', origin).href);
  await exchange(page, source);
  await source.getByRole('combobox', { name: 'Sending resource', exact: true }).selectOption({ label: 'One reading' });
  await page.getByRole('combobox', { name: 'Reading resource', exact: true }).selectOption({ label: 'One reading' });
  await source.getByRole('spinbutton', { name: 'Step', exact: true }).fill('42');
  await source.getByRole('checkbox', { name: 'Ready', exact: true }).check();
  await source.getByRole('combobox', { name: 'Mode', exact: true }).selectOption('count-up');
  await activate(source, 'Review reading'); await activate(page, 'Review reading');
  const table = page.getByRole('table', { name: 'Shared readings', exact: true });
  assert.ok(await table.locator('tbody tr').count() === 0, 'unapproved arrival has no table effects');
  await activate(source, 'Allow sending for 30 seconds');
  assert.ok(await table.locator('tbody tr').count() === 0, 'source permission alone has no display effects');
  await activate(page, 'Allow this display for 30 seconds'); await table.locator('tbody tr').first().waitFor();
  const cells = await table.locator('tbody tr').first().locator('td').allTextContents();
  assert.ok(cells.length === 3 && cells[0] === '42' && cells[1] === 'On' && cells[2] === 'count-up', 'actual native form record reaches typed product display');
  for (const width of [320, 390, 1280]) { await page.setViewportSize({ width, height: 844 }); await fits(page); }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' }); await fits(page);
  const stop = page.getByRole('button', { name: 'Stop sharing readings', exact: true }); await stop.focus();
  const focus = await stop.evaluate(element => { const style = getComputedStyle(element); return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2; });
  assert.ok(focus, 'visible keyboard Stop focus'); await page.keyboard.press('Space');
  assert.ok(await table.locator('tbody tr').count() === 0, 'Stop clears actual displayed values');
  await activate(source, 'Stop sharing readings');
  report.checks.push({ engine, record: true, independentConsent: true, stopCleared: true, responsive: true, visibleFocus: true, reducedMotion: true });
  const beforeRecordRetirement = report.retirements.length;
  await Promise.all([page.getByRole('main').getByRole('link', { name: 'Connections', exact: true }).click(), source.getByRole('main').getByRole('link', { name: 'Connections', exact: true }).click()]);
  await page.waitForFunction(() => !document.querySelector('[aria-label="Shared readings"]'));
  await retirementCount(beforeRecordRetirement + 2);
  await Promise.all([page.getByRole('link', { name: 'View shared readings', exact: true }).click(), source.getByRole('link', { name: 'View shared readings', exact: true }).click()]);
  await exchange(page, source);
  report.phase = `${engine}-array`;
  await source.getByRole('combobox', { name: 'Sending resource', exact: true }).selectOption({ label: 'Reading table' });
  await page.getByRole('combobox', { name: 'Reading resource', exact: true }).selectOption({ label: 'Reading table' });
  await source.getByRole('spinbutton', { name: 'Row 1 step', exact: true }).fill('7');
  await source.getByRole('combobox', { name: 'Row 1 mode', exact: true }).selectOption('count-down');
  await activate(source, 'Add row'); await source.getByRole('spinbutton', { name: 'Row 2 step', exact: true }).fill('42');
  await source.getByRole('checkbox', { name: 'Include row 2 readiness', exact: true }).uncheck();
  await activate(source, 'Review reading'); await activate(page, 'Review reading');
  await activate(source, 'Allow sending for 30 seconds'); await activate(page, 'Allow this display for 30 seconds');
  await table.locator('tbody tr').nth(1).waitFor();
  const first = await table.locator('tbody tr').first().locator('td').allTextContents(), second = await table.locator('tbody tr').nth(1).locator('td').allTextContents();
  assert.ok(first[0] === '7' && first[2] === 'count-down' && second[0] === '42' && second[1] === 'Not supplied', 'actual native array and optional absence display');
  report.phase = `${engine}-original-expiry`;
  await table.locator('tbody tr').first().waitFor({ state: 'detached', timeout: 33000 });
  assert.ok(await table.locator('tbody tr').count() === 0, 'original permission expiry clears unchanged current form data');
  report.checks.push({ engine, array: true, optionalAbsence: true, originalExpiry: true });
  report.phase = `${engine}-navigation-settlement`;
  const beforeArrayRetirement = report.retirements.length;
  await Promise.all([page.getByRole('main').getByRole('link', { name: 'Connections', exact: true }).click(), source.getByRole('main').getByRole('link', { name: 'Connections', exact: true }).click()]);
  await page.getByRole('button', { name: 'Create invitation', exact: true }).waitFor();
  await retirementCount(beforeArrayRetirement + 2);
  const native = await Promise.all([page.evaluate(() => globalThis.__readingNative), source.evaluate(() => globalThis.__readingNative)]);
  assert.ok(native.every(value => value.created === 2 && value.closed === 2), 'actual native RTC owners created and closed for both fresh tasks');
  report.engines.push({ engine, browserVersion, nativeProductPages: 2, nativeRTCCreated: 4, nativeRTCClosed: 4 });
}

try {
  const servedPaths = featureRed ? ['app/connections/page.tsx', 'app/connections/ConnectionsView.tsx'] : [
    'app/connections/ConnectionsView.tsx', 'app/connections/readings/page.tsx', 'app/connections/readings/ReadingsView.tsx',
    'app/connections/readings/readings-task.ts', 'app/connections/readings/readings-schema.ts', 'app/connections/resources/resource-task.module.css',
    'app/connections/connections.module.css', 'app/sharing/sharing.module.css'];
  for (const path of servedPaths) assert.ok(served.sourcePins[path] === hash(readFileSync(resolve(root, path))), 'actual server serves the inspected player source bytes');
  for (const [path, expected] of Object.entries(served.sourcePins)) assert.ok(hash(readFileSync(resolve(root, path))) === expected, 'current served dependency source pin');
  for (const artifact of served.buildInputs) assert.ok(['server', 'client'].includes(artifact.kind) && hash(readFileSync(resolve(root, artifact.path))) === artifact.sha256, 'actual served build input');
  assert.ok(hash(readFileSync(resolve(root, served.buildRecord.path))) === served.buildRecord.sha256, 'actual served build record');
  report.sdkEntrySHA = hash(readFileSync(sdkEntry));
  if (featureRed) {
    report.phase = 'genuine-public-structured-prefix';
    const sdk = await import(pathToFileURL(sdkEntry).href); report.publicPrefix = await publicStructuredPrefix(sdk);
  }
  const require = createRequire(resolve(root, 'package.json')), { chromium, webkit } = require('playwright');
  const engines = selectedEngine === 'chromium' ? { chromium } : selectedEngine === 'webkit' ? { webkit } : featureRed ? { chromium } : { chromium, webkit };
  for (const [engine, type] of Object.entries(engines)) {
    try { await productJourney(engine, type); }
    catch (error) { report.failure ??= failureDetails(error); throw error; }
    finally { await closeBrowserOwner(); }
  }
  assert.ok(report.pageErrors === 0 && report.foreignRequests === 0, 'no product errors or foreign requests'); report.status = 'pass'; report.phase = 'settled';
} catch (error) {
  report.failure ??= failureDetails(error); report.status = 'fail'; process.exitCode = 1;
} finally {
  await closeBrowserOwner();
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  diagnosticRedactions.clear();
  process.stdout.write(`${JSON.stringify({ receipt: output, status: report.status, phase: report.phase, sha256: hash(readFileSync(output)) })}\n`);
}
