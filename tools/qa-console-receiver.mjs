import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve, join, relative } from 'node:path';
import { build, version as viteVersion } from 'vite';
import { chromium, webkit } from 'playwright';

const root = resolve(import.meta.dirname, '..'), app = join(root, 'apps/console-receiver'), out = join(root, 'release/console-receiver');
const evidence = join(root, 'outputs/controllers/2026-10-18-console-receiver'); mkdirSync(evidence, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), closure = new Map();
const pin = () => ({ name: 'pin-console-receiver-source', generateBundle() {
  for (const id of this.getModuleIds()) if (id.startsWith(root + '/') && !id.includes('/node_modules/') && !id.includes('?') && statSync(id).isFile()) closure.set(relative(root, id), hash(readFileSync(id)));
} });
await build({ configFile: false, root: app, base: './', plugins: [pin()], build: { outDir: join(out, 'web'), emptyOutDir: true, target: 'es2022', assetsInlineLimit: 0 } });
await build({ configFile: false, root: app, plugins: [pin()], build: { outDir: join(out, 'qa'), emptyOutDir: true, target: 'es2022',
  lib: { entry: join(app, 'qa/source.ts'), formats: ['es'], fileName: () => 'source.js' } } });
for (const path of ['package.json', 'package-lock.json', 'apps/console-receiver/index.html', 'apps/console-receiver/build.mjs', 'apps/console-receiver/serve.mjs', 'apps/console-receiver/README.md', 'apps/console-receiver/qa/source.html', 'tools/qa-console-receiver.mjs', 'tests/console-receiver.test.ts', ...readdirSync(join(app, 'windows')).map(name => 'apps/console-receiver/windows/' + name)]) closure.set(path, hash(readFileSync(join(root, path))));
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  let file = path === '/source.html' ? join(app, 'qa/source.html') : path === '/qa-source.js' ? join(out, 'qa/source.js') : join(out, 'web', path === '/' ? 'index.html' : path);
  file = resolve(file);
  if (![join(app, 'qa/source.html'), join(out, 'qa/source.js')].includes(file) && !file.startsWith(join(out, 'web') + '/')) { response.writeHead(404).end(); return; }
  try { response.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript'); response.end(readFileSync(file)); }
  catch { response.writeHead(404).end(); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${server.address().port}`, receipts = [];
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true }), context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    try {
      const receiver = await context.newPage(), source = await context.newPage(), errors = [], foreign = [];
      for (const page of [receiver, source]) { page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (!request.url().startsWith(origin + '/')) foreign.push(request.url()); });
        await page.addInitScript(() => { const Native = RTCPeerConnection; globalThis.__consolePeers = []; globalThis.RTCPeerConnection = class extends Native { constructor(config) { super(config); globalThis.__consolePeers.push(this); } }; }); }
      await receiver.clock.install();
      await receiver.goto(origin); await source.goto(origin + '/source.html');
      const click = async (page, selector) => { await page.locator(selector).focus(); await page.keyboard.press('Space'); };
      const active = () => receiver.locator('#surface').getAttribute('data-active');
      const empty = async () => { assert.equal(await active(), 'false'); assert.equal(await receiver.locator('#pointer').isVisible(), false); };
      const pair = async () => {
        await click(receiver, '#invite'); await receiver.waitForFunction(() => document.querySelector('#invitation').value.length > 0);
        const invitation = await receiver.locator('#invitation').inputValue();
        await source.locator('#invitation').fill(invitation); await click(source, '#review');
        assert.match(await source.locator('#scope').innerText(), /^101-console-pointer-surface\nconsole-[0-9a-f]{32}$/);
        await click(source, '#connect');
        await source.waitForFunction(() => document.querySelector('#offer').value.length > 0);
        await receiver.locator('#offer').fill(await source.locator('#offer').inputValue()); await click(receiver, '#use-offer');
        await receiver.waitForFunction(() => document.querySelector('#answer').value.length > 0);
        await source.locator('#answer').fill(await receiver.locator('#answer').inputValue()); await click(source, '#use-answer');
        await receiver.waitForFunction(() => document.querySelector('#comparison').value.length === 64);
        await source.waitForFunction(() => document.querySelector('#comparison').value.length === 64);
        assert.equal(await source.locator('#comparison').inputValue(), await receiver.locator('#comparison').inputValue());
      };
      await empty(); assert.equal(await receiver.locator('#allow').isDisabled(), true);
      await click(receiver, '#invite'); await click(receiver, '#stop'); await receiver.waitForTimeout(100); await empty();
      assert.equal(await receiver.locator('#invitation').inputValue(), '', 'late crypto result cannot restore a stopped request');
      await pair(); await empty(); assert.equal(await receiver.locator('#allow').isDisabled(), true);
      await click(source, '#confirm'); await empty(); assert.equal(await receiver.locator('#allow').isDisabled(), true);
      await click(receiver, '#confirm'); await receiver.locator('#allow').waitFor({ state: 'visible' });
      await receiver.waitForFunction(() => !document.querySelector('#allow').disabled); await empty();
      assert.equal(await source.locator('#move').isDisabled(), true, 'verified connection does not grant resources');
      await click(receiver, '#allow'); await source.waitForFunction(() => !document.querySelector('#move').disabled);
      await click(source, '#move'); await receiver.waitForFunction(() => !document.querySelector('#pointer').hidden && parseFloat(document.querySelector('#pointer').style.left) > document.querySelector('#surface').clientWidth * .55);
      await click(source, '#press'); await receiver.waitForFunction(() => document.querySelector('#surface').dataset.contact === 'true');
      await receiver.setViewportSize({ width: 390, height: 900 });
      await receiver.waitForFunction(() => document.documentElement.scrollWidth <= 390);
      await receiver.screenshot({ path: join(evidence, `receiver-${engine.name()}.png`), fullPage: true });
      await click(receiver, '#stop'); await empty();
      assert.equal(await receiver.locator('#surface').getAttribute('data-contact'), 'false');
      assert.equal(await receiver.evaluate(() => globalThis.__consolePeers.every(peer => peer.connectionState === 'closed')), true);
      await click(source, '#stop'); await receiver.setViewportSize({ width: 1100, height: 900 });
      await pair(); await click(source, '#confirm'); await click(receiver, '#confirm'); await receiver.waitForFunction(() => !document.querySelector('#allow').disabled);
      await click(receiver, '#allow'); await source.waitForFunction(() => !document.querySelector('#press').disabled); await click(source, '#press');
      await receiver.waitForFunction(() => document.querySelector('#surface').dataset.contact === 'true');
      await receiver.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
      await empty(); assert.equal(await receiver.locator('#surface').getAttribute('data-contact'), 'false');
      await receiver.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
      await empty(); assert.equal(await receiver.locator('#invitation').inputValue(), '', 'visibility recovery never reconnects');
      await click(source, '#stop'); await receiver.reload();
      await pair(); await click(source, '#confirm'); await click(receiver, '#confirm'); await receiver.waitForFunction(() => !document.querySelector('#allow').disabled);
      await click(receiver, '#allow'); await source.waitForFunction(() => !document.querySelector('#press').disabled); await click(source, '#press');
      await receiver.waitForFunction(() => document.querySelector('#surface').dataset.contact === 'true'); await click(source, '#stop');
      await receiver.waitForFunction(() => document.querySelector('#surface').dataset.active === 'false'); await empty();
      assert.equal(await receiver.locator('#surface').getAttribute('data-contact'), 'false');
      await receiver.reload();
      await pair(); await click(source, '#confirm'); await click(receiver, '#confirm'); await receiver.waitForFunction(() => !document.querySelector('#allow').disabled);
      await click(receiver, '#allow'); await source.waitForFunction(() => !document.querySelector('#press').disabled); await click(source, '#press');
      await receiver.waitForFunction(() => document.querySelector('#surface').dataset.contact === 'true');
      await receiver.clock.fastForward(60001); await empty(); assert.equal(await receiver.locator('#surface').getAttribute('data-contact'), 'false');
      await click(source, '#stop'); await receiver.reload();
      await click(receiver, '#invite'); await receiver.waitForFunction(() => document.querySelector('#invitation').value.length > 0);
      await receiver.locator('#offer').fill('invalid complete offer'); await click(receiver, '#use-offer'); await empty();
      await click(receiver, '#invite'); await receiver.waitForFunction(() => document.querySelector('#invitation').value.length > 0); await click(receiver, '#cancel'); await empty();
      assert.equal(await receiver.locator('#invitation').inputValue(), '');
      await click(receiver, '#invite'); await receiver.waitForFunction(() => document.querySelector('#invitation').value.length > 0);
      await receiver.clock.fastForward(300001); await empty(); assert.match(await receiver.locator('#status').innerText(), /expired/);
      await receiver.goto('about:blank');
      assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
      receipts.push({ engine: engine.name(), version: browser.version(), status: 'pass', checks: ['inert-before-invitation', 'stale-identity-result-cancelled', 'actual-native-RTC-offer-answer', 'exact-application-session-review', 'both-owner-comparison', 'separate-resource-denial-and-grant', 'actual-owned-DOM-pointer-contact', 'keyboard-approval', 'responsive-layout', 'stop-closes-native-peers-and-clears-held-input', 'hidden-stop-and-no-auto-reconnect', 'source-disconnect-releases-held-input', 'connection-one-minute-expiry', 'invalid-offer-denied', 'cancel-clears-request', 'invitation-expiry'] });
    } finally { await context.close(); await browser.close(); }
  }
  const artifacts = {};
  function collect(dir) { for (const name of readdirSync(dir)) { const file = join(dir, name); if (statSync(file).isDirectory()) collect(file); else artifacts[relative(root, file)] = hash(readFileSync(file)); } }
  collect(join(out, 'web'));
  const receipt = { status: 'pass', toolchain: { node: process.version, vite: viteVersion }, sourceSha256: Object.fromEntries([...closure].sort(([a], [b]) => a.localeCompare(b))), artifacts, receipts,
    methods: { expiry: 'Playwright clock fastForward', visibility: 'document.hidden shadow plus synthetic visibilitychange event' },
    scope: 'Actual local desktop browser WebRTC, cryptography and application-only pointer effects; expiry clock and synthetic visibility-handler checks. No natural-time expiry observation, native OS suspension, Windows UWP compilation, Xbox runtime, console controller navigation, LAN or physical qualification.' };
  writeFileSync(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify(receipt, null, 2));
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
