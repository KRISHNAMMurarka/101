import { verifyConnectSdkProof } from './connect-sdk-provenance.mjs';
import { build } from 'vite';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';

// Source-bound, owned loopback UI proof. The host below is the real SessionHost with real
// parsed game roles and native BroadcastChannel; it does not qualify an authenticated peer,
// a resource grant, physical motion, phone capture or an installed application bundle.
const arguments_ = process.argv.slice(2);
const application = new URL(arguments_.shift());
let proofPath, engineSelection = 'both', engineSeen = false, oldRenderRed = false;
while (arguments_.length) {
  const name = arguments_.shift();
  if (name === '--served-proof' && !proofPath) proofPath = arguments_.shift();
  else if (name === '--engine' && !engineSeen) { engineSelection = arguments_.shift(); engineSeen = true; }
  else if (name === '--old-render-red' && !oldRenderRed) oldRenderRed = true;
  else throw Error(`Unknown or duplicate argument: ${name}`);
}
assert.ok(proofPath && ['both', 'chromium', 'webkit'].includes(engineSelection));
assert.ok(application.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(application.hostname)
  && application.pathname === '/' && !application.search && !application.hash, 'Use only the owned fixed loopback origin');
const proofBytes = readFileSync(proofPath), proof = JSON.parse(proofBytes);
assert.equal(proof.origin, application.origin);
assert.match(proof.sourceTree, /^[a-f0-9]{40}$/);
const sourceRoot = realpathSync(proof.sourceRoot), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const required = ['app/controller/Controller.tsx', 'app/controller/page.tsx', 'app/controller/controller-route.ts',
  'app/controller/controller-surface-state.ts', 'app/controller/controller-copy.ts', 'app/globals.css',
  'packages/game-host/src/game-session.ts', 'packages/game-host/src/game-protocol.ts', 'packages/game-host/src/game-application-channel.ts', 'packages/input/src/index.ts',
  'games/spellcaster/src/roles.ts', 'games/echomaze/src/roles.ts'];
for (const path of required) {
  assert.match(proof.sourcePins?.[path] ?? '', /^[a-f0-9]{64}$/);
  assert.equal(hash(readFileSync(resolve(sourceRoot, path))), proof.sourcePins[path], `Current declared served source: ${path}`);
  assert.equal(hash(execFileSync('git', ['cat-file', 'blob', `${proof.sourceTree}:${path}`], { cwd: sourceRoot, maxBuffer: 2 * 1024 * 1024 })), proof.sourcePins[path], `Immutable declared served source: ${path}`);
}
verifyConnectSdkProof(proof, sourceRoot);
const fixtureId = 'controller-chrome-fixture';
const fixtureSource = [
  `export { createBrowserApplicationChannel } from '@uynis-connect/connect';`,
  `export { SessionHost } from ${JSON.stringify(resolve(sourceRoot, 'packages/game-host/src/game-session.ts'))};`,
  `export { createGameApplicationLink } from ${JSON.stringify(resolve(sourceRoot, 'packages/game-host/src/game-application-channel.ts'))};`,
  `export { parseControlMessage } from ${JSON.stringify(resolve(sourceRoot, 'packages/game-host/src/game-protocol.ts'))};`,
  `export { SPELLCASTER_ROLES } from ${JSON.stringify(resolve(sourceRoot, 'games/spellcaster/src/roles.ts'))};`,
].join('\n');
const built = await build({ configFile: false, root: sourceRoot, logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{ name: 'owned-controller-fixture', resolveId: id => id === fixtureId ? id : undefined, load: id => id === fixtureId ? fixtureSource : undefined }],
  build: { write: false, minify: false, lib: { entry: fixtureId, name: 'ControllerFixture', formats: ['iife'] } } });
