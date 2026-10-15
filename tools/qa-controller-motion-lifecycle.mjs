import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startProdServer } from '../node_modules/vinext/dist/server/prod-server.js';
assert.equal(process.argv.length, 2);
const root = resolve(import.meta.dirname, '..'), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const paths = ['app/controller/Controller.tsx', 'app/studio/controller/ControllerLab.tsx', 'packages/session/src/index.ts', 'packages/protocol/src/index.ts', 'packages/adapter-motion/src/index.ts', 'tools/qa-controller-motion-lifecycle.mjs'];
const sourceSha256 = Object.fromEntries(paths.map(p => [p, hash(readFileSync(resolve(root, p)))]));
const buildSha256 = hash(readFileSync(resolve(root, 'dist/server/index.js')));
const results = []; let app;
try {
  app = await startProdServer({ port: 0, host: '127.0.0.1', outDir: resolve(root, 'dist'), silent: true });
  const origin = `http://127.0.0.1:${app.port}`;
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch({ headless: true });
    try {
      const checks = [];
      for (const mode of ['granted', 'denied', 'visit-change', 'host-loss']) {
        const context = await browser.newContext({ reducedMotion: 'reduce' });
        try {
          await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
          await context.addInitScript(() => {
            window.__visitNonce = crypto.randomUUID(); window.__motionCalls = 0; window.__permissions = [];
            const Motion = window.DeviceMotionEvent ?? class extends Event {};
            Object.defineProperty(Motion, 'requestPermission', { configurable: true, value() {
              window.__motionCalls++; return new Promise(resolve => window.__permissions.push(resolve));
            } });
            Object.defineProperty(window, 'DeviceMotionEvent', { configurable: true, value: Motion });
            const add = window.addEventListener, remove = window.removeEventListener;
            const excludeEnvironmentalSample = event => { if (event.isTrusted) event.stopImmediatePropagation(); };
            for (const type of ['devicemotion', 'deviceorientation']) Reflect.apply(add, window, [type, excludeEnvironmentalSample, true]);
            const handlers = new Map([['devicemotion', new Set()], ['deviceorientation', new Set()]]);
            window.__sensorCount = () => [...handlers.values()].reduce((n, set) => n + set.size, 0);
            window.addEventListener = function (type, callback, ...args) { handlers.get(type)?.add(callback); return Reflect.apply(add, this, [type, callback, ...args]); };
            window.removeEventListener = function (type, callback, ...args) { handlers.get(type)?.delete(callback); return Reflect.apply(remove, this, [type, callback, ...args]); };
            window.__settleMotion = value => {
              window.__permissions.splice(0).forEach(resolve => resolve(value));
              return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            };
          });
          const host = await context.newPage(), page = await context.newPage(), errors = [];
          for (const p of [host, page]) p.on('pageerror', e => errors.push({ name: e.name, message: e.message }));
          await host.goto(origin + '/studio/controller');
          const preset = async name => {
            await host.getByRole('button', { name, exact: true }).click();
            await host.locator('.preset-row button.active').filter({ hasText: name }).waitFor();
          };
          await preset('flight');
          await page.goto(origin + '/controller?session=CTRL01');
          await page.locator('.controller-top .mark-label').filter({ hasText: 'Flight Console' }).waitFor();
          const enable = page.locator('.motion-permission button');
          await enable.click(); await page.waitForFunction(() => window.__permissions.length === 1);
          if (mode === 'visit-change') {
            const nonce = await page.evaluate(() => window.__visitNonce);
            await page.evaluate(() => { history.pushState(null, '', '/controller?session=MOTION-OTHER'); window.dispatchEvent(new PopStateEvent('popstate')); });
            await page.getByText('Ready to connect', { exact: true }).waitFor();
            assert.equal(await page.evaluate(() => window.__visitNonce), nonce);
            await page.evaluate(() => window.__settleMotion('granted'));
            const listeners = await page.evaluate(() => window.__sensorCount());
            checks.push({ name: 'late-grant-after-visit-retirement', pass: listeners === 0 && errors.length === 0, listeners, pageErrors: errors });
          } else if (mode === 'host-loss') {
            await page.evaluate(() => window.__settleMotion('granted'));
            await page.getByRole('button', { name: 'Set neutral', exact: true }).waitFor();
            assert.equal(await page.evaluate(() => window.__sensorCount()), 2);
            await host.locator('.controller-lab-topbar .wordmark').click(); await host.waitForURL(origin + '/');
            await page.getByText('Ready to connect', { exact: true }).waitFor({ timeout: 10000 });
            const listeners = await page.evaluate(() => window.__sensorCount());
            checks.push({ name: 'actual-watchdog-retires-active-sensors', pass: listeners === 0 && errors.length === 0, listeners, pageErrors: errors, softwareClock: false });
          } else {
            await enable.evaluate(button => button.click());
            const issued = await page.evaluate(() => window.__motionCalls), reserved = await enable.isDisabled();
            checks.push({ name: `single-pending-request-${mode}`, pass: issued === 1 && reserved, issued, reserved });
            await preset('classic');
            await page.locator('.controller-top .mark-label').filter({ hasText: 'Classic Controller' }).waitFor();
            assert.equal(await enable.count(), 0, 'Actual host configuration must remove motion control');
            await page.evaluate(value => window.__settleMotion(value), mode);
            const retiredListeners = await page.evaluate(() => window.__sensorCount());
            await preset('flight');
            await page.locator('.controller-top .mark-label').filter({ hasText: 'Flight Console' }).waitFor();
            const freshPermissionRequired = await enable.textContent() === 'Enable motion';
            checks.push({ name: `retired-${mode}-cannot-enable-fresh-role`, pass: retiredListeners === 0 && freshPermissionRequired && errors.length === 0,
              retiredListeners, freshPermissionRequired, pageErrors: errors });
            // The old implementation can leave a stale active adapter. Withdraw its real role before retrying.
            await preset('classic'); await page.locator('.controller-top .mark-label').filter({ hasText: 'Classic Controller' }).waitFor();
            await preset('flight'); await page.locator('.controller-top .mark-label').filter({ hasText: 'Flight Console' }).waitFor();
            await enable.click(); await page.waitForFunction(() => window.__permissions.length === 1);
            await page.evaluate(() => window.__settleMotion('granted'));
            await page.getByRole('button', { name: 'Set neutral', exact: true }).waitFor();
            const activeListeners = await page.evaluate(() => window.__sensorCount());
            await page.evaluate(() => {
              for (const gamma of [0, 25]) {
                const event = new Event('deviceorientation');
                Object.defineProperties(event, { alpha: { value: 0 }, beta: { value: 0 }, gamma: { value: gamma } });
                window.dispatchEvent(event);
              }
            });
            await host.locator('.frame-inspector b').filter({ hasText: 'PHONE-MOTION' }).waitFor();
            checks.push({ name: `fresh-granted-role-delivers-real-host-frame-${mode}`, pass: activeListeners === 2 && errors.length === 0, activeListeners, pageErrors: errors });
            await preset('classic'); await page.locator('.controller-top .mark-label').filter({ hasText: 'Classic Controller' }).waitFor();
            const releasedListeners = await page.evaluate(() => window.__sensorCount());
            checks.push({ name: `active-role-withdrawal-stops-sensors-${mode}`, pass: releasedListeners === 0 && errors.length === 0, releasedListeners, pageErrors: errors });
          }
          if (new URL(host.url()).pathname === '/studio/controller') {
            await host.locator('.controller-lab-topbar .wordmark').click(); await host.waitForURL(origin + '/');
          }
        } finally {
          await Promise.allSettled(context.pages().map(page => page.evaluate(() => window.__settleMotion?.('denied'))));
          await context.close();
        }
      }
      results.push({ browser: name, version: browser.version(), checks });
    } finally { await browser.close(); }
  }
} finally {
  if (app) { app.server.closeAllConnections(); await new Promise((resolve, reject) => app.server.close(error => error ? reject(error) : resolve())); }
}
for (const [path, pin] of Object.entries(sourceSha256)) assert.equal(hash(readFileSync(resolve(root, path))), pin, 'Source changed during proof');
const pass = results.every(r => r.checks.every(c => c.pass));
console.log(JSON.stringify({ result: pass ? 'pass' : 'fail', sourceSha256, buildSha256, results, cleanup: { browsers: 0, contexts: 0, servers: 0 }, scope: 'Actual built ControllerLab SessionHost and player Controller over native local BroadcastChannel, real producer role configuration, delivered motion frames and unchanged actual host-loss watchdog. Permission responses and orientation samples are software controlled; environmental native samples excluded. Counts cover owned adapter handlers, excluding fixture filters. No physical sensor, native permission dialog, authenticated remote/resource grant, mobile or whole-task acceptance.' }, null, 2));
if (!pass) process.exitCode = 1;
