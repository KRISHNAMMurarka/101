import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startProdServer } from '../node_modules/vinext/dist/server/prod-server.js';
assert.equal(process.argv.length, 2);
const root = resolve(import.meta.dirname, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const paths = ['app/studio/motion/MotionLab.tsx', 'packages/adapter-motion/src/index.ts', 'tools/qa-motion-lifecycle.mjs'];
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
      for (const outcome of ['granted', 'denied', 'unmount']) {
        const context = await browser.newContext();
        try {
          await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
          await context.addInitScript(() => {
            window.__motionNonce = crypto.randomUUID(); window.__permissions = []; window.__motionCalls = 0;
            const Motion = window.DeviceMotionEvent ?? class extends Event {};
            Object.defineProperty(Motion, 'requestPermission', { configurable: true, value() {
              window.__motionCalls++;
              return new Promise(resolve => window.__permissions.push(resolve));
            } });
            Object.defineProperty(window, 'DeviceMotionEvent', { configurable: true, value: Motion });
            const add = window.addEventListener, remove = window.removeEventListener;
            // Native environmental samples can overwrite our explicit software sample before rendering.
            // Exclude them only in this controlled-sample QA; the actual adapter handlers stay unchanged.
            const excludeEnvironmentalSample = event => { if (event.isTrusted) event.stopImmediatePropagation(); };
            Reflect.apply(add, window, ['devicemotion', excludeEnvironmentalSample, true]);
            Reflect.apply(add, window, ['deviceorientation', excludeEnvironmentalSample, true]);
            const handlers = new Map([['devicemotion', new Set()], ['deviceorientation', new Set()]]);
            window.__sensorCount = () => [...handlers.values()].reduce((n, set) => n + set.size, 0);
            window.addEventListener = function (type, callback, ...args) {
              handlers.get(type)?.add(callback); return Reflect.apply(add, this, [type, callback, ...args]);
            };
            window.removeEventListener = function (type, callback, ...args) {
              handlers.get(type)?.delete(callback); return Reflect.apply(remove, this, [type, callback, ...args]);
            };
            window.__settleMotion = result => {
              window.__permissions.splice(0).forEach(resolve => resolve(result));
              return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            };
          });
          const page = await context.newPage(), errors = [];
          page.on('pageerror', e => errors.push({ name: e.name, message: e.message }));
          await page.goto(origin + '/studio/motion');
          const enable = page.getByRole('button', { name: /Enable device motion|Waiting for motion permission/ });
          const simulate = page.getByRole('button', { name: 'Use keyboard simulation', exact: true });
          const state = page.locator('.motion-state');
          await enable.click(); await page.waitForFunction(() => window.__permissions.length === 1);
          if (outcome === 'unmount') {
            const nonce = await page.evaluate(() => window.__motionNonce);
            await page.locator('.motion-topbar .wordmark').click();
            await page.waitForURL(origin + '/');
            assert.equal(await page.evaluate(() => window.__motionNonce), nonce, 'Unmount must occur in the same document');
            await page.evaluate(() => window.__settleMotion('granted'));
            const listeners = await page.evaluate(() => window.__sensorCount());
            checks.push({ name: 'late-grant-after-same-document-unmount', pass: listeners === 0 && errors.length === 0, listeners, pageErrors: errors });
          } else {
            await enable.evaluate(button => button.click());
            const issued = await page.evaluate(() => window.__motionCalls);
            await simulate.click(); await page.getByText('SIMULATED', { exact: true }).waitFor();
            const listenersWhileSimulated = await page.evaluate(() => window.__sensorCount());
            const reservedThroughSimulation = await enable.isDisabled();
            checks.push({ name: `single-permission-reservation-${outcome}`, pass: issued === 1 && reservedThroughSimulation, issued, reservedThroughSimulation });
            await page.evaluate(result => window.__settleMotion(result), outcome);
            const retainedSimulation = await state.textContent() === 'SIMULATED';
            const listenersAfterSettlement = await page.evaluate(() => window.__sensorCount());
            checks.push({ name: `retired-${outcome}-retains-keyboard-simulation`, pass: retainedSimulation && listenersWhileSimulated === 0 && listenersAfterSettlement === 0 && errors.length === 0,
              retainedSimulation, listenersWhileSimulated, listenersAfterSettlement, pageErrors: errors });
            await enable.click(); await page.waitForFunction(() => window.__permissions.length === 1);
            await page.evaluate(() => window.__settleMotion('granted'));
            await page.getByText('ACTIVE', { exact: true }).waitFor();
            const activeListeners = await page.evaluate(() => window.__sensorCount());
            await page.evaluate(() => {
              const event = new Event('devicemotion');
              Object.defineProperties(event, { acceleration: { value: { x: 3, y: 4, z: 5 } }, accelerationIncludingGravity: { value: null }, rotationRate: { value: { alpha: 0, beta: 0, gamma: 0 } } });
              window.dispatchEvent(event);
            });
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            const sensorSampleProcessed = await page.locator('.sensor-table article code').first().textContent() === '3.00 / 4.00 / 5.00';
            await simulate.click(); await page.getByText('SIMULATED', { exact: true }).waitFor();
            const simulationListeners = await page.evaluate(() => window.__sensorCount());
            await page.keyboard.press('ArrowRight');
            const raw = page.locator('.sensor-table article').first().locator('code').first();
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            const simulationRaw = await raw.textContent();
            await page.evaluate(() => {
              const event = new Event('devicemotion');
              Object.defineProperties(event, { acceleration: { value: { x: 9, y: 8, z: 7 } }, accelerationIncludingGravity: { value: null }, rotationRate: { value: null } });
              window.dispatchEvent(event);
              return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            });
            const nativeEventIgnored = await raw.textContent() === simulationRaw;
            checks.push({ name: `explicit-retry-and-simulation-isolation-${outcome}`, pass: sensorSampleProcessed && activeListeners === 2 && simulationListeners === 0 && nativeEventIgnored && errors.length === 0,
              sensorSampleProcessed, activeListeners, simulationListeners, simulationRaw, nativeEventIgnored, pageErrors: errors });
            await page.locator('.motion-topbar .wordmark').click(); await page.waitForURL(origin + '/');
            assert.equal(await page.evaluate(() => window.__sensorCount()), 0, 'Unmount must remove all owned sensor handlers');
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
console.log(JSON.stringify({ result: pass ? 'pass' : 'fail', sourceSha256, buildSha256, results, cleanup: { browsers: 0, contexts: 0, servers: 0 }, scope: 'Actual built Motion Lab and actual BrowserMotionAdapter/keyboard behavior, owned adapter DOM listener registration/removal and same-document unmount. Motion permission responses and motion samples are explicitly software controlled; environmental native sensor samples are excluded during the controlled sample journeys. No physical sensor accuracy, native permission dialog, mobile/assistive-technology or whole-task qualification.' }, null, 2));
if (!pass) process.exitCode = 1;
