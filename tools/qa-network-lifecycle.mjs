import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startProdServer } from '../node_modules/vinext/dist/server/prod-server.js';

assert.equal(process.argv.length, 2, 'Only the owned built loopback server is permitted');
const root = resolve(import.meta.dirname, '..'), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const paths = ['app/studio/network/NetworkLab.tsx', 'packages/protocol/src/index.ts', 'packages/transport-webrtc/src/peer.ts', 'tools/qa-network-lifecycle.mjs'];
const sourceSha256 = Object.fromEntries(paths.map(p => [p, hash(readFileSync(resolve(root, p)))]));
const buildSha256 = hash(readFileSync(resolve(root, 'dist/server/index.js'))), results = []; let app;
const settle = page => page.evaluate(async () => {
  window.__holdOffers = false; window.__holdStats = false;
  window.__pendingOffers.splice(0).forEach(resolve => resolve());
  window.__pendingStats.splice(0).forEach(resolve => resolve());
  await Promise.allSettled([...window.__nativeStatsJobs, ...window.__extraReports]);
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
});
try {
  app = await startProdServer({ port: 0, host: '127.0.0.1', outDir: resolve(root, 'dist'), silent: true });
  const origin = 'http://127.0.0.1:' + app.port;
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch({ headless: true });
    try {
      const checks = [];
      const contextFor = async holdOffers => {
        const context = await browser.newContext();
        try {
          await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
          await context.addInitScript(hold => {
            window.__holdOffers = hold; window.__holdStats = false;
            window.__pendingOffers = []; window.__pendingStats = []; window.__nativePeers = [];
            window.__statsCalls = 0; window.__nativeStatsJobs = []; window.__extraReports = []; window.__rejectNextStats = false;
            const interval = window.setInterval;
            window.setInterval = function (callback, delay, ...args) {
              if (delay === 450 && typeof callback === 'function') window.__reportCallback = callback;
              return Reflect.apply(interval, this, [callback, delay, ...args]);
            };
            const Native = RTCPeerConnection;
            window.RTCPeerConnection = class extends Native {
              constructor(...args) { super(...args); window.__nativePeers.push(this); }
              async createOffer(...args) {
                const actual = await super.createOffer(...args);
                if (window.__holdOffers) await new Promise(resolve => window.__pendingOffers.push(resolve));
                return actual;
              }
              getStats(...args) {
                window.__statsCalls++;
                const work = (async () => {
                  const actual = await super.getStats(...args);
                  if (window.__rejectNextStats) { window.__rejectNextStats = false; throw null; }
                  if (window.__holdStats) await new Promise(resolve => window.__pendingStats.push(resolve));
                  return actual;
                })();
                window.__nativeStatsJobs.push(work); return work;
              }
            };
          }, holdOffers);
          return context;
        } catch (error) { await context.close(); throw error; }
      };
      const cleanup = async context => {
        await Promise.allSettled(context.pages().map(page => settle(page)));
        await context.close();
      };
      for (const replacement of [false, true]) {
        const context = await contextFor(true);
        try {
          const page = await context.newPage(), errors = [];
          page.on('pageerror', e => errors.push({ name: e.name, message: e.message }));
          await page.goto(origin + '/studio/network');
          await page.getByRole('button', { name: /Create host offer/ }).click();
          await page.waitForFunction(() => window.__pendingOffers.length === 1);
          await page.getByRole('button', { name: 'Change role', exact: true }).click();
          const oldPeerClosed = await page.evaluate(() => window.__nativePeers.length === 1 && window.__nativePeers[0].connectionState === 'closed');
          if (replacement) {
            await page.evaluate(() => { window.__holdOffers = false; });
            await page.getByRole('button', { name: /Create host offer/ }).click();
            await page.waitForFunction(() => !!document.querySelector('textarea[aria-label="Local pairing code"]')?.value);
          }
          const expectedState = await page.locator('.network-state').textContent();
          await settle(page);
          const stateRetained = await page.locator('.network-state').textContent() === expectedState;
          const staleErrorSuppressed = await page.locator('.pair-error').count() === 0;
          if (replacement) await page.getByRole('button', { name: 'Change role', exact: true }).click();
          const allPeersClosed = await page.evaluate(() => window.__nativePeers.length > 0 && window.__nativePeers.every(peer => peer.connectionState === 'closed'));
          checks.push({ name: replacement ? 'retired-offer-preserves-fresh-host' : 'retired-offer-preserves-role-choice',
            pass: stateRetained && staleErrorSuppressed && oldPeerClosed && allPeersClosed && errors.length === 0,
            stateRetained, staleErrorSuppressed, oldPeerClosed, allPeersClosed, pageErrors: errors });
        } finally { await cleanup(context); }
      }
      const context = await contextFor(false), waiters = [];
      try {
        const host = await context.newPage(), controller = await context.newPage(), errors = [];
        for (const page of [host, controller]) page.on('pageerror', e => errors.push({ name: e.name, message: e.message }));
        await host.goto(origin + '/studio/network'); await controller.goto(origin + '/studio/network');
        await host.getByRole('button', { name: /Create host offer/ }).click();
        await host.waitForFunction(() => !!document.querySelector('textarea[aria-label="Local pairing code"]')?.value);
        const offer = await host.getByRole('textbox', { name: 'Local pairing code', exact: true }).inputValue();
        await controller.getByRole('button', { name: /Join as controller/ }).click();
        await controller.getByRole('textbox', { name: 'Remote pairing code', exact: true }).fill(offer);
        await controller.getByRole('button', { name: /Create answer/ }).click();
        await controller.waitForFunction(() => !!document.querySelector('textarea[aria-label="Local pairing code"]')?.value);
        const answer = await controller.getByRole('textbox', { name: 'Local pairing code', exact: true }).inputValue();
        await host.getByRole('textbox', { name: 'Remote pairing code', exact: true }).fill(answer);
        await host.getByRole('button', { name: /Accept answer/ }).click();
        for (const page of [host, controller]) {
          await page.waitForFunction(() => document.querySelector('.network-state')?.textContent === 'CONNECTED');
          await page.waitForFunction(() => parseInt(document.querySelector('.network-metrics article:nth-child(4) strong')?.textContent ?? '0', 10) > 0);
        }
        checks.push({ name: 'actual-local-peer-frames', pass: errors.length === 0 });
        const errorCount = errors.length; let listener;
        const caught = new Promise(resolve => { listener = () => resolve('page-error'); host.once('pageerror', listener); });
        try {
          await host.evaluate(() => { window.__rejectNextStats = true; });
          const recovery = host.getByText('Connection details are unavailable. Change role to retry.', { exact: true }).waitFor({ timeout: 2000 }).then(() => 'readable-recovery', () => 'no-recovery');
          waiters.push(recovery);
          const outcome = await Promise.race([caught, recovery]);
          checks.push({ name: 'opaque-current-stats-failure', pass: outcome === 'readable-recovery' && errors.length === errorCount, outcome, pageErrors: errors.slice(errorCount), softwareReadFailure: true });
        } finally { host.off('pageerror', listener); }
        await host.evaluate(() => { window.__holdStats = true; });
        await host.waitForFunction(() => window.__pendingStats.length > 0);
        const additionalNativeRequests = await host.evaluate(() => {
          const before = window.__statsCalls;
          if (typeof window.__reportCallback !== 'function') throw Error('Actual450ms callback is required');
          window.__extraReports.push(window.__reportCallback(), window.__reportCallback());
          return window.__statsCalls - before;
        });
        await host.getByRole('button', { name: 'Change role', exact: true }).click();
        const readout = host.locator('.connection-readout > div').first().locator('strong');
        await host.waitForFunction(() => document.querySelector('.connection-readout strong')?.textContent === 'Not connected');
        await settle(host);
        const disconnectedReadoutRetained = await readout.textContent() === 'Not connected';
        const stoppedPeersClosed = await host.evaluate(() => window.__nativePeers.length > 0 && window.__nativePeers.every(peer => peer.connectionState === 'closed'));
        await controller.locator('.network-topbar a.wordmark').click();
        await controller.locator('.network-page').waitFor({ state: 'detached' });
        const unmountedPeersClosed = await controller.evaluate(() => window.__nativePeers.length > 0 && window.__nativePeers.every(peer => peer.connectionState === 'closed'));
        checks.push({ name: 'retired-stats-preserve-disconnected-readout',
          pass: disconnectedReadoutRetained && additionalNativeRequests === 0 && stoppedPeersClosed && unmountedPeersClosed && errors.length === 0,
          disconnectedReadoutRetained, additionalNativeRequests, stoppedPeersClosed, unmountedPeersClosed, pageErrors: errors });
      } finally { await cleanup(context); await Promise.allSettled(waiters); }
      results.push({ browser: name, version: browser.version(), checks });
    } finally { await browser.close(); }
  }
} finally {
  if (app) { app.server.closeAllConnections(); await new Promise((resolve, reject) => app.server.close(error => error ? reject(error) : resolve())); }
}
for (const [path, pin] of Object.entries(sourceSha256)) assert.equal(hash(readFileSync(resolve(root, path))), pin, 'Source changed during proof');
const passed = results.every(result => result.checks.every(check => check.pass));
console.log(JSON.stringify({ result: passed ? 'pass' : 'fail', sourceSha256, buildSha256, results, cleanup: { browsers: 0, contexts: 0, servers: 0 },
  scope: 'Real built Network Lab, native local RTC offers/answers, connected data channels and delivered frames. Native promise results delegated before explicit software settlement barriers, two controlled reporter callback dispatches, and one separately labelled software null read failure. No native timing, remote/physical endpoint, clipboard or whole-task qualification.' }, null, 2));
if (!passed) process.exitCode = 1;
