import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { build } from 'vite';
import { startProdServer } from '../node_modules/vinext/dist/server/prod-server.js';

const root = resolve(import.meta.dirname, '..');
const expectedBuild = process.argv[2];
assert.match(expectedBuild ?? '', /^[a-f0-9]{64}$/, 'Pass the freshly built server SHA256');
const sha = value => createHash('sha256').update(value).digest('hex');
const output = resolve(root, `outputs/migration/2026-10-20/journeys-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`);
mkdirSync(output, { recursive: false });
const walk = path => readdirSync(resolve(root, path), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(`${path}/${entry.name}`) : [`${path}/${entry.name}`]);
const pins = paths => Object.fromEntries(paths.map(path => [path, sha(readFileSync(resolve(root, path)))]));
const buildPins = pins(walk('dist').filter(path => !path.endsWith('.map')));
assert.equal(buildPins['dist/server/index.js'], expectedBuild);
const sourcePins = pins(['tools/qa-platform-cutover.mjs', 'app/lib/browser-link.ts', 'app/lib/use-game-host.ts', 'app/lib/session-id.ts', 'app/components/EchoMazeGame.tsx',
  ...walk('app/games').filter(path => path.endsWith('Standalone.tsx')),
  ...walk('packages/game-host/src'), ...walk('packages/input/src'), ...walk('games/echomaze').filter(path => /\.(ts|json)$/.test(path))]);
const sdkEntry = import.meta.resolve('@uynis-connect/connect');
const report = { startedAt: new Date().toISOString(), expectedBuild, sdkEntry, sdkEntrySha256: sha(readFileSync(new URL(sdkEntry))), buildPins, sourcePins,
  scope: 'Chromium real rendered Echo Maze. Native keyboard, software-emulated standard Gamepad API, and public SDK same-origin application-channel controller. No game-state injection, clock override, raw transport construction, physical device or authenticated LAN qualification.',
  checks: [], errors: [], cleanup: {}, status: 'running' };
