import { connectSdkFiles } from './connect-sdk-provenance.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startProdServer } from '../node_modules/vinext/dist/server/prod-server.js';

assert.equal(process.argv.length, 2);
const root = resolve(import.meta.dirname, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const paths = ['games/slashstorm/src/game.ts', 'games/slashstorm/src/roles.ts', 'games/slashstorm/input.manifest.json',
  'app/components/SlashstormGame.tsx', 'app/components/GameControllerOverlay.tsx', 'app/components/game-controller-input.ts',
  ...connectSdkFiles(root), 'tools/qa-slashstorm-pause.mjs'];
const sourceSha256 = Object.fromEntries(paths.map(path => [path, hash(readFileSync(resolve(root, path)))]));
const buildSha256 = hash(readFileSync(resolve(root, 'dist/server/index.js'))), results = [];
let app;
try {
  app = await startProdServer({ port: 0, host: '127.0.0.1', outDir: resolve(root, 'dist'), silent: true });
  const origin = `http://127.0.0.1:${app.port}`;
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch({ headless: true });
    try {
      for (const scenario of [
        { name: 'desktop-dark', viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' },
        { name: 'narrow-light', viewport: { width: 390, height: 844 }, colorScheme: 'light' },
      ]) {
        const context = await browser.newContext({ viewport: scenario.viewport, colorScheme: scenario.colorScheme, reducedMotion: 'reduce', serviceWorkers: 'block' });
        try {
          await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
          const page = await context.newPage(), errors = [], checks = [];
          page.on('pageerror', error => errors.push({ name: error.name, message: error.message }));
          const check = (label, detail = {}) => { checks.push({ name: label, pass: true, ...detail }); console.error(`${name} ${scenario.name}: ${label}`); };
          await page.goto(origin + '/games/slashstorm');
          const start = page.locator('.pre-game-option').first().locator('a');
          await start.focus(); await page.keyboard.press('Enter');
          await page.waitForURL(url => url.pathname === '/games/slashstorm/play');
          const canvas = page.locator('canvas[aria-label^="Slashstorm play field"]');
          const pause = page.getByRole('button', { name: 'Pause', exact: true });
          await pause.waitFor(); await page.waitForFunction(() => document.activeElement?.tagName === 'CANVAS');
          check('manifest-chooser-starts-focused-conventional-play');
          const image = async () => hash(await canvas.evaluate(element => element.toDataURL()));
          const initialCanvas = await canvas.evaluate(element => element.toDataURL());
          await page.waitForFunction(initial => document.querySelector('canvas[aria-label^="Slashstorm play field"]').toDataURL() !== initial, initialCanvas, { timeout: 3000, polling: 100 });
          const firstDraw = await canvas.evaluate(element => element.toDataURL());
          await page.waitForFunction(initial => document.querySelector('canvas[aria-label^="Slashstorm play field"]').toDataURL() !== initial, firstDraw, { timeout: 3000, polling: 100 });
          await page.keyboard.down('Escape');
          await page.getByRole('button', { name: 'Resume', exact: true }).waitFor();
          await page.getByRole('status').filter({ hasText: /^Paused\./ }).waitFor();
          const frozen = await image(); await page.keyboard.down('Escape'); await page.waitForTimeout(220);
          assert.equal(await image(), frozen, 'held/repeated pause freezes actual canvas pixels');
          await page.keyboard.up('Escape');
          check('keyboard-pause-freezes-native-canvas-without-repeat-toggle');
          await page.getByRole('button', { name: 'Resume', exact: true }).click();
          await pause.waitFor(); assert.equal(await canvas.evaluate(element => element === document.activeElement), true);
          const resumeBegan = performance.now();
          try {
            const pausedImage = await canvas.evaluate(element => element.toDataURL());
            await page.waitForFunction(previous => document.querySelector('canvas[aria-label^="Slashstorm play field"]').toDataURL() !== previous,
              pausedImage, { timeout: 3000, polling: 100 });
          } catch (error) {
            console.error(JSON.stringify({ browser: name, scenario: scenario.name, phase: 'resume',
              after: await page.evaluate(() => ({ visibility: document.visibilityState,
                status: document.querySelector('[role="status"]')?.textContent, buttons: [...document.querySelectorAll('.slash-statusbar button')].map(button => ({ text: button.textContent, pressed: button.getAttribute('aria-pressed') })) })), errors }));
            throw error;
          }
          check('observed-first-resumed-pixel-change', { observationMs: performance.now() - resumeBegan });
          check('visible-resume-restores-playfield-focus-and-animation');
          await pause.focus(); await page.keyboard.press('Space');
          await page.getByRole('button', { name: 'Resume', exact: true }).waitFor();
          check('pause-button-uses-native-space-activation');
          await page.getByRole('button', { name: 'Show controls', exact: true }).click();
          const role = page.getByRole('combobox', { name: 'Play as' });
          for (const value of ['sword-one', 'sword-two']) {
            await role.selectOption(value);
            const control = page.getByRole('button', { name: /^Pause \/ resume/ });
            await control.focus(); await page.keyboard.down('Space');
            await pause.waitFor(); await page.keyboard.up('Space');
            await page.waitForTimeout(50);
            await control.focus(); await page.keyboard.down('Space');
            await page.getByRole('button', { name: 'Resume', exact: true }).waitFor();
            await page.keyboard.up('Space');
          }
          check('both-declared-sword-roles-pause-and-resume-through-local-deck');
          await page.getByRole('button', { name: 'Hide controls', exact: true }).click();
          await page.getByRole('button', { name: 'Resume', exact: true }).click();
          // Let the actual director and missed targets end the run in real time.
          // No state injection, clock acceleration or forced result is used.
          const result = page.getByRole('region', { name: 'Run complete', exact: true });
          await result.waitFor({ timeout: 30000 });
          const again = result.getByRole('button', { name: 'Play again' });
          assert.equal(await again.evaluate(element => element === document.activeElement), true);
          assert.ok(await again.getAttribute('aria-describedby'), 'focused restart exposes the actual result summary');
          check('natural-game-end-focuses-described-result-and-restart');
          await page.keyboard.press('Space');
          await result.waitFor({ state: 'detached' }); await pause.waitFor();
          await page.waitForFunction(() => document.activeElement?.tagName === 'CANVAS');
          assert.equal(await page.locator('.slash-stats strong').first().textContent(), '2');
          await page.keyboard.down('Escape'); await page.getByRole('button', { name: 'Resume', exact: true }).waitFor(); await page.keyboard.up('Escape');
          check('space-restart-creates-fresh-playable-pause-state');
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'new controls fit viewport');
          assert.deepEqual(errors, []); check('no-page-errors-or-horizontal-overflow');
          await page.getByRole('button', { name: 'Back', exact: true }).click(); await page.waitForURL(origin + '/games/slashstorm');
          check('back-exits-paused-game');
          results.push({ browser: name, version: browser.version(), scenario: scenario.name, checks });
          console.error(`${name} ${scenario.name}: ${checks.length} checks passed`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  }
} finally {
  if (app) { app.server.closeAllConnections(); await new Promise((resolve, reject) => app.server.close(error => error ? reject(error) : resolve())); }
}
for (const [path, pin] of Object.entries(sourceSha256)) assert.equal(hash(readFileSync(resolve(root, path))), pin, 'Source changed during browser proof');
console.log(JSON.stringify({ result: 'pass', buildSha256, sourceSha256, results, cleanup: { browsers: 0, contexts: 0, servers: 0 },
  scope: 'Actual fresh built Slashstorm, native Chromium/WebKit DOM keyboard/button/local-controller input, canvas pixels, natural game end and restart. Desktop and narrow viewport, both themes and reduced motion. Service workers disabled for fresh artifact proof. No physical phone/gamepad, remote controller, assistive technology, full G06 or native startup qualification.' }, null, 2));
