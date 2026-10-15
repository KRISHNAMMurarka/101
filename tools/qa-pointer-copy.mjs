import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startProdServer } from '../node_modules/vinext/dist/server/prod-server.js';
import { createLocalIdentity } from './qa-enrollment-ui.mjs';

// Real built routes/crypto/storage, with an explicit software clipboard port.
// No user's clipboard, remote endpoint or physical device is accessed.
assert.equal(process.argv.length, 2, 'No endpoint or credential arguments accepted');
const root = resolve(import.meta.dirname, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const paths = ['app/components/RemotePointerPanel.tsx', 'app/pointer-lab/PointerLab.tsx', 'app/lib/invitation-copy.ts', 'tools/qa-pointer-copy.mjs'];
const sourceSha256 = Object.fromEntries(paths.map(p => [p, hash(readFileSync(resolve(root, p)))]));
const buildSha256 = hash(readFileSync(resolve(root, 'dist/server/index.js')));
const results = []; let app;
try {
  app = await startProdServer({ port: 0, host: '127.0.0.1', outDir: resolve(root, 'dist'), silent: true });
  const origin = 'http://127.0.0.1:' + app.port;
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch({ headless: true });
    try {
      for (const studio of [false, true]) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
        const waiters = [];
        try {
          await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
          await context.addInitScript(() => {
            window.__copyMode = 'missing'; window.__copyCalls = 0; window.__pendingCopies = [];
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
          });
          const page = await context.newPage(), errors = [], checks = [];
          page.on('pageerror', error => errors.push({ name: error.name, message: error.message }));
          await page.goto(origin + (studio ? '/studio/input' : '/pointer-lab'));
          if (studio) await page.getByText('Remote pointer resources', { exact: true }).click();
          await createLocalIdentity(page, studio ? '101.endpoint-identity.v1:input-lab-receiver' : '101.endpoint-identity.v1:pointer-receiver');
          const field = page.locator(studio ? '#input-lab-pointer-invitation' : '#receiver-invitation-code');
          const copy = page.getByRole('button', { name: 'Copy invitation', exact: true });
          const fresh = async mode => {
            await page.evaluate(mode => { window.__copyMode = mode; }, mode);
            await page.getByRole('button', { name: 'Create invitation', exact: true }).click();
            await field.waitFor(); assert.ok((await field.inputValue()).length > 0);
          };
          const manual = async (button, text) => {
            const count = errors.length; let listener;
            const caught = new Promise(resolve => { listener = () => resolve('page-error'); page.once('pageerror', listener); });
            try {
              await button.click();
              const recovery = page.getByText(text, { exact: true }).waitFor({ timeout: 2000 }).then(() => 'manual-recovery', () => 'no-recovery');
              waiters.push(recovery);
              const outcome = await Promise.race([caught, recovery]);
              return { pass: outcome === 'manual-recovery' && errors.length === count && (await field.inputValue()).length > 0, outcome, pageErrors: errors.slice(count) };
            } finally { page.off('pageerror', listener); }
          };
          for (const mode of ['missing', 'getter-error', 'method-error', 'denied']) {
            await fresh(mode);
            checks.push({ name: mode, ...await manual(copy, 'Select and copy the invitation from its field.') });
          }
          if (!studio) {
            await fresh('missing');
            checks.push({ name: 'missing-link-clipboard', ...await manual(page.getByRole('button', { name: 'Copy link', exact: true }), 'Select and copy the link from its field.') });
          }
          await fresh('success'); await copy.click();
          await page.getByText('Invitation copied.', { exact: true }).waitFor();
          checks.push({ name: 'settled-success', pass: true });
          await fresh('held');
          const calls = await page.evaluate(() => window.__copyCalls);
          await copy.click(); await page.waitForFunction(() => window.__pendingCopies.length === 1);
          await copy.evaluate(button => button.click());
          const issued = await page.evaluate(() => window.__copyCalls) - calls;
          await page.getByRole('button', { name: studio ? 'Stop remote pointer' : 'Stop', exact: true }).click();
          const stopped = studio ? 'Stopped. Aim is neutral and trigger is released. Create a fresh invitation to continue.' : 'Stopped. Create a fresh invitation to continue.';
          await page.getByText(stopped, { exact: true }).waitFor();
          await page.evaluate(() => {
            window.__pendingCopies.splice(0).forEach(resolve => resolve());
            return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          });
          const stoppedRetained = await page.getByText(stopped, { exact: true }).count() === 1;
          checks.push({ name: 'held-copy-stop', pass: issued === 1 && stoppedRetained, issued, stoppedRetained });
          await fresh('success');
          assert.equal(await copy.isEnabled(), true, 'Settled copy reservation must permit a fresh explicit copy');
          await copy.click(); await page.getByText('Invitation copied.', { exact: true }).waitFor();
          checks.push({ name: 'fresh-copy-after-settlement', pass: true });
          await page.getByRole('button', { name: studio ? 'Stop remote pointer' : 'Stop', exact: true }).click();
          results.push({ browser: name, version: browser.version(), surface: studio ? 'studio-input' : 'pointer-lab', checks, pageErrors: errors, softwareClipboardSeam: true, nativeClipboardWrites: 0 });
        } finally { await context.close(); await Promise.allSettled(waiters); }
      }
    } finally { await browser.close(); }
  }
} finally {
  if (app) { app.server.closeAllConnections(); await new Promise((resolve, reject) => app.server.close(error => error ? reject(error) : resolve())); }
}
for (const [path, pin] of Object.entries(sourceSha256)) assert.equal(hash(readFileSync(resolve(root, path))), pin, 'Source changed during proof');
const passed = results.every(result => result.checks.every(check => check.pass) && result.pageErrors.length === 0);
console.log(JSON.stringify({ result: passed ? 'pass' : 'fail', node: process.version, sourceSha256, buildSha256, results, cleanup: { browsers: 0, contexts: 0, servers: 0 }, scope: 'Selected real built pointer/Studio copy recovery and completion ownership with software clipboard failures/settlement only; no native/general clipboard, remote endpoint, phone or whole-task qualification.' }, null, 2));
if (!passed) process.exitCode = 1;