const fixtureBundle = (Array.isArray(built) ? built[0] : built).output.find(part => part.type === 'chunk').code;
const ownQaHash = hash(readFileSync(new URL(import.meta.url))), results = [];
let browser, context;
try {
  const engines = engineSelection === 'both' ? { chromium, webkit } : { [engineSelection]: engineSelection === 'chromium' ? chromium : webkit };
  for (const [engine, browserType] of Object.entries(engines)) {
    browser = await browserType.launch({ headless: true });
    const version = browser.version();
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    const errors = [], foreign = [], room = `CHROME-${engine.toUpperCase()}-${Date.now()}`;
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    await context.route('**/*', route => new URL(route.request().url()).origin === application.origin
      ? route.continue() : (foreign.push(route.request().url()), route.abort()));
    const hostPage = await context.newPage(), page = await context.newPage();
    const fixtureUrl = new URL('/__101_owned_controller_chrome_host__', application).toString();
    await hostPage.route(fixtureUrl, route => route.fulfill({ status: 200, contentType: 'text/html',
      body: '<!doctype html><html lang="en"><meta charset="utf-8"><title>Owned SessionHost fixture</title><body></body></html>' }));
    await hostPage.goto(fixtureUrl);
    await hostPage.addScriptTag({ content: fixtureBundle });
    await hostPage.evaluate(async room => {
      const { SessionHost, createBrowserApplicationChannel, createGameApplicationLink, parseControlMessage, SPELLCASTER_ROLES } = window.ControllerFixture;
      const channel = createBrowserApplicationChannel({ sessionId: room, applicationId: 'connect.controls.v1' });
      const port = createGameApplicationLink(channel), configurations = [], frames = [];
      const nativeSend = port.sendReliable.bind(port);
      port.sendReliable = message => {
        const parsed = parseControlMessage(message);
        if (parsed.type === 'controller.configure' && configurations.length < 32) configurations.push(parsed);
        nativeSend(message);
      };
      const host = new SessionHost({ gameId: 'spellcaster', roles: SPELLCASTER_ROLES, transport: port,
        onFrame: frame => { if (frames.length < 64) frames.push(frame); }, deviceTimeoutMs: 60000 });
      globalThis.__ownedChromeHost = { host, port, configurations, frames, stopped: false };
      await host.start();
    }, room);
    const cleanup = { hostStopAwaited: false, controllerPageClosed: false, hostPageClosed: false,
      contextCloseAwaited: false, browserClosed: false };
    try {
      await page.goto(new URL(`/controller?session=${encodeURIComponent(room)}`, application).toString());
      // Play deliberately hides setup details. Configuration is established by attached content,
      // then the actual native Setup control exposes the details without changing CSS or sensors.
      const heading = page.locator('.dynamic-controller-heading h1').filter({ hasText: 'Arcane Focus' });
      await heading.waitFor({ state: 'attached', timeout: 6000 });
      const primaryTitle = page.locator('.controller-top .mark-label');
      assert.ok(await primaryTitle.isVisible(), 'The primary title is a visible player surface');
      const setup = page.getByRole('button', { name: 'Setup', exact: true });
      await setup.click();
      await heading.waitFor({ state: 'visible', timeout: 6000 });
      const actualProducer = await hostPage.evaluate(() => {
        const state = globalThis.__ownedChromeHost, message = state.configurations.at(-1);
        return { configurationCount: state.configurations.length, gameId: message?.gameId, role: message?.role,
          title: message?.layout.title, movementLabel: message?.layout.motion?.label, movementAction: message?.layout.motion?.action,
          deviceCount: state.host.session.devices.size };
      });
      assert.deepEqual([actualProducer.gameId, actualProducer.role, actualProducer.title, actualProducer.movementLabel, actualProducer.movementAction],
        ['spellcaster', 'sorcerer', 'Arcane Focus', 'Aim + physical casting', 'spell.aim']);
      assert.equal(actualProducer.deviceCount, 1);
      const primaryStatus = page.locator('.controller-top .controller-status'), readout = page.locator('.controller-role-status strong');
      assert.ok(await primaryStatus.isVisible()); assert.ok(await readout.isVisible());
      const observed = { primaryTitle: (await primaryTitle.textContent())?.trim(),
        primaryStatus: (await primaryStatus.textContent())?.trim(),
        room: await page.locator('.controller-session strong').innerText(),
        sessionHint: (await page.locator('.controller-session small').textContent())?.trim(),
        sessionHintObservation: 'DOM text only; deliberately hidden at this 390px viewport',
        readout: (await readout.textContent())?.trim(),
        motion: await page.locator('.motion-permission p').innerText() };
      // Freeze actual old DOM and producer values before the correctness assertion throws.
      process.stderr.write(`${JSON.stringify({ phase: 'actual-role-render', engine, version, oldRenderRed, actualProducer, observed, errors, foreign })}\n`);
      assert.equal(observed.room, room, 'Useful room identity remains visible');
      assert.equal(observed.primaryTitle, 'Arcane Focus', 'Primary controller chrome must use the actual declared task title, not internal sorcerer role ID');
      assert.equal(observed.primaryStatus, 'Connected');
      assert.equal(observed.sessionHint, 'Controls are ready');
      assert.equal(observed.readout, 'Arcane Focus controls are ready.');
      assert.equal(observed.motion, 'Aim + physical casting is optional. Touch controls remain available.');
      assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
      results.push({ engine, version, actualProducer, observed, checks: 8, cleanup, physicalMotion: 'unqualified' });
    } finally {
      const cleanupErrors = [];
      try {
        await hostPage.evaluate(async () => {
          const state = globalThis.__ownedChromeHost;
          if (!state) throw Error('Owned SessionHost fixture was not installed');
          await state.host.stop(); state.stopped = true;
        });
        cleanup.hostStopAwaited = await hostPage.evaluate(() => globalThis.__ownedChromeHost.stopped);
      } catch (error) { cleanupErrors.push(String(error)); }
      try { await page.close(); cleanup.controllerPageClosed = page.isClosed(); } catch (error) { cleanupErrors.push(String(error)); }
      try { await hostPage.close(); cleanup.hostPageClosed = hostPage.isClosed(); } catch (error) { cleanupErrors.push(String(error)); }
      try { await context.close(); cleanup.contextCloseAwaited = true; context = undefined; } catch (error) { cleanupErrors.push(String(error)); }
      try { await browser.close(); cleanup.browserClosed = !browser.isConnected(); browser = undefined; } catch (error) { cleanupErrors.push(String(error)); }
      process.stderr.write(`${JSON.stringify({ phase: 'actual-owned-cleanup', engine, version, cleanup, cleanupErrors,
        hostDeviceCountAfterStop: 'not measured; stop does not erase historical session membership', browserInternalResources: 'not measured' })}\n`);
      assert.deepEqual(cleanupErrors, [], 'Every owned cleanup operation must settle successfully');
      assert.ok(Object.values(cleanup).every(Boolean), 'Owned host stop and page/context/browser closures were awaited');
    }
  }
  process.stdout.write(`${JSON.stringify({ status: 'pass', profile: 'controller-player-chrome/1', sourceTree: proof.sourceTree,
    servedProof: { path: resolve(proofPath), sha256: hash(proofBytes) }, sourcePins: proof.sourcePins, sdkPackagePins: proof.sdkPackagePins, fixtureSha256: hash(fixtureBundle), qaSha256: ownQaHash,
    producer: 'real SessionHost and parsed real game roles over owned native same-origin BroadcastChannel',
    sourceOnly: true, results, cleanup: { browserContexts: 0, browserProcesses: 0, ownedHostPorts: 0 },
    unqualified: ['phone', 'physical motion', 'native permission enforcement', 'authenticated endpoint', 'resource authority', 'whole U05'] })}\n`);
} finally { await context?.close(); await browser?.close(); }
