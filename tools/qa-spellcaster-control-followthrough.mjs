import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startProdServer } from '../node_modules/vinext/dist/server/prod-server.js';
import { SPELLCASTER_ROLES } from '../games/spellcaster/src/roles.ts';

// Actual built game, native keyboard controls and actual consumer HUD effects. No
// input/state/clock/render hooks. The copied producer build is removed after joining.
const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'outputs/controllers/2026-10-18-spellcaster-control-followthrough');
const expected = process.argv[2];
assert.equal(process.argv.length, 3);
assert.match(expected ?? '', /^[a-f0-9]{64}$/);
assert.equal(process.version, 'v24.14.0');
assert.equal(process.env.NODE_OPTIONS, undefined);
assert.equal(process.env.NODE_PATH, undefined);
mkdirSync(output, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const candidate = JSON.parse(readFileSync(resolve(root, 'outputs/controllers/2026-10-18-combined-gates/candidate.json')));
const sourcePins = Object.fromEntries(Object.entries(candidate.filePins).filter(([path]) =>
  path.startsWith('games/spellcaster/') || path.startsWith('packages/') && !path.endsWith('.test.ts')
  || path.startsWith('app/components/') || path.startsWith('app/lib/') || path.startsWith('app/controller/')
  || ['package.json', 'package-lock.json', 'vite.config.ts', 'app/globals.css'].includes(path)));
for (const [path, pin] of Object.entries(sourcePins)) assert.equal(hash(readFileSync(resolve(root, path))), pin, `Reused build source fence: ${path}`);
assert.equal(hash(readFileSync(resolve(root, 'dist/server/index.js'))), expected);
const files = directory => readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
  assert.ok(!entry.isSymbolicLink());
  return entry.isDirectory() ? files(resolve(directory, entry.name)) : [resolve(directory, entry.name)];
});
const build = resolve(output, 'owned-build');
assert.ok(!readdirSync(output).includes('owned-build'), 'Do not overwrite an unfinished run');
cpSync(resolve(root, 'dist'), build, { recursive: true });
const buildPins = Object.fromEntries(files(build).map(path => [path.slice(build.length + 1), hash(readFileSync(path))]));
const manifest = JSON.parse(readFileSync(resolve(root, 'games/spellcaster/input.manifest.json')));
const actions = [['charge', 'KeyC'], ['projectile', 'Space'], ['shield', 'KeyQ'], ['grab', 'KeyE'], ['blade', 'KeyX'], ['vortex', 'KeyR']];
assert.deepEqual(actions.map(([spell]) => `spell.cast.${spell}`).sort(), Object.keys(manifest.actions).sort());
assert.deepEqual(Object.keys(manifest.vectors), ['spell.aim']);
const role = SPELLCASTER_ROLES.find(item => item.id === 'sorcerer');
assert.ok(role);
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), sourceCandidateTree: candidate.tree,
  producerBuild: { classification: 'Reused existing local build; not a fresh build', serverSha256: expected, sourcePins, buildPins },
  harnessSha256: hash(readFileSync(new URL(import.meta.url))), results: [],
  scope: 'Horizontal Spell aim selects different targets in the actual game, natural result/Space restart, then six declared action consumer effects in the fresh run. Desktop keyboard and native keyboard activation of local role buttons only. This selector does not qualify local role aim or the vertical reticle. No physical or remote qualification.',
  reusedInitialSixActionReceipt: { path: 'docs/platform/receipts/2026-10-16-spell-actions.json', sha256: hash(readFileSync(resolve(root, 'docs/platform/receipts/2026-10-16-spell-actions.json'))) },
  boundsMs: { naturalEnd: 150000, wholeRun: 360000 }, cleanup: { errors: [] } };
