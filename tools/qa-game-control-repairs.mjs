import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import { PerspectiveCamera, Vector3 } from 'three';
import { chromium, webkit } from 'playwright';
import { canTravel, generateMaze } from '@101/maze';
import { startProdServer } from '../node_modules/vinext/dist/server/prod-server.js';

assert.equal(process.argv.length, 2);
const root = resolve(import.meta.dirname, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const paths = ['games/echomaze/src/game.ts', 'games/echomaze/src/roles.ts', 'games/beatforge/src/game.ts',
  'games/beatforge/src/roles.ts', 'games/beatforge/input.manifest.json', 'app/components/EchoMazeGame.tsx',
  'app/components/BeatForgeGame.tsx', 'packages/adapter-keyboard/src/index.ts', 'packages/adapter-gamepad/src/index.ts',
  'app/controller/Controller.tsx', 'app/components/game-controller-input.ts', 'app/components/GameControllerOverlay.tsx',
  'app/globals.css', 'tools/qa-game-control-repairs.mjs'];
const sourceSha256 = Object.fromEntries(paths.map(path => [path, hash(readFileSync(resolve(root, path)))]));
const buildSha256 = hash(readFileSync(resolve(root, 'dist/server/index.js'))), results = [];
// Locate the initial floor cell in the native camera projection. Count only the
// neutral ring region, excluding the changing field log and clue over the canvas.
const markerPixels = buffer => {
  const { data, width, height } = PNG.sync.read(buffer);
  const camera = new PerspectiveCamera(55, width / height, .1, 2000);
  camera.position.set(0, 10, 7 * .62); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
  const point = new Vector3(-3, .06, -3).project(camera);
  const cx = (point.x + 1) * width / 2, cy = (1 - point.y) * height / 2;
  let count = 0;
  for (let y = Math.max(0, Math.floor(cy - height * .04)); y < Math.min(height, cy + height * .04); y++) {
    for (let x = Math.max(0, Math.floor(cx - height * .045)); x < Math.min(width, cx + height * .045); x++) {
      const i = (y * width + x) * 4, rgb = [data[i], data[i + 1], data[i + 2]];
      if (Math.min(...rgb) > 60 && Math.max(...rgb) - Math.min(...rgb) < 12) count++;
    }
  }
  return count;
};
let app;
try {
  app = await startProdServer({ port: 0, host: '127.0.0.1', outDir: resolve(root, 'dist'), silent: true });
  const origin = `http://127.0.0.1:${app.port}`;
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch({ headless: true });
    const deadline = setTimeout(() => { void browser.close(); }, 180000);
    try {
      for (const scenario of [
        { name: 'desktop-dark', viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' },
        { name: 'narrow-light', viewport: { width: 390, height: 844 }, colorScheme: 'light' },
      ]) {
        const context = await browser.newContext({ viewport: scenario.viewport, colorScheme: scenario.colorScheme, reducedMotion: 'reduce', serviceWorkers: 'block' });
        let observedPage;
        try {
          await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
          const page = await context.newPage(), errors = [], checks = []; observedPage = page;
          const neutralFrame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          page.on('pageerror', error => errors.push({ name: error.name, message: error.message }));
          const check = (label, detail = {}) => { checks.push({ name: label, pass: true, ...detail }); console.error(`${name} ${scenario.name}: ${label}`); };
          const start = async game => {
            await page.goto(origin + `/games/${game}`);
            await page.locator('.pre-game-option').first().locator('a').focus(); await page.keyboard.press('Enter');
            await page.waitForURL(url => url.pathname === `/games/${game}/play`);
            await page.waitForFunction(() => document.activeElement?.tagName === 'CANVAS');
          };
          await start('echomaze');
          const markCount = count => page.getByRole('status').filter({ hasText: new RegExp(`^${count} ${count === 1 ? 'place' : 'places'} marked$`) });
          const mazeCanvas = page.locator('canvas[aria-label^="Echo Maze top-down"]');
          await markCount(0).waitFor();
          if (scenario.viewport.width < 759) {
            const overlap = await page.evaluate(() => {
              const canvas = document.querySelector('.echo-stage canvas').getBoundingClientRect(), log = document.querySelector('.echo-event').getBoundingClientRect();
              return log.top < canvas.bottom && log.bottom > canvas.top;
            });
            assert.equal(overlap, false, 'the narrow field log must leave the maze and starting cell visible');
            check('narrow-field-log-leaves-maze-unobscured');
          }
          const before = markerPixels(await mazeCanvas.screenshot());
          await page.keyboard.down('KeyM'); await markCount(1).waitFor();
          await page.keyboard.down('KeyM'); await page.waitForTimeout(220); assert.equal(await markCount(1).count(), 1);
          await page.keyboard.up('KeyM'); await neutralFrame();
          const markerObservationStarted = performance.now();
          let marked = before;
          while (marked <= before + 3 && performance.now() - markerObservationStarted < 3000) {
            marked = markerPixels(await mazeCanvas.screenshot());
            if (marked <= before + 3) await page.waitForTimeout(100);
          }
          assert.ok(marked > before + 3, `native rendered neutral floor marker must be visible: ${before} -> ${marked}`);
          check('keyboard-mark-toggles-once-and-adds-visible-native-floor-ring', { beforeMarkerPixels: before, markedMarkerPixels: marked, observationMs: performance.now() - markerObservationStarted });
          await page.keyboard.down('KeyM'); await markCount(0).waitFor(); await page.keyboard.up('KeyM'); await neutralFrame();
          check('fresh-keyboard-mark-removes-current-place');
          await page.getByRole('button', { name: 'Show controls', exact: true }).click();
          const mark = page.getByRole('button', { name: /^MARK\b/ });
          await mark.focus(); await page.keyboard.down('Space'); await markCount(1).waitFor();
          await page.keyboard.down('Space'); await page.waitForTimeout(220); assert.equal(await markCount(1).count(), 1);
          await page.keyboard.up('Space'); await neutralFrame();
          await page.keyboard.down('Space'); await markCount(0).waitFor(); await page.keyboard.up('Space'); await neutralFrame();
          check('scanner-mark-button-supports-native-space-and-held-release');
          await page.getByRole('button', { name: 'Hide controls', exact: true }).click(); await mazeCanvas.focus();
          const floor = generateMaze('echomaze-1', 1);
          const direction = ['north', 'east', 'south', 'west'].find(value => canTravel(floor, floor.start, value)); assert.ok(direction);
          const moveKey = { north: 'ArrowUp', east: 'ArrowRight', south: 'ArrowDown', west: 'ArrowLeft' }[direction];
          await page.keyboard.down('KeyM'); await markCount(1).waitFor();
          await page.keyboard.down(moveKey); await page.waitForTimeout(220); await page.keyboard.up(moveKey);
          await page.keyboard.down('KeyM'); await page.waitForTimeout(220); assert.equal(await markCount(1).count(), 1);
          await page.keyboard.up('KeyM'); await neutralFrame();
          check('walking-with-held-mark-does-not-create-extra-marks');
          await page.keyboard.down('KeyM'); await markCount(2).waitFor(); await page.keyboard.up('KeyM'); await neutralFrame();
          check('fresh-mark-at-new-place-keeps-previous-floor-marker');
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          await page.getByRole('button', { name: 'Back', exact: true }).click(); await page.waitForURL(origin + '/games/echomaze');
          check('marked-maze-exits-through-back-without-overflow');

          await start('beatforge');
          const beatCanvas = page.locator('canvas[aria-label^="BeatForge play field"]');
          const score = async () => Number(await page.locator('.beat-stats strong').nth(1).textContent());
          const nextDirection = async () => {
            await page.waitForFunction(() => /^(LEFT|RIGHT) SLASH$/.test(document.querySelector('.beat-next strong')?.textContent ?? '')
              && parseFloat(document.querySelector('.beat-next small')?.textContent ?? '') > .1, null, { timeout: 5000 });
            return await page.locator('.beat-next strong').textContent();
          };
          const atTarget = async label => {
            await page.waitForFunction(expected => document.querySelector('.beat-next strong')?.textContent === expected
              && parseFloat(document.querySelector('.beat-next small')?.textContent ?? '') <= .19, label, { timeout: 4000, polling: 10 });
          };
          const gainedScore = async previous => {
            await page.waitForFunction(value => Number(document.querySelectorAll('.beat-stats strong')[1]?.textContent) > value,
              previous, { timeout: 1000, polling: 10 });
          };
          // The real beatforge-1 chart opens with Punch, then Right at2.935714s.
          // Hold Right before either note; wait for the visible Right countdown to swing.
          const label = 'RIGHT SLASH', previous = await score();
          await page.keyboard.down(label === 'LEFT SLASH' ? 'KeyA' : 'KeyD');
          await page.waitForTimeout(100); assert.equal(await score(), previous, 'holding direction early must not judge the note');
          await atTarget(label); await page.keyboard.down('KeyG'); await gainedScore(previous);
          const after = await score(); await page.keyboard.down('KeyG'); await page.waitForTimeout(220); assert.equal(await score(), after);
          await page.keyboard.up('KeyG'); await page.keyboard.up(label === 'LEFT SLASH' ? 'KeyA' : 'KeyD');
          check('keyboard-g-swings-held-direction-at-real-target-without-repeat', { scoreBefore: previous, scoreAfter: after });
          const result = page.getByRole('region', { name: 'Run complete', exact: true });
          await result.waitFor({ timeout: 30000 });
          const again = result.getByRole('button', { name: 'Play again' });
          assert.equal(await again.evaluate(element => element === document.activeElement), true);
          assert.ok(await again.getAttribute('aria-describedby'));
          check('natural-beat-end-focuses-described-result');
          await page.keyboard.press('Space'); await result.waitFor({ state: 'detached' });
          await page.waitForFunction(() => document.activeElement?.tagName === 'CANVAS');
          assert.equal(await page.locator('.beat-stats strong').first().textContent(), '2');
          check('space-restart-creates-fresh-conventional-beat-run');
          await page.getByRole('button', { name: 'Show controls', exact: true }).click();
          const surface = page.getByRole('button', { name: /^SWING DIRECTION\. Drag or use arrow keys\./ });
          await surface.scrollIntoViewIfNeeded();
          await surface.click({ trial: true });
          const padLabel = await nextDirection(), padBefore = await score();
          const bounds = await surface.boundingBox(); assert.ok(bounds);
          const point = { x: bounds.x + bounds.width * (padLabel === 'LEFT SLASH' ? .15 : .85), y: bounds.y + bounds.height * .5 };
          await page.mouse.move(point.x, point.y);
          const pointerTarget = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label'), point);
          assert.match(pointerTarget ?? '', /^SWING DIRECTION/);
          await atTarget(padLabel);
          await page.mouse.down(); await gainedScore(padBefore); await page.mouse.up();
          check('actual-role-surface-atomically-activates-direction-and-swing', { scoreBefore: padBefore, scoreAfter: await score() });
          await surface.focus();
          const keyLabel = await nextDirection(), keyBefore = await score();
          await atTarget(keyLabel); await page.keyboard.down(keyLabel === 'LEFT SLASH' ? 'ArrowLeft' : 'ArrowRight');
          await gainedScore(keyBefore); await page.keyboard.up(keyLabel === 'LEFT SLASH' ? 'ArrowLeft' : 'ArrowRight');
          check('focused-role-surface-provides-equivalent-arrow-key-swing', { scoreBefore: keyBefore, scoreAfter: await score() });
          await page.getByRole('button', { name: 'Hide controls', exact: true }).click(); await beatCanvas.focus();
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          assert.deepEqual(errors, []); check('no-page-errors-or-horizontal-overflow');
          await page.getByRole('button', { name: 'Back', exact: true }).click(); await page.waitForURL(origin + '/games/beatforge');
          check('beat-back-exits-fresh-run');
          results.push({ browser: name, version: browser.version(), scenario: scenario.name, checks });
        } catch (error) {
          console.error(JSON.stringify({ browser: name, scenario: scenario.name, visibleAtFailure: observedPage ? (await observedPage.locator('body').innerText()).slice(0, 2500) : null }));
          throw error;
        } finally { await context.close(); }
      }
    } finally { clearTimeout(deadline); await browser.close(); }
  }
} catch (error) {
  console.error(error.stack); throw error;
} finally {
  if (app) { app.server.closeAllConnections(); await new Promise((resolve, reject) => app.server.close(error => error ? reject(error) : resolve())); }
}
for (const [path, digest] of Object.entries(sourceSha256)) assert.equal(hash(readFileSync(resolve(root, path))), digest, `source changed: ${path}`);
assert.equal(hash(readFileSync(resolve(root, 'dist/server/index.js'))), buildSha256);
console.log(JSON.stringify({ schemaVersion: 1, pass: true, sourceSha256, buildSha256, results,
  totalChecks: results.reduce((sum, result) => sum + result.checks.length, 0), physicalInputQualified: false,
  echoFloorTransition: 'actual keyboard-driven unit traversal; not a full browser expedition/end acceptance',
  clockOrGameStateOverrides: false, cleanup: { contextsClosed: true, browsersClosed: true, serverClosed: true } }, null, 2));
