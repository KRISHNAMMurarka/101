import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import { chromium, webkit } from 'playwright';
import { startProdServer } from '../node_modules/vinext/dist/server/prod-server.js';
import { measureReticle } from './qa-spellcaster-reticle.mjs';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'outputs/controllers/2026-10-18-spellcaster-aim');
assert.equal(process.argv.length, 2);
assert.equal(process.version, 'v24.14.0');
assert.equal(process.env.NODE_OPTIONS, undefined); assert.equal(process.env.NODE_PATH, undefined);
mkdirSync(output, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const candidate = JSON.parse(readFileSync(resolve(output, 'candidate.json')));
const build = JSON.parse(readFileSync(resolve(output, 'build.json')));
assert.equal(build.exitCode, 0); assert.equal(build.sourcePinsMatchAfter, true);
const sourcePins = Object.fromEntries(Object.entries(candidate.filePins).filter(([path]) =>
  path.startsWith('games/spellcaster/') || path.startsWith('packages/') && !path.endsWith('.test.ts')
  || path.startsWith('app/components/') || path.startsWith('app/lib/') || path.startsWith('app/controller/')
  || path.startsWith('app/games/') || ['package.json', 'package-lock.json', 'vite.config.ts', 'app/layout.tsx', 'app/globals.css'].includes(path)));
for (const [path, pin] of Object.entries(sourcePins)) assert.equal(hash(readFileSync(resolve(root, path))), pin, path);
for (const [path, pin] of Object.entries(build.artifactPins)) assert.equal(hash(readFileSync(path)), pin, path);
const manifest = JSON.parse(readFileSync(resolve(root, 'games/spellcaster/input.manifest.json')));
assert.deepEqual(Object.keys(manifest.vectors), ['spell.aim']);
const report = { schemaVersion: 1, producerTree: candidate.tree, buildProofSha256: hash(readFileSync(resolve(output, 'build.json'))),
  sourcePins, artifactPins: build.artifactPins, sourceSha256: Object.fromEntries(['tools/qa-spellcaster-aim.mjs', 'tools/qa-spellcaster-reticle.mjs'].map(path => [path, hash(readFileSync(resolve(root, path)))])),
  scope: 'Actual rendered ring movement for keyboard vertical aim, local-role arrow aim and local-role desktop pointer drag, before and after natural result/native Space restart. Existing cast and keyboard horizontal proofs are reused.',
  boundsMs: { naturalEnd: 150000, wholeRun: 360000 }, results: [], cleanup: { errors: [] } };
const save = () => writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const frames = page => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
let server, browserServer, browser, context, nativeClose;
const watchdogJobs = [];
async function cleanupStep(name, action) { try { await action(); return true; } catch (error) { report.cleanup.errors.push({ name, message: error.message }); return false; } }
async function closeBrowser(row) {
  if (context) { row.contextClosed = await cleanupStep('context', () => context.close()); context = undefined; }
  if (browser) { await cleanupStep('browser', () => browser.close()); browser = undefined; }
  if (browserServer) { await cleanupStep('browser-server', () => browserServer.close()); await cleanupStep('native-child-join', () => nativeClose); browserServer = undefined; }
}
const watchdog = setTimeout(() => {
  report.timedOut = true;
  if (browserServer) watchdogJobs.push(cleanupStep('watchdog-browser', () => browserServer.close()));
  server?.server.closeAllConnections();
}, report.boundsMs.wholeRun);

async function observe(page, field, row, run, via, direction) {
  const rectangles = await field.evaluate(canvas => {
    const box = canvas.getBoundingClientRect();
    return [...canvas.parentElement.children].filter(element => {
      const style = getComputedStyle(element), bounds = element.getBoundingClientRect();
      return element !== canvas && style.visibility !== 'hidden' && Number(style.opacity) > 0 && bounds.width > 0 && bounds.height > 0;
    }).map(element => {
      const bounds = element.getBoundingClientRect();
      return { element: element.className, left: (bounds.left - box.left) / box.width, right: (bounds.right - box.left) / box.width,
        top: (bounds.top - box.top) / box.height, bottom: (bounds.bottom - box.top) / box.height };
    });
  });
  const filename = `${row.engine}-run${run}-${via}-${direction}.png`;
  const bytes = await field.screenshot({ path: resolve(output, filename) }), png = PNG.sync.read(bytes);
  const exclusions = rectangles.map(rectangle => ({ ...rectangle, left: rectangle.left * png.width, right: rectangle.right * png.width, top: rectangle.top * png.height, bottom: rectangle.bottom * png.height }));
  const measured = measureReticle(bytes, exclusions);
  const result = { run, via, direction, ...measured, screenshot: filename, sha256: hash(bytes), exclusions };
  row.aim.push(result); save(); return result;
}
async function aim(page, field, row, run) {
  // Wait for an actual producer milestone before sampling its real rendered scene.
  await page.waitForFunction(() => Number(document.querySelectorAll('.spell-stats strong')[4]?.textContent) >= 2);
  await page.waitForTimeout(100);
  for (const via of ['keyboard', 'local-keys', 'local-pointer']) {
    if (via === 'local-keys') await page.getByRole('button', { name: 'Show controls', exact: true }).click();
    const control = via === 'keyboard' ? field : page.getByRole('button', { name: 'ARCANE AIM. Drag or use arrow keys.', exact: true });
    await control.focus();
    const observations = {};
    for (const direction of (via === 'keyboard' ? ['Up', 'Down'] : ['Left', 'Right', 'Up', 'Down'])) {
      if (via === 'local-pointer') {
        const box = await control.boundingBox(); assert.ok(box);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
        await page.mouse.move(box.x + box.width * (direction === 'Left' ? .05 : direction === 'Right' ? .95 : .5),
          box.y + box.height * (direction === 'Up' ? .05 : direction === 'Down' ? .95 : .5));
      } else await page.keyboard.down('Arrow' + direction);
      try { await frames(page); await page.waitForTimeout(100); observations[direction] = await observe(page, field, row, run, via, direction); }
      finally { if (via === 'local-pointer') await page.mouse.up(); else await page.keyboard.up('Arrow' + direction); }
      await frames(page);
    }
    if (via !== 'keyboard') assert.ok(observations.Right.x - observations.Left.x > 40, 'Local-role aim moves the actual ring right');
    assert.ok(observations.Up.y - observations.Down.y > 8, 'Actual vertical aim moves the ring nearer for negative y');
    row.directionChecks += via === 'keyboard' ? 1 : 2; save();
    if (via === 'local-pointer') await page.getByRole('button', { name: 'Hide controls', exact: true }).click();
  }
  await field.focus();
}
save();
try {
  server = await startProdServer({ port: 0, host: '127.0.0.1', outDir: resolve(root, 'dist'), silent: true });
  const origin = `http://127.0.0.1:${server.port}`;
  for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    browserServer = await engine.launchServer({ host: '127.0.0.1', port: 0, headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
    const child = { pid: browserServer.process().pid, closed: false };
    nativeClose = new Promise(done => browserServer.process().once('close', (code, signal) => { Object.assign(child, { closed: true, exitCode: code, signal }); done(); }));
    browser = await engine.connect(browserServer.wsEndpoint());
    context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark', reducedMotion: 'reduce', serviceWorkers: 'block' });
    const row = { engine: engineName, version: browser.version(), nativeChild: child, aim: [], directionChecks: 0, errors: [], foreign: [] }; report.results.push(row); save();
    const page = await context.newPage(); page.setDefaultTimeout(5000);
    page.on('pageerror', error => row.errors.push(error.message));
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : (row.foreign.push(route.request().url()), route.abort()));
    try {
      await page.goto(`${origin}/games/spellcaster`);
      await page.locator('.pre-game-option').first().locator('a').focus(); await page.keyboard.press('Enter');
      await page.waitForURL(url => url.origin === origin && url.pathname === '/games/spellcaster/play');
      const field = page.locator('canvas[tabindex="0"]').first(); await field.waitFor();
      await page.waitForFunction(() => document.activeElement?.matches('canvas[tabindex="0"]'));
      await aim(page, field, row, 1);
      const result = page.getByRole('region', { name: 'Run complete', exact: true });
      await result.waitFor({ timeout: report.boundsMs.naturalEnd }); row.naturalResult = await result.innerText();
      assert.equal(await result.getByRole('button', { name: 'Play again', exact: true }).evaluate(element => document.activeElement === element), true);
      await page.keyboard.press('Space'); await result.waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement?.matches('canvas[tabindex="0"]'));
      await page.waitForFunction(() => document.querySelector('.spell-stats strong')?.textContent === '2');
      row.restart = 'Observed natural result, focused native Space, run2 and canvas focus'; await aim(page, field, row, 2);
      await page.getByRole('button', { name: 'Back', exact: true }).click(); await page.waitForURL(`${origin}/games/spellcaster`);
      assert.deepEqual(row.errors, []); assert.deepEqual(row.foreign, []); row.pass = true;
    } catch (error) {
      row.pass = false; row.failure = { message: error.message, stack: error.stack };
      try { row.failure.snapshot = await page.locator('body').innerText(); await page.screenshot({ path: resolve(output, `${engineName}-failure.png`) }); } catch { /* A closed context may prevent capture. */ }
    } finally { await closeBrowser(row); save(); }
  }
} catch (error) { report.fatal = { message: error.message, stack: error.stack }; }
finally {
  clearTimeout(watchdog); if (browserServer) await closeBrowser(report.results.at(-1)); await Promise.allSettled(watchdogJobs);
  if (server) { server.server.closeAllConnections(); report.cleanup.serverClosed = await cleanupStep('server', () => new Promise((done, reject) => server.server.close(error => error ? reject(error) : done()))); }
  report.sourcePinsUnchanged = Object.entries(sourcePins).every(([path, pin]) => hash(readFileSync(resolve(root, path))) === pin);
  report.buildPinsUnchanged = Object.entries(build.artifactPins).every(([path, pin]) => hash(readFileSync(path)) === pin);
  report.toolsUnchanged = Object.entries(report.sourceSha256).every(([path, pin]) => hash(readFileSync(resolve(root, path))) === pin);
  report.pass = report.results.length === 2 && report.results.every(row => row.pass && row.aim.length === 20 && row.directionChecks === 10 && row.contextClosed && row.nativeChild.closed && row.nativeChild.exitCode === 0 && row.nativeChild.signal === null)
    && report.sourcePinsUnchanged && report.buildPinsUnchanged && report.toolsUnchanged && report.cleanup.serverClosed && !report.cleanup.errors.length && !report.fatal && !report.timedOut;
  save();
}
console.log(JSON.stringify({ pass: report.pass, engines: report.results.map(row => ({ engine: row.engine, pass: row.pass, observations: row.aim.length, directionChecks: row.directionChecks, failure: row.failure?.message })), cleanup: report.cleanup }));
process.exitCode = report.pass ? 0 : 1;