const save = () => writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const frames = page => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
const pulse = async (page, key) => { await page.keyboard.down(key); await page.waitForTimeout(100); await page.keyboard.up(key); await frames(page); };
const event = page => page.locator('.spell-event').innerText();
const waitCast = (page, spell) => page.waitForFunction(word => document.querySelector('.spell-event small')?.textContent === `LAST CAST · ${word}`, spell.toUpperCase());
let server, browserServer, browser, context, nativeClose;
const watchdogJobs = [];
async function cleanupStep(label, fn) { try { await fn(); return true; } catch (error) { report.cleanup.errors.push({ label, message: error.message }); return false; } }
async function closeBrowser(row) {
  if (context) { row.contextClosed = await cleanupStep('context.close', () => context.close()); context = undefined; }
  if (browser) { await cleanupStep('browser.close', () => browser.close()); browser = undefined; }
  if (browserServer) { await cleanupStep('browserServer.close', () => browserServer.close()); await cleanupStep('native-child-join', () => nativeClose); browserServer = undefined; }
}
const watchdog = setTimeout(() => { report.timedOut = true; if (browserServer) watchdogJobs.push(cleanupStep('watchdog-browser-close', () => browserServer.close())); if (server) server.server.closeAllConnections(); }, report.boundsMs.wholeRun);
async function aim(page, field, row, run) {
  // The real seeded producer's first two enemies have different types. Native
  // real-time gameplay reaches them; no state, seed, time or input is replaced.
  await page.waitForFunction(() => Number(document.querySelectorAll('.spell-stats strong')[4]?.textContent) === 2);
  const targetTypes = run === 1 ? ['SWARM', 'WISP'] : ['SWARM', 'GOLEM'];
  for (const [index, key] of ['ArrowLeft', 'ArrowRight'].entries()) {
    await field.focus(); await page.keyboard.down(key); await frames(page);
    const before = await event(page); await pulse(page, 'KeyE');
    await page.keyboard.up(key); await frames(page);
    await page.waitForFunction(type => new RegExp(`^GRAB · ${type} [0-9]+ HP$`).test(document.querySelector('.spell-event strong')?.textContent ?? ''), targetTypes[index]);
    const after = await event(page); assert.notEqual(before, after);
    row.aim.push({ run, via: 'keyboard', action: 'spell.aim', key, cast: 'KeyE', expectedTargetType: targetTypes[index], before, after }); save();
  }
  await page.screenshot({ path: resolve(output, `${row.engine}-run${run}-aim-consumer.png`) });
}
async function freshActions(page, field, row) {
  for (const [spell, key] of actions) {
    for (const via of ['keyboard', 'local-role']) {
      if (via === 'local-role') await page.getByRole('button', { name: 'Show controls', exact: true }).click();
      if (spell !== 'charge') {
        if (via === 'keyboard') { await field.focus(); await pulse(page, 'KeyC'); }
        else { await page.getByRole('button', { name: /^CHARGE(?:\b|\.)/ }).focus(); await pulse(page, 'Space'); }
        await waitCast(page, 'charge');
      }
      const control = role.layout.layout.find(item => item.type === 'button' && item.action === `spell.cast.${spell}`);
      assert.ok(control);
      await (via === 'keyboard' ? field : page.getByRole('button', { name: new RegExp(`^${control.label}(?:\\b|\\.)`) })).focus();
      const before = await event(page); await pulse(page, via === 'keyboard' ? key : 'Space');
      if (spell === 'charge') await page.waitForFunction(expectedCharge => document.querySelector('.spell-event strong')?.textContent === `ARCANE CHARGE ${expectedCharge}/3`, via === 'keyboard' ? 1 : 2);
      await waitCast(page, spell); const after = await event(page);
      assert.notEqual(before, after, 'Fresh-run consumer event must change');
      row.freshActions.push({ run: 2, action: `spell.cast.${spell}`, via, key: via === 'keyboard' ? key : 'Space', before, after }); save();
      if (via === 'local-role') await page.getByRole('button', { name: 'Hide controls', exact: true }).click();
      await field.focus();
    }
  }
}
save();
try {
  server = await startProdServer({ port: 0, host: '127.0.0.1', outDir: build, silent: true });
  const origin = `http://127.0.0.1:${server.port}`;
  for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    browserServer = await engine.launchServer({ host: '127.0.0.1', port: 0, headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
    const child = { pid: browserServer.process().pid, closed: false };
    nativeClose = new Promise(done => browserServer.process().once('close', (code, signal) => { Object.assign(child, { closed: true, exitCode: code, signal }); done(); }));
    browser = await engine.connect(browserServer.wsEndpoint());
    context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark', reducedMotion: 'reduce', serviceWorkers: 'block' });
    const row = { engine: engineName, version: browser.version(), startedAt: new Date().toISOString(), nativeChild: child, aim: [], freshActions: [], errors: [], console: [] };
    report.results.push(row); save();
    const page = await context.newPage(); page.setDefaultTimeout(5000); page.on('pageerror', error => row.errors.push(error.message));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) row.console.push({ type: message.type(), text: message.text() }); });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    try {
      await page.goto(`${origin}/games/spellcaster`);
      await page.locator('.pre-game-option').first().locator('a').focus(); await page.keyboard.press('Enter');
      await page.waitForURL(url => url.origin === origin && url.pathname === '/games/spellcaster/play');
      const field = page.locator('canvas[tabindex="0"]').first(); await field.waitFor();
      await page.waitForFunction(() => document.activeElement?.matches('canvas[tabindex="0"]'));
      row.rendererObservation = { screenshot: `${engineName}-run1-aim-consumer.png`, expectedUnsupportedCopy: ['3D DISPLAY UNAVAILABLE', 'GAMEPLAY + INPUT CONTINUE'], unsupportedCopyInDom: await page.locator('body').innerText().then(text => /3D DISPLAY UNAVAILABLE|GAMEPLAY \+ INPUT CONTINUE/.test(text)), classification: 'Review the retained rendered screenshot; this selector makes no automatic visual or renderer-fallback claim.' };
      await aim(page, field, row, 1);
      const result = page.getByRole('region', { name: 'Run complete', exact: true });
      await result.waitFor({ timeout: report.boundsMs.naturalEnd });
      row.naturalResult = await result.innerText();
      const again = result.getByRole('button', { name: 'Play again', exact: true });
      assert.equal(await again.evaluate(element => document.activeElement === element), true);
      await page.screenshot({ path: resolve(output, `${engineName}-natural-result.png`) });
      await page.keyboard.press('Space'); await result.waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement?.matches('canvas[tabindex="0"]'));
      await page.waitForFunction(() => document.querySelector('.spell-stats strong')?.textContent === '2');
      row.restart = { via: 'focused Play again native Space', run: 2, fieldFocus: true, event: await event(page) }; save();
      await aim(page, field, row, 2);
      await freshActions(page, field, row);
      await page.getByRole('button', { name: 'Back', exact: true }).click(); await page.waitForURL(`${origin}/games/spellcaster`);
      assert.deepEqual(row.errors, []); row.pass = true;
    } catch (error) {
      row.pass = false; row.failure = { message: error.message, stack: error.stack };
      try { row.failure.snapshot = await page.locator('body').innerText(); await page.screenshot({ path: resolve(output, `${engineName}-failure.png`) }); } catch { /* Context failure can prevent diagnostic capture. */ }
    } finally { await closeBrowser(row); save(); }
  }
} catch (error) { report.fatal = { message: error.message, stack: error.stack }; }
finally {
  clearTimeout(watchdog); if (browserServer) await closeBrowser(report.results.at(-1)); await Promise.allSettled(watchdogJobs);
  if (server) { server.server.closeAllConnections(); report.cleanup.serverClosed = await cleanupStep('server.close', () => new Promise((done, reject) => server.server.close(error => error ? reject(error) : done()))); }
  report.sourcePinsUnchanged = Object.entries(sourcePins).every(([path, pin]) => hash(readFileSync(resolve(root, path))) === pin);
  report.buildPinsUnchanged = Object.entries(buildPins).every(([path, pin]) => hash(readFileSync(resolve(build, path))) === pin);
  rmSync(build, { recursive: true }); report.cleanup.ownedBuildRemoved = true;
  report.finishedAt = new Date().toISOString();
  report.pass = report.results.length === 2 && report.results.every(row => row.pass && row.aim.length === 4 && row.freshActions.length === 12 && row.contextClosed && row.nativeChild.closed && row.nativeChild.exitCode === 0 && row.nativeChild.signal === null)
    && report.sourcePinsUnchanged && report.buildPinsUnchanged && report.cleanup.serverClosed && report.cleanup.ownedBuildRemoved && !report.cleanup.errors.length && !report.fatal && !report.timedOut;
  save();
}
console.log(JSON.stringify({ pass: report.pass, results: report.results.map(row => ({ engine: row.engine, pass: row.pass, aim: row.aim.length, freshActions: row.freshActions.length, failure: row.failure?.message })), cleanup: report.cleanup }));
process.exitCode = report.pass ? 0 : 1;
