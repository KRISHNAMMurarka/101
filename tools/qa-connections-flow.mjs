import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, webkit } from 'playwright';

const application = new URL(process.argv[2]);
assert.ok(application.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(application.hostname) && !application.username && !application.password && application.pathname === '/' && !application.search && !application.hash);
const output = await mkdtemp(path.join(tmpdir(), '101-connections-flow-'));
const ownPaths = ['app/connections/page.tsx', 'app/connections/ConnectionsView.tsx', 'app/connections/connection-task.ts', 'app/connections/connection-task.test.ts', 'app/connections/connections.module.css', 'tools/qa-connections-flow.mjs'];
const hashes = {};
for (const file of ownPaths) hashes[file] = createHash('sha256').update(await readFile(file)).digest('hex');
const dependencyHashes = {};
async function pin(directory) { for (const entry of await readdir(directory, { withFileTypes: true })) {
  assert.ok(!entry.isSymbolicLink()); const file = path.join(directory, entry.name);
  if (entry.isDirectory()) await pin(file); else if (entry.isFile() && /\.(ts|tsx)$/.test(file) && !file.endsWith('.test.ts')) {
    assert.ok(Object.keys(dependencyHashes).length < 1024); dependencyHashes[file] = createHash('sha256').update(await readFile(file)).digest('hex');
  }
} }
for (const name of ['connect', 'device-model', 'device-runtime', 'device-web', 'transport-webrtc', 'transport-websocket', 'protocol']) await pin(`packages/${name}/src`);
const results = [];
const availableEngines = [['chromium', chromium], ['webkit', webkit]];
assert.ok(process.env.U03_ENGINE === undefined || ['chromium', 'webkit'].includes(process.env.U03_ENGINE));
const engines = availableEngines.filter(([name]) => name === (process.env.U03_ENGINE ?? 'chromium'));
async function condition(page, callback, arg, timeout = 6000) { await page.waitForFunction(callback, arg, { timeout }); }
async function click(page, name) { await page.getByRole('button', { name, exact: true }).click(); }
async function exchange(receiver, source) {
  await click(receiver, 'Create invitation'); await receiver.locator('#outgoing-connection-code').waitFor();
  const invitation = await receiver.locator('#outgoing-connection-code').inputValue(); assert.ok(invitation.startsWith('101-connection-1.'));
  await source.locator('#incoming-connection-code').fill(invitation); await click(source, 'Review invitation');
  await click(source, 'Continue to this screen'); await source.locator('#outgoing-connection-code').waitFor();
  const offer = await source.locator('#outgoing-connection-code').inputValue();
  await receiver.locator('#incoming-connection-code').fill(offer); await click(receiver, 'Use reply');
  await condition(receiver, original => document.querySelector('#outgoing-connection-code')?.value !== original, invitation, 10000);
  const answer = await receiver.locator('#outgoing-connection-code').inputValue();
  await source.locator('#incoming-connection-code').fill(answer); await click(source, 'Use reply');
  for (const page of [receiver, source]) await page.getByRole('button', { name: 'The codes match', exact: true }).waitFor({ timeout: 10000 });
  assert.equal(await receiver.getByLabel('Matching code', { exact: true }).innerText(), await source.getByLabel('Matching code', { exact: true }).innerText());
  await click(receiver, 'The codes match'); await click(source, 'The codes match');
  return { invitation, offer, answer };
}
for (const [name, engine] of engines) {
  const browser = await engine.launch(); const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const errors = []; let checks = 0; let lifetimeContext;
  try {
    const receiver = await context.newPage(), source = await context.newPage();
    for (const page of [receiver, source]) {
      page.on('pageerror', error => errors.push(error.message));
      const response = await page.goto(new URL('/connections', application).toString());
      assert.equal(response.status(), 200, 'a real player connection task must exist before source/output consent can be used');
      await page.getByRole('heading', { name: 'Connect an input', exact: true }).waitFor();
      await condition(page, () => !document.querySelector('fieldset').disabled);
      assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })), { local: 0, session: 0 }); checks++;
    }
    await receiver.getByRole('button', {name:'Receive input',exact:true}).focus(); await receiver.keyboard.press('Tab'); await receiver.keyboard.press('Shift+Tab'); await receiver.getByRole('button', {name:'Receive input',exact:true}).focus();
    assert.equal(await receiver.getByRole('button', {name:'Receive input',exact:true}).evaluate(element => getComputedStyle(element).outlineColor === getComputedStyle(element.closest('main')).color), true, `${name} selected role focus uses the page foreground`); checks++;
    await click(receiver, 'Create invitation'); await receiver.getByRole('button', {name:'Cancel new connection',exact:true}).focus(); await receiver.keyboard.press('Enter');
    await condition(receiver, () => document.activeElement.getAttribute('role') === 'status'); checks++;
    await click(source, 'Send input');
    await source.locator('#incoming-connection-code').fill('https://unrelated.invalid/'); await click(source, 'Review invitation');
    await source.getByText('That code cannot be used here.', { exact: false }).waitFor(); assert.equal(await receiver.locator('[data-effects]').getAttribute('data-effects'), '0'); checks++;
    const codes = await exchange(receiver, source); checks++;
    assert.equal(await receiver.locator('[data-effects]').getAttribute('data-effects'), '0');
    assert.equal(await source.getByRole('button', { name: 'Input pad', exact: true }).isDisabled(), true); checks++;
    await click(source, 'Allow input sharing');
    await condition(receiver, () => [...document.querySelectorAll('button')].find(element => element.textContent === 'Allow surface control')?.disabled === false);
    assert.equal(await receiver.locator('[data-effects]').getAttribute('data-effects'), '0');
    assert.equal(await source.getByRole('button', { name: 'Input pad', exact: true }).isDisabled(), true); checks++;
    await click(receiver, 'Allow surface control');
    await condition(source, () => document.querySelector('button[aria-label="Input pad"]')?.disabled === false);
    await condition(receiver, () => Number(document.querySelector('[data-effects]').dataset.effects) > 0);
    const pad = source.getByRole('button', { name: 'Input pad', exact: true }); await pad.focus(); await source.keyboard.press('ArrowRight');
    await condition(receiver, () => parseFloat(document.querySelector('[class*="marker"]')?.style.left ?? 'NaN') > 50); checks++;
    assert.equal(await pad.evaluate(element => element.matches(':focus-visible') && getComputedStyle(element).outlineStyle === 'solid'), true); checks++;
    await source.keyboard.down('Space'); await condition(receiver, () => document.querySelector('[data-effects]').dataset.held === 'true'); checks++;
    await source.keyboard.up('Space'); await condition(receiver, () => document.querySelector('[data-effects]').dataset.held === 'false'); checks++;
    await source.keyboard.press('Enter'); await condition(receiver, () => document.querySelector('[data-effects]').dataset.held === 'true');
    assert.equal(await pad.getAttribute('aria-pressed'), 'true'); checks++;
    await source.keyboard.press('Enter'); await condition(receiver, () => document.querySelector('[data-effects]').dataset.held === 'false');
    assert.equal(await pad.getAttribute('aria-pressed'), 'false'); checks++;
    await pad.evaluate(element => element.click()); await condition(receiver, () => document.querySelector('[data-effects]').dataset.held === 'true'); checks++;
    await source.keyboard.press('Escape'); await condition(receiver, () => document.querySelector('[data-effects]').dataset.held === 'false'); checks++;
    const box = await pad.boundingBox(); assert.ok(box);
    await source.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await source.mouse.down();
    await condition(receiver, () => document.querySelector('[data-effects]').dataset.held === 'true');
    await source.mouse.up(); await condition(receiver, () => document.querySelector('[data-effects]').dataset.held === 'false');
    await receiver.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await receiver.locator('[data-effects]').getAttribute('data-held'), 'false');
    assert.equal(await pad.getAttribute('aria-pressed'), 'false'); checks++;
    // A new invitation leaves the incumbent effect route live; cancellation does not grant or replace it.
    await click(receiver, 'Replace connection'); await receiver.locator('#incoming-connection-code').fill('bad reply'); await click(receiver, 'Use reply');
    await receiver.getByText('That code cannot be used here.', { exact: false }).waitFor();
    await pad.focus(); await source.keyboard.press('ArrowLeft'); await condition(receiver, () => parseFloat(document.querySelector('[class*="marker"]')?.style.left ?? 'NaN') <= 50); checks++;
    await click(receiver, 'Cancel new connection'); await receiver.getByText('Connected for up to one minute. Stop releases the input.', {exact:true}).waitFor(); assert.equal(await receiver.getByRole('heading', { name: 'Input connected', exact: true }).count(), 1); checks++;
    await receiver.screenshot({ path: path.join(output, `${name}-active.png`), fullPage: true });
    await pad.focus(); await source.keyboard.down('Space'); await condition(receiver, () => document.querySelector('[data-effects]').dataset.held === 'true');
    await click(source, 'Stop connection'); await source.keyboard.up('Space');
    await condition(receiver, () => document.querySelector('[data-effects]').dataset.held === 'false' && !document.querySelector('[class*="marker"]'));
    await receiver.getByText('The connection ended. Check that both screens are open, then start a fresh connection.', { exact: true }).waitFor({ timeout: 6000 });
    const stoppedEffects = Number(await receiver.locator('[data-effects]').getAttribute('data-effects'));
    await pad.evaluate(element => element.click()); await source.keyboard.press('Enter'); await source.keyboard.press('ArrowRight');
    await receiver.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(Number(await receiver.locator('[data-effects]').getAttribute('data-effects')), stoppedEffects); checks++;
    // An explicit retry requires a new exchange and both owners, with old codes rejected.
    await click(receiver, 'Create invitation'); const fresh = await receiver.locator('#outgoing-connection-code').inputValue(); assert.notEqual(fresh, codes.invitation);
    await receiver.locator('#incoming-connection-code').fill(codes.offer); await click(receiver, 'Use reply');
    await receiver.getByText('That code cannot be used here.', { exact: false }).waitFor(); checks++;
    await click(receiver, 'Cancel new connection');
    await exchange(receiver, source); await click(source, 'Allow input sharing'); await click(receiver, 'Allow surface control');
    await condition(source, () => document.querySelector('button[aria-label="Input pad"]')?.disabled === false); await pad.focus(); await source.keyboard.press('ArrowRight');
    await condition(receiver, () => !!document.querySelector('[class*="marker"]')); checks++;
    await source.close(); await condition(receiver, () => document.querySelector('[data-effects]').dataset.held === 'false' && !document.querySelector('[class*="marker"]')); checks++;
    // Reachable narrow layout, native keyboard focus, and reduced-motion policy.
    await receiver.setViewportSize({ width: 390, height: 844 }); await receiver.emulateMedia({ reducedMotion: 'reduce' });
    for (const scheme of ['light','dark']) {
      await receiver.emulateMedia({ colorScheme: scheme });
      await condition(receiver, scheme => getComputedStyle(document.body).backgroundColor === (scheme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(10, 10, 10)'), scheme);
      const colors = await receiver.locator('h1').evaluate(element => ({text:getComputedStyle(element).color,background:getComputedStyle(document.body).backgroundColor}));
      const luminance = color => { const rgb=color.match(/\d+/g).slice(0,3).map(Number).map(value => value/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722; };
      const values=[luminance(colors.text),luminance(colors.background)].sort((a,b)=>a-b);
      assert.ok((values[1]+.05)/(values[0]+.05)>=4.5,`${name} ${scheme} readable text`); checks++;
    }
    await receiver.emulateMedia({colorScheme:'light'});
    assert.equal(await receiver.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const sizes = await receiver.locator('main button,main a').evaluateAll(elements => elements.map(element => { const r=element.getBoundingClientRect(); return {label:element.textContent,width:r.width,height:r.height}; }).filter(size => size.width > 0 && size.height > 0));
    assert.ok(sizes.length >= 3); assert.ok(sizes.every(size => size.width >= 44 && size.height >= 44), JSON.stringify(sizes));
    await receiver.getByRole('button', { name: 'Create invitation', exact: true }).focus(); await receiver.keyboard.press('ArrowRight');
    const focus = await receiver.evaluate(() => ({tag:document.activeElement.tagName,text:document.activeElement.tagName === 'BODY' ? '' : document.activeElement.textContent?.slice(0,80),visible:document.activeElement.matches(':focus-visible'),outline:getComputedStyle(document.activeElement).outlineStyle}));
    assert.deepEqual(focus, {tag:'BUTTON',text:'Create invitation',visible:true,outline:'solid'}); checks++;
    await receiver.screenshot({ path: path.join(output, `${name}-recovery-mobile.png`), fullPage: true });
    const unsupported = await context.newPage(); await unsupported.addInitScript(() => { Object.defineProperty(globalThis, 'RTCPeerConnection', { value: undefined }); });
    unsupported.on('pageerror', error => errors.push(error.message)); await unsupported.goto(new URL('/connections', application).toString());
    await click(unsupported, 'Create invitation'); await unsupported.getByText('This browser cannot make this connection.', { exact: false }).waitFor();
    assert.equal(await unsupported.locator('#outgoing-connection-code').count(), 0); await unsupported.close(); checks++;
    // Actual native producer with an injected host clock proves quiet expiry, rather than a successful fake backend.
    await receiver.close();
    await context.close(); lifetimeContext = await browser.newContext();
    const directReceiver = await lifetimeContext.newPage(), directSource = await lifetimeContext.newPage();
    for (const [page, role] of [[directReceiver, 'receiver'], [directSource, 'source']]) {
      page.on('pageerror', error => errors.push(error.message)); await page.goto(new URL('/connections', application).toString()); await page.evaluate(async role => {
        const { createConnectionTask } = await import('/app/connections/connection-task.ts');
        globalThis.clockOffset = 0; globalThis.descriptions = 0;
        globalThis.connectionTask = createConnectionTask({ role, now: () => performance.now()+globalThis.clockOffset, wallNow: () => Date.now(),
          createPeer: role === 'receiver' ? configuration => {
            const peer = new RTCPeerConnection(configuration);
            peer.addEventListener('datachannel', event => event.channel.addEventListener('message', event => {
              if (typeof event.data === 'string') { try { const packet=JSON.parse(event.data); if(packet.protocol==='connect' && packet.type==='describe') globalThis.descriptions++; } catch { /* Observation cannot alter the native packet. */ } }
            })); return peer;
          } : undefined });
        globalThis.connectionTimer = setInterval(() => globalThis.connectionTask.tick(),16);
      }, role);
    }
    const invitation = await directReceiver.evaluate(async () => { await globalThis.connectionTask.beginReceive(); return globalThis.connectionTask.snapshot().code; });
    const offer = await directSource.evaluate(async invitation => { if (!globalThis.connectionTask.review(invitation)) throw Error('review'); if (!await globalThis.connectionTask.beginSend()) throw Error('offer'); return globalThis.connectionTask.snapshot().code; }, invitation);
    const answer = await directReceiver.evaluate(async offer => { if (!await globalThis.connectionTask.useCode(offer)) throw Error('answer'); return globalThis.connectionTask.snapshot().code; }, offer);
    assert.equal(await directSource.evaluate(answer => globalThis.connectionTask.useCode(answer), answer), true);
    for (const page of [directReceiver, directSource]) await condition(page, () => !!globalThis.connectionTask.snapshot().comparison);
    assert.equal(await directReceiver.evaluate(() => globalThis.connectionTask.snapshot().comparison), await directSource.evaluate(() => globalThis.connectionTask.snapshot().comparison));
    await directReceiver.evaluate(() => clearInterval(globalThis.connectionTimer));
    assert.equal(await directReceiver.evaluate(() => globalThis.connectionTask.confirm()), true);
    assert.equal(await directSource.evaluate(() => globalThis.connectionTask.confirm()), true);
    for (const page of [directReceiver, directSource]) await condition(page, () => globalThis.connectionTask.snapshot().verified);
    assert.equal(await directReceiver.evaluate(() => globalThis.connectionTask.allowOutput()), false);
    assert.equal(await directReceiver.evaluate(() => globalThis.connectionTask.snapshot().effects), 0); checks++;
    assert.equal(await directSource.evaluate(() => globalThis.connectionTask.allowSource()), true);
    await condition(directReceiver, () => globalThis.descriptions === 1);
    assert.equal(await directReceiver.evaluate(() => globalThis.connectionTask.snapshot().compatible), true);
    await directReceiver.evaluate(() => { globalThis.connectionTimer = setInterval(() => globalThis.connectionTask.tick(),16); }); checks++;
    assert.equal(await directReceiver.evaluate(() => globalThis.connectionTask.snapshot().effects), 0);
    assert.equal(await directReceiver.evaluate(() => globalThis.connectionTask.allowOutput()), true);
    for (const page of [directReceiver, directSource]) await condition(page, () => globalThis.connectionTask.snapshot().active);
    const issued = await directSource.evaluate(() => globalThis.connectionTask.press(true));
    try { assert.equal(issued, true); await condition(directReceiver, () => globalThis.connectionTask.snapshot().held); }
    catch { const states = []; for (const page of [directReceiver,directSource]) states.push(await page.evaluate(() => { const state=globalThis.connectionTask.snapshot(); return {phase:state.phase,active:state.active,held:state.held,effects:state.effects,sourceAllowed:state.sourceAllowed,outputAllowed:state.outputAllowed,rawPending:state.rawPending,visible:document.visibilityState}; })); throw Error(`${name} real held-input check failed: ${JSON.stringify(states)}`); } checks++;
    await directReceiver.evaluate(() => { globalThis.clockOffset = 60001; });
    await condition(directReceiver, () => globalThis.connectionTask.snapshot().phase === 'expired');
    assert.deepEqual(await directReceiver.evaluate(() => { const state = globalThis.connectionTask.snapshot(); return {held:state.held,active:state.active,position:state.position ?? null,grant:state.outputAllowed}; }), {held:false,active:false,position:null,grant:false});
    assert.equal(await directReceiver.evaluate(() => globalThis.connectionTask.allowOutput()), false); checks++;
    for (const page of [directReceiver,directSource]) { await page.evaluate(() => { clearInterval(globalThis.connectionTimer); globalThis.connectionTask.close(); }); await page.close(); }
    results.push({ engine: name, version: browser.version(), checks, pageErrors: errors }); assert.deepEqual(errors, []);
  } finally { await lifetimeContext?.close(); await context.close(); await browser.close(); }
}
await writeFile(path.join(output, 'receipt.json'), JSON.stringify({ profile: 'authenticated-pointer-task/1', scope: 'application-owned pointer surface, manual session-only native WebRTC/P256; no OS cursor, account/device identity, relay, physical networks or phone claim', sourceHashes: hashes, dependencyHashes, node: process.version, results }, null, 2));
console.log(JSON.stringify({ output, results }));