const save = () => writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const entry = resolve(output, 'public-sdk-producer.js');
writeFileSync(entry, "export { createControllerApplicationChannel, encodeControlApplicationMessage, parseControlApplicationMessage } from '@uynis-connect/connect';\n");
save();
let server, browser, context, page, producer;
const check = (name, observation) => { report.checks.push({ name, observation, passed: true }); save(); console.error(name); };
const waitText = async (selector, expected) => page.waitForFunction(({ selector, expected }) => document.querySelector(selector)?.textContent?.includes(expected), { selector, expected }, { timeout: 5000 });
const pulse = async key => { await page.keyboard.down(key); await page.waitForTimeout(120); await page.keyboard.up(key); };
const snapshot = async () => ({ text: await page.locator('body').innerText(), url: page.url(), flashlight: await page.locator('.echo-vitals p').innerText() });
const stop = () => { report.interrupted = true; void browser?.close(); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  const bundled = await build({ configFile: false, root, logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' },
    build: { write: false, minify: false, lib: { entry, name: 'CutoverSDK', formats: ['iife'] } } });
  const bundle = (Array.isArray(bundled) ? bundled[0] : bundled).output.find(part => part.type === 'chunk').code;
  report.producerSha256 = sha(bundle);
  writeFileSync(resolve(output, 'public-sdk-producer.bundle.js'), bundle);
  server = await startProdServer({ port: 0, host: '127.0.0.1', outDir: resolve(root, 'dist'), silent: true });
  const origin = `http://127.0.0.1:${server.port}`; report.origin = origin;
  browser = await chromium.launch({ headless: true }); report.browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark', reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.addInitScript(() => {
    window.qaWire = [];
    const BrowserChannel = window.BroadcastChannel;
    window.BroadcastChannel = class extends BrowserChannel {
      constructor(name) {
        super(name); window.qaWire.push({ event: 'opened', name });
        this.addEventListener('message', event => window.qaWire.push({ event: 'received', name, data: event.data }));
      }
      postMessage(data) { window.qaWire.push({ event: 'sent', name: this.name, data }); return super.postMessage(data); }
    };
  });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/__qa-controller') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Public SDK controller fixture</title><p>Public SDK controller fixture</p>' });
    return route.continue();
  });
  page = await context.newPage(); page.setDefaultTimeout(6000);
  page.on('pageerror', error => report.errors.push({ message: error.message, stack: error.stack }));
  // This only supplies a software device through the standard browser producer boundary.
  // The SDK must discover, poll, retire and map it through the normal game consumer path.
  await page.addInitScript(() => {
    const pad = { id: 'Software QA standard gamepad', index: 0, connected: false, mapping: 'standard', axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })), timestamp: 0 };
    window.qaGamepad = pad;
    Object.defineProperty(navigator, 'getGamepads', { value: () => { pad.timestamp = performance.now(); return pad.connected ? [pad] : []; } });
  });
  await page.goto(origin + '/games/echomaze');
  await page.locator('.pre-game-option').first().locator('a').focus(); await page.keyboard.press('Enter');
  await page.waitForURL(url => url.pathname === '/games/echomaze/play');
  const field = page.locator('canvas[tabindex="0"]').first(); await field.waitFor();
  await page.waitForFunction(() => document.activeElement?.matches('canvas[tabindex="0"]'));
  await waitText('.echo-vitals p', 'FLASHLIGHT OPEN');
  check('Keyboard chooser launches focused actual game', await snapshot());
  await pulse('KeyF'); await waitText('.echo-vitals p', 'FLASHLIGHT CLOSED');
  check('Native keyboard KeyF changes actual flashlight state', await snapshot());
  await page.evaluate(() => { window.qaGamepad.connected = true; window.dispatchEvent(new Event('gamepadconnected')); });
  await page.waitForTimeout(180);
  await page.evaluate(() => { window.qaGamepad.buttons[3] = { pressed: true, touched: true, value: 1 }; });
  await waitText('.echo-vitals p', 'FLASHLIGHT OPEN');
  await page.evaluate(() => { window.qaGamepad.buttons[3] = { pressed: false, touched: false, value: 0 }; });
  check('Software Gamepad API Y changes actual flashlight state through SDK local input', await snapshot());
  await page.evaluate(() => { window.qaGamepad.connected = false; window.dispatchEvent(new Event('gamepaddisconnected')); });
  await page.waitForTimeout(180);
  const sessionId = await page.evaluate(() => localStorage.getItem('101.session')); assert.ok(sessionId);
  producer = await context.newPage(); producer.setDefaultTimeout(6000);
  producer.on('pageerror', error => { report.errors.push({ surface: 'SDK producer', message: error.message, stack: error.stack }); console.error('SDK producer:', error.message); });
  await producer.goto(origin + '/__qa-controller'); await producer.addScriptTag({ content: bundle });
  await producer.evaluate(async sessionId => {
    window.qaMessages = [];
    window.qaOpen = async applicationId => {
      window.qaChannel = await window.CutoverSDK.createControllerApplicationChannel({ sessionId, applicationId, device: { deviceId: 'qa-phone', label: 'QA controller', capabilities: { touch: true } } });
      window.qaChannel.subscribe(event => { window.qaMessages.push(window.CutoverSDK.parseControlApplicationMessage(event.payload)); });
      await window.qaChannel.connect();
    };
    window.qaHello = () => window.qaChannel.send(window.CutoverSDK.encodeControlApplicationMessage({ type: 'controls.hello', deviceId: 'qa-phone', label: 'QA controller', capabilities: { touch: true }, speakerAudio: 'locked' }), { delivery: 'reliable' });
    await window.qaOpen('unrelated.application'); window.qaHello();
  }, sessionId);
  await page.waitForTimeout(250);
  assert.equal(await producer.evaluate(() => window.qaMessages.length), 0);
  await waitText('.echo-statusbar b', 'Clue shown here');
  check('Wrong application scope cannot bind to the game', await snapshot());
  await producer.evaluate(async () => { await window.qaChannel.close(); await window.qaOpen('connect.controls.v1'); window.qaHello(); });
  await producer.waitForFunction(() => window.qaMessages.some(message => message.type === 'controls.configure'));
  const initial = await producer.evaluate(() => window.qaMessages.find(message => message.type === 'controls.configure'));
  assert.equal(initial.applicationId, '101.game-controller'); assert.equal(JSON.stringify(initial).includes('role-scanner'), false);
  await waitText('.echo-statusbar b', 'Clue sent to your phone');
  check('Public SDK controller receives opaque binding and actual scanner layout', initial);
  await producer.evaluate(() => {
    window.qaSequence = 0;
    window.qaInput = (bindingId, actions, extra = {}) => window.qaChannel.send(JSON.stringify({ type: 'input.snapshot', bindingId, source: 'touch', sequence: ++window.qaSequence, timestamp: Date.now(), actions, ...extra }), { delivery: 'disposable' });
    window.qaBinding = window.qaMessages.find(message => message.type === 'controls.configure').bindingId;
    window.qaInput('unassigned-binding', { 'maze.flashlight': true });
    window.qaInput(window.qaBinding, { 'maze.flashlight': true }, { playerId: 'role-scanner', deviceId: 'forged' });
  });
  await page.waitForTimeout(250); await waitText('.echo-vitals p', 'FLASHLIGHT OPEN');
  check('Unassigned binding and forged player/device payload cannot change game state', await snapshot());
  await producer.evaluate(() => window.qaInput(window.qaBinding, { 'maze.flashlight': true }));
  await waitText('.echo-vitals p', 'FLASHLIGHT CLOSED');
  check('Assigned remote action changes actual game flashlight', await snapshot());
  await producer.evaluate(async () => { window.qaOldBinding = window.qaBinding; await window.qaChannel.close(); });
  await waitText('.echo-statusbar b', 'Clue shown here');
  check('Controller close retires actual game membership while action is held', await snapshot());
  await producer.evaluate(async () => { window.qaMessages = []; await window.qaOpen('connect.controls.v1'); window.qaHello(); });
  await producer.waitForFunction(() => window.qaMessages.some(message => message.type === 'controls.configure'));
  const recovered = await producer.evaluate(() => { window.qaBinding = window.qaMessages.find(message => message.type === 'controls.configure').bindingId; return window.qaBinding; });
  assert.notEqual(recovered, initial.bindingId);
  await producer.evaluate(() => window.qaInput(window.qaOldBinding, { 'maze.flashlight': true }));
  await page.waitForTimeout(250); await waitText('.echo-vitals p', 'FLASHLIGHT CLOSED');
  await producer.evaluate(() => window.qaInput(window.qaBinding, { 'maze.flashlight': true }));
  await waitText('.echo-vitals p', 'FLASHLIGHT OPEN');
  check('Fresh binding rejects retired input and recovers after held-input loss', await snapshot());
  await producer.evaluate(async () => window.qaChannel.close()); await producer.close();
  await waitText('.echo-statusbar b', 'Clue shown here');
  await field.focus(); await pulse('KeyM'); await waitText('.echo-event [role="status"]', '1 place marked');
  check('Local keyboard remains usable after remote retirement', await snapshot());
  await page.screenshot({ path: resolve(output, 'final-game.png') });
  assert.deepEqual(report.errors, []); report.status = 'pass';
} catch (error) {
  report.status = 'fail'; report.failure = { message: error.message, stack: error.stack };
  try { report.failure.snapshot = await snapshot(); report.failure.messages = await producer?.evaluate(() => window.qaMessages); report.failure.hostWire = await page.evaluate(() => window.qaWire); report.failure.producerWire = await producer?.evaluate(() => window.qaWire); await page.screenshot({ path: resolve(output, 'failure.png') }); } catch { /* Context can already be closed after interruption. */ }
} finally {
  if (context) { await context.close(); report.cleanup.contextClosed = true; }
  if (browser) { await browser.close(); report.cleanup.browserClosed = true; }
  if (server) { server.server.closeAllConnections(); await new Promise((done, reject) => server.server.close(error => error ? reject(error) : done())); report.cleanup.serverClosed = true; }
  report.buildPinsUnchanged = Object.entries(buildPins).every(([path, pin]) => sha(readFileSync(resolve(root, path))) === pin);
  report.sourcePinsUnchanged = Object.entries(sourcePins).every(([path, pin]) => sha(readFileSync(resolve(root, path))) === pin);
  report.finishedAt = new Date().toISOString();
  report.pass = report.status === 'pass' && report.buildPinsUnchanged && report.sourcePinsUnchanged && !report.interrupted;
  save(); console.error(JSON.stringify({ output, pass: report.pass, checks: report.checks.length, failure: report.failure?.message }));
}
if (!report.pass) process.exitCode = 1;
