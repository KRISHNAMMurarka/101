import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { codeValue, compareAndEnroll, createLocalIdentity, exchangeOffer, keyboardClick, observeActualPeers, reviewTarget } from './qa-enrollment-ui.mjs';

const origin = new URL(process.argv[2]);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || origin.protocol !== 'http:') throw new Error('Use an owned loopback server');
const files = ['app/lib/connection-ownership.ts', 'app/pointer-lab/PointerLab.tsx', 'app/components/RemotePointerPanel.tsx', 'tools/qa-pointer-ownership.mjs'];
const sourceSha256 = Object.fromEntries(files.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
const results = [];
for (const engine of [chromium, webkit]) {
  const browser = await engine.launch({ headless: true });
  try {
    for (const game of [false, true]) {
      const contexts = [], errors = [], foreign = [];
      try {
        for (let index = 0; index < 3; index++) {
          const context = await browser.newContext({ viewport: { width: 1280, height: 1100 }, reducedMotion: 'reduce' });
          contexts.push(context); await observeActualPeers(context);
          await context.route('**/*', route => {
            if (new URL(route.request().url()).origin !== origin.origin) { foreign.push(route.request().url()); return route.abort(); }
            return route.continue();
          });
        }
        const pages = await Promise.all(contexts.map(context => context.newPage()));
        const [receiver, first, second] = pages;
        for (const page of pages) page.on('pageerror', error => errors.push(error.message));
        if (game) await contexts[0].addInitScript(() => {
          const arc = CanvasRenderingContext2D.prototype.arc;
          CanvasRenderingContext2D.prototype.arc = function (x, y, radius, ...rest) {
            if (radius === 13 && this.canvas.getAttribute('aria-label')?.startsWith('Interactive 101 input test arena')) this.canvas.dataset.qaAimX = String(x);
            return arc.call(this, x, y, radius, ...rest);
          };
        });
        await Promise.all(pages.map((page, index) => page.goto(new URL(game && index === 0 ? '/studio/input' : '/pointer-lab', origin).href)));
        await Promise.all(pages.map(page => page.waitForLoadState('networkidle')));
        if (game) await receiver.getByText('Remote pointer resources', { exact: true }).click();
        for (const source of [first, second]) {
          await keyboardClick(source, source.getByRole('button', { name: 'Send pointer', exact: true }));
          await createLocalIdentity(source, '101.endpoint-identity.v1:pointer-source');
        }
        await createLocalIdentity(receiver, game ? '101.endpoint-identity.v1:input-lab-receiver' : '101.endpoint-identity.v1:pointer-receiver');
        const invitation = game ? '#input-lab-pointer-invitation' : '#receiver-invitation-code';
        const offer = game ? '#input-lab-pointer-offer' : '#remote-pointer-code';
        const answer = game ? '#input-lab-pointer-answer' : '#local-pointer-code';
        const comparison = game ? '#input-lab-pointer-comparison' : '#endpoint-comparison-code';
        const firstAllow = game ? 'Allow aim and trigger for one minute' : 'Allow pointer for one minute';
        const transfer = game ? 'Transfer aim and trigger for one minute' : 'Transfer pointer for one minute';
        const create = async () => {
          const button = receiver.getByRole('button', { name: 'Create invitation', exact: true });
          if (!await button.isVisible()) await receiver.getByText('Local pairing', { exact: true }).click();
          await keyboardClick(receiver, button);
        };
        const cancel = () => keyboardClick(receiver, receiver.getByRole('button', { name: 'Cancel new request', exact: true }));
        async function coordinate() {
          if (!game) return receiver.getByTestId('application-pointer').evaluate(element => Number.parseFloat(element.style.left) / element.parentElement.clientWidth);
          return receiver.locator('canvas[aria-label^="Interactive 101 input test arena"]').evaluate(canvas => Number(canvas.dataset.qaAimX) / (canvas.width / devicePixelRatio));
        }
        async function move(source) {
          await keyboardClick(source, source.getByRole('button', { name: 'Right', exact: true }));
        }
        async function alive() {
          const before = await coordinate(); await move(first);
          await assertEventually(async () => assert.ok((await coordinate()) > before + 0.01, 'Current owner continues delivering while another request is pending'));
        }
        async function prepare(source, allowName, check) {
          await create(); await reviewTarget(source, await codeValue(receiver, invitation));
          await exchangeOffer(source, receiver, offer, answer);
          const allow = receiver.getByRole('button', { name: allowName, exact: true });
          await compareAndEnroll(source, receiver, comparison, allow, check); return allow;
        }
        const allow = await prepare(first, firstAllow, async () => {
          if (!game) assert.equal(await receiver.getByTestId('application-pointer').count(), 0);
        });
        await keyboardClick(receiver, allow); await waitReady(first);
        await move(first);
        await assertEventually(async () => assert.ok((await coordinate()) > 0.51));
        if (!game) await receiver.getByText('Local pairing', { exact: true }).click();
        await create(); await alive(); await cancel(); await alive();
        await create(); await receiver.locator(offer).fill('invalid complete offer');
        await keyboardClick(receiver, receiver.getByRole('button', { name: 'Use offer', exact: true }));
        await alive();
        await prepare(second, transfer, alive); await alive(); await cancel(); await alive();
        await keyboardClick(second, second.getByRole('button', { name: 'Stop', exact: true }));
        const transferButton = await prepare(second, transfer, alive);
        await keyboardClick(receiver, transferButton); await waitReady(second);
        await first.waitForFunction(() => document.querySelector('[aria-label^="Touch pad"]')?.dataset.ready === 'false');
        await move(second); await assertEventually(async () => assert.ok((await coordinate()) > 0.51));
        assert.equal(await first.getByRole('button', { name: 'Right', exact: true }).isDisabled(), true);
        await keyboardClick(receiver, receiver.getByRole('button', { name: game ? 'Stop remote pointer' : 'Stop', exact: true }));
        await second.waitForFunction(() => document.querySelector('[aria-label^="Touch pad"]')?.dataset.ready === 'false');
        if (!game) assert.equal(await receiver.getByTestId('application-pointer').count(), 0);
        for (const page of pages) {
          if (page === receiver && game) {
            await page.getByRole('button', { name: '← Games', exact: true }).click(); await page.waitForURL(origin.origin + '/');
          } else {
            await page.getByRole('link', { name: '101 Studio', exact: true }).click(); await page.waitForURL('**/studio');
          }
          assert.equal(await page.evaluate(() => window.__qaPointerPeers.every(peer => peer.connectionState === 'closed')), true, 'Unmount closes all actual candidate and owner peer connections');
        }
        assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
        results.push({ engine: engine.name(), version: browser.version(), surface: game ? 'game-pointer' : 'independent-pointer',
          invitationRetainsOwner: true, invalidOfferRetainsOwner: true, verifiedCandidateRetainsOwner: true,
          cancelRetainsOwner: true, explicitTransferReleasesPrevious: true, stoppedAndUnmountedPeersClosed: true, pageErrors: 0, foreignRequests: 0 });
      } finally { await Promise.all(contexts.map(context => context.close())); }
    }
  } finally { await browser.close(); }
}
console.log(JSON.stringify({ outcome: 'passed', sourceSha256, results, scope: 'Owned loopback native browser RTC, crypto, IndexedDB and application effects. No phone, account identity, OS pointer or physical input claim.' }, null, 2));

async function waitReady(page) {
  await page.waitForFunction(() => document.querySelector('[aria-label^="Touch pad"]')?.dataset.ready === 'true');
}
async function assertEventually(check) {
  const deadline = Date.now() + 5000;
  while (true) {
    try { await check(); return; } catch (error) { if (Date.now() >= deadline) throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
