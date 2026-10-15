import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startProdServer } from '../node_modules/vinext/dist/server/prod-server.js';
assert.equal(process.argv.length, 2);
const root = resolve(import.meta.dirname, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourcePaths = ['app/studio/network/NetworkLab.tsx', 'app/lib/invitation-copy.ts', 'tools/qa-network-copy.mjs'];
const sourceSha256 = Object.fromEntries(sourcePaths.map(p => [p, hash(readFileSync(resolve(root, p)))]));
const buildSha256 = hash(readFileSync(resolve(root, 'dist/server/index.js')));
const results = []; let app;
try {
  app = await startProdServer({ port: 0, host: '127.0.0.1', outDir: resolve(root, 'dist'), silent: true });
  const origin = 'http://127.0.0.1:' + app.port;
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch({ headless: true });
    try {
      const checks = [];
      for (const mode of ['missing', 'getter-error', 'method-error', 'denied', 'success', 'held']) {
        const context = await browser.newContext(), waiters = [];
        try {
          await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
          await context.addInitScript(mode => {
            window.__copyMode = mode; window.__copyCalls = 0; window.__pendingCopies = [];
            Object.defineProperty(navigator, 'clipboard', { configurable: true, get() {
              if (window.__copyMode === 'missing') return undefined;
              if (window.__copyMode === 'getter-error') throw Error('Owned software clipboard getter failure');
              return { writeText() {
                window.__copyCalls++;
                if (window.__copyMode === 'method-error') throw Error('Owned software clipboard method failure');
                if (window.__copyMode === 'denied') return Promise.reject(new DOMException('Owned software denial', 'NotAllowedError'));
                if (window.__copyMode === 'held') return new Promise(resolve => window.__pendingCopies.push(resolve));
                return Promise.resolve();
              } };
            } });
          }, mode);
          const page = await context.newPage(), errors = [];
          page.on('pageerror', e => errors.push({ name: e.name, message: e.message }));
          await page.goto(origin + '/studio/network');
          const host = () => page.getByRole('button', { name: /Create host offer/ }).click();
          const code = page.getByRole('textbox', { name: 'Local pairing code', exact: true });
          const copy = page.locator('.pair-column').first().getByRole('button', { name: /Copy pairing code|Copied|Copying/ });
          const ready = () => page.waitForFunction(() => !!document.querySelector('textarea[aria-label="Local pairing code"]')?.value);
          await host(); await ready();
          if (mode === 'success') {
            await copy.click(); await page.getByRole('button', { name: 'Copied', exact: true }).waitFor();
            checks.push({ name: mode, pass: errors.length === 0 });
          } else if (mode === 'held') {
            const previousCode = await code.inputValue();
            await copy.click(); await page.waitForFunction(() => window.__pendingCopies.length === 1);
            await copy.evaluate(button => button.click());
            const issued = await page.evaluate(() => window.__copyCalls);
            await page.getByRole('button', { name: 'Change role', exact: true }).click();
            await host(); await ready();
            assert.notEqual(await code.inputValue(), previousCode, 'Actual replacement offer must be newly generated');
            const reservedThroughRoleChange = await copy.isDisabled();
            await page.evaluate(() => {
              window.__pendingCopies.splice(0).forEach(resolve => resolve());
              return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            });
            const staleSuccessSuppressed = await page.getByRole('button', { name: 'Copied', exact: true }).count() === 0;
            checks.push({ name: 'pending-role-change', pass: issued === 1 && reservedThroughRoleChange && staleSuccessSuppressed, issued, reservedThroughRoleChange, staleSuccessSuppressed });
            await page.evaluate(() => { window.__copyMode = 'success'; });
            assert.equal(await copy.isEnabled(), true);
            await copy.click(); await page.getByRole('button', { name: 'Copied', exact: true }).waitFor();
            checks.push({ name: 'fresh-explicit-retry', pass: errors.length === 0 });
          } else {
            let listener;
            const caught = new Promise(resolve => { listener = () => resolve('page-error'); page.once('pageerror', listener); });
            try {
              await copy.click();
              const manual = page.getByText('Copying is unavailable. Select and copy the pairing code from its field.', { exact: true }).waitFor({ timeout: 2000 }).then(() => 'manual-recovery', () => 'no-recovery');
              waiters.push(manual);
              const outcome = await Promise.race([caught, manual]);
              checks.push({ name: mode, pass: outcome === 'manual-recovery' && errors.length === 0 && (await code.inputValue()).length > 0 && await page.getByRole('button', { name: 'Copied', exact: true }).count() === 0, outcome, pageErrors: errors });
            } finally { page.off('pageerror', listener); }
          }
          await page.getByRole('button', { name: 'Change role', exact: true }).click();
        } finally { await context.close(); await Promise.allSettled(waiters); }
      }
      const answerContext = await browser.newContext();
      try {
        await answerContext.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        await answerContext.addInitScript(() => {
          window.__holdAnswer = false; window.__pendingAnswers = [];
          window.__holdCopy = true; window.__pendingCopies = []; window.__lastCopied = undefined;
          const createAnswer = RTCPeerConnection.prototype.createAnswer;
          RTCPeerConnection.prototype.createAnswer = async function (...args) {
            const actual = await Reflect.apply(createAnswer, this, args);
            if (window.__holdAnswer) await new Promise(resolve => window.__pendingAnswers.push(resolve));
            return actual;
          };
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText(text) {
            window.__lastCopied = text;
            return window.__holdCopy ? new Promise(resolve => window.__pendingCopies.push(resolve)) : Promise.resolve();
          } } });
        });
        const host = await answerContext.newPage(), controller = await answerContext.newPage(), errors = [];
        for (const page of [host, controller]) page.on('pageerror', error => errors.push({ name: error.name, message: error.message }));
        await host.goto(origin + '/studio/network'); await controller.goto(origin + '/studio/network');
        const hostCode = host.getByRole('textbox', { name: 'Local pairing code', exact: true });
        const code = controller.getByRole('textbox', { name: 'Local pairing code', exact: true });
        const copy = controller.locator('.pair-column').first().getByRole('button', { name: /Copy pairing code|Copied|Copying/ });
        const offer = async () => {
          await host.getByRole('button', { name: /Create host offer/ }).click();
          await host.waitForFunction(() => !!document.querySelector('textarea[aria-label="Local pairing code"]')?.value);
          return hostCode.inputValue();
        };
        const firstOffer = await offer();
        await controller.getByRole('button', { name: /Join as controller/ }).click();
        await controller.getByRole('textbox', { name: 'Remote pairing code', exact: true }).fill(firstOffer);
        await controller.getByRole('button', { name: /Create answer/ }).click();
        await controller.waitForFunction(() => !!document.querySelector('textarea[aria-label="Local pairing code"]')?.value);
        const previousAnswer = await code.inputValue();
        await host.getByRole('button', { name: 'Change role', exact: true }).click();
        const replacementOffer = await offer();
        assert.ok(replacementOffer !== firstOffer, 'Replacement must use a fresh actual offer');
        await controller.getByRole('textbox', { name: 'Remote pairing code', exact: true }).fill(replacementOffer);
        await controller.evaluate(() => { window.__holdAnswer = true; });
        await controller.getByRole('button', { name: /Create answer/ }).click();
        await controller.waitForFunction(() => window.__pendingAnswers.length === 1);
        const clearedWhileGenerating = await code.inputValue() === '' && await copy.isDisabled();
        let issuedOldCopy = false, copiedOldCode = false;
        if (await copy.isEnabled()) {
          await copy.click(); await controller.waitForFunction(() => window.__pendingCopies.length === 1);
          issuedOldCopy = true;
          copiedOldCode = await controller.evaluate(previous => window.__lastCopied === previous, previousAnswer);
        }
        await controller.evaluate(() => window.__pendingAnswers.splice(0).forEach(resolve => resolve()));
        await controller.waitForFunction(previous => {
          const value = document.querySelector('textarea[aria-label="Local pairing code"]')?.value;
          return value && value !== previous;
        }, previousAnswer);
        await controller.evaluate(() => {
          window.__pendingCopies.splice(0).forEach(resolve => resolve());
          return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        const staleSuccessSuppressed = await controller.getByRole('button', { name: 'Copied', exact: true }).count() === 0;
        checks.push({ name: 'answer-replacement-current-code', pass: clearedWhileGenerating && staleSuccessSuppressed && errors.length === 0,
          clearedWhileGenerating, issuedOldCopy, copiedOldCode, staleSuccessSuppressed, pageErrors: errors });
        await controller.evaluate(() => { window.__holdCopy = false; });
        await copy.click(); await controller.getByRole('button', { name: 'Copied', exact: true }).waitFor();
        checks.push({ name: 'fresh-replacement-answer-copy', pass: errors.length === 0 });
        for (const page of [host, controller]) await page.getByRole('button', { name: 'Change role', exact: true }).click();
      } finally {
        await Promise.allSettled(answerContext.pages().map(page => page.evaluate(() => {
          window.__pendingAnswers.splice(0).forEach(resolve => resolve());
          window.__pendingCopies.splice(0).forEach(resolve => resolve());
        })));
        await answerContext.close();
      }
      results.push({ browser: name, version: browser.version(), checks });
    } finally { await browser.close(); }
  }
} finally {
  if (app) { app.server.closeAllConnections(); await new Promise((resolve, reject) => app.server.close(error => error ? reject(error) : resolve())); }
}
for (const [path, pin] of Object.entries(sourceSha256)) assert.equal(hash(readFileSync(resolve(root, path))), pin, 'Source changed during proof');
const pass = results.every(r => r.checks.every(c => c.pass));
console.log(JSON.stringify({ result: pass ? 'pass' : 'fail', sourceSha256, buildSha256, results, cleanup: { browsers: 0, contexts: 0, servers: 0 }, scope: 'Actual built Network Lab/native local RTC offers and answers with isolated software clipboard and actual-result-delegating answer settlement seams. No native clipboard permission or write, physical device, remote endpoint or whole-task qualification.' }, null, 2));
if (!pass) process.exitCode = 1;
