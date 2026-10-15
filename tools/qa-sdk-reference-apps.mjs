import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync, lstatSync, mkdtempSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { chromium, webkit } from 'playwright';
import { generateReferenceApps, readReferenceSdk, REFERENCE_APP_IDS } from './generate-sdk-reference-apps.mjs';

const args = process.argv.slice(2);
assert.ok(args.length >= 3 && args.length <= 7 && args.length % 2 === 1 && args[0] === '--installed', 'Use --installed <manifest> <clean-consumer> [--caller-tree <immutable-tree>] [--application <id>]');
const options = new Map();
for (let index = 3; index < args.length; index += 2) { assert.ok(['--caller-tree', '--application'].includes(args[index]) && !options.has(args[index])); options.set(args[index], args[index + 1]); }
const selectedApplication = options.get('--application');
assert.ok(selectedApplication === undefined || REFERENCE_APP_IDS.includes(selectedApplication));
assert.equal(process.version, 'v24.14.0');
const root = realpathSync(resolve(import.meta.dirname, '..')), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const owned = ['examples/reference-apps/applications.ts', 'tests/reference-apps.test.ts', 'tools/generate-sdk-reference-apps.mjs', 'tools/qa-sdk-reference-apps.mjs', 'tools/sdk-browser-inventory.mjs'];
const callerPins = Object.fromEntries(owned.map(path => [path, hash(readFileSync(join(root, path)))]));
const sdk = readReferenceSdk(args[1], args[2]), sourceTree = sdk.manifest.source.tree, dependencyPins = sdk.manifest.source.sha256, callerTree = options.get('--caller-tree');
assert.ok(Object.keys(dependencyPins).length > 0 && Object.keys(dependencyPins).length <= 512);
const queries = Object.keys(dependencyPins).map(path => { assert.ok(!path.startsWith('/') && !path.split('/').includes('..')); return sourceTree + ':' + path; });
if (callerTree) { assert.match(callerTree, /^[0-9a-f]{40}$/); owned.forEach(path => queries.push(callerTree + ':' + path)); }
for (const key of queries) assert.match(key, /^[0-9a-f]{40}:[A-Za-z0-9_./-]+$/);
const blobBytes = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input: queries.join('\n') + '\n', timeout: 5000, maxBuffer: 33554432 });
const immutablePins = new Map(); let cursor = 0;
for (const key of queries) { const end = blobBytes.indexOf(10, cursor); assert.ok(end >= cursor && end - cursor <= 128); const header = blobBytes.subarray(cursor, end).toString('ascii').match(/^[0-9a-f]{40} blob ([0-9]+)$/); assert.ok(header);
  const size = Number(header[1]); assert.ok(Number.isSafeInteger(size) && size >= 0 && size <= 1048576); const first = end + 1, last = first + size; assert.ok(last < blobBytes.byteLength); assert.equal(blobBytes[last], 10); immutablePins.set(key, hash(blobBytes.subarray(first, last))); cursor = last + 1; }
assert.equal(cursor, blobBytes.byteLength);
for (const [path, pin] of Object.entries(dependencyPins)) assert.equal(immutablePins.get(sourceTree + ':' + path), pin, 'Immutable actual SDK source: ' + path);
if (callerTree) for (const [path, pin] of Object.entries(callerPins)) assert.equal(immutablePins.get(callerTree + ':' + path), pin, 'Immutable reference caller: ' + path);
const tarballPins = {};
for (const item of sdk.manifest.packages) { const stat = lstatSync(item.tarball); assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.isFile(), true); assert.ok(stat.size <= 8388608); const value = readFileSync(item.tarball); assert.equal(value.byteLength, item.bytes); assert.equal(hash(value), item.sha256); tarballPins[item.tarball] = item.sha256;
  const listed = execFileSync('tar', ['-tzf', item.tarball], { encoding: 'utf8', timeout: 5000, maxBuffer: 1048576 }).trim().split('\n'); assert.ok(listed.every(path => path.startsWith('package/') && !path.split('/').includes('..'))); assert.deepEqual(listed.filter(path => !path.endsWith('/')).map(path => path.slice(8)).sort(), item.files.map(file => file.path).sort()); }
const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_PATH;
function run(program, options = {}) {
  return new Promise((yes, no) => { const child = spawn(process.execPath, [program], { env, stdio: ['ignore', 'pipe', 'pipe'], ...options }); let stdout = '', stderr = '', failed, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 5000);
    function collect(kind, bytes) { if (kind === 'stdout') stdout += bytes.toString(); else stderr += bytes.toString(); if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 65536) { failed = Error('Owned child output limit'); child.kill('SIGTERM'); } }
    child.stdout.on('data', bytes => collect('stdout', bytes)); child.stderr.on('data', bytes => collect('stderr', bytes)); child.on('error', error => { failed = error; });
    child.on('close', (status, signal) => { clearTimeout(timer); if (failed) no(failed); else if (timedOut) no(Error('Owned child deadline5000ms: ' + signal)); else yes({ status, stdout, stderr }); });
  });
}
function server(project) {
  const child = spawn(process.execPath, [join(project, 'serve.mjs')], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '', stderr = '', ready, resolveReady, rejectReady, failure, closed;
  const promise = new Promise((yes, no) => { resolveReady = yes; rejectReady = no; }); const timer = setTimeout(() => { failure = Error('Owned launcher readiness deadline5000ms'); rejectReady(failure); child.kill('SIGTERM'); }, 5000);
  const settlement = new Promise(resolveClose => child.on('close', (status, signal) => { clearTimeout(timer); closed = { status, signal }; if (!ready) rejectReady(failure ?? Error('Owned launcher exited before ready: ' + stderr)); resolveClose(closed); }));
  child.on('error', error => { failure = error; rejectReady(error); }); child.stdout.on('data', chunk => { output += chunk.toString(); if (Buffer.byteLength(output) > 65536) { failure = Error('Owned launcher output limit'); rejectReady(failure); child.kill('SIGTERM'); return; }
    const first = output.split('\n')[0]; if (!ready && first) { try { const value = JSON.parse(first); assert.equal(value.kind, 'ready'); const url = new URL(value.url); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.protocol, 'http:'); assert.ok(Number(url.port) > 0); ready = value.url; clearTimeout(timer); resolveReady(ready); } catch (error) { failure = error; rejectReady(error); child.kill('SIGTERM'); } } });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); if (Buffer.byteLength(stderr) > 65536) { failure = Error('Owned launcher stderr bound'); child.kill('SIGTERM'); } });
  return { ready: promise, async close() { if (!closed) child.kill('SIGTERM'); const outcome = await settlement; assert.equal(failure, undefined); assert.equal(outcome.status, 0, stderr); assert.equal(stderr, ''); const final = output.trim().split('\n').map(line => JSON.parse(line)).at(-1); assert.deepEqual(final, { kind: 'closed', sockets: 0 }); return outcome; } };
}

async function checkCollaborativeClock(browser, origin) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.clock.install({ time: 0 }); await page.goto(origin); await page.clock.pauseAt(1000);
    await page.evaluate(() => {
      for (const checkbox of document.querySelectorAll('input[type=checkbox]')) checkbox.click();
      const click = name => { const button = [...document.querySelectorAll('button')].find(button => button.textContent === name); if (!button) throw Error(name); button.click(); };
      click('Start'); for (const side of ['left', 'right']) { click('Request ' + side + ' partition'); click('Approve pending request'); }
    });
    const hold = page.getByRole('button', { name: 'Hold contact', exact: true }).nth(0);
    // This explicit software clock reproduces a queued held heartbeat ahead of
    // release. The separate native journey below retains its real browser clock.
    await page.clock.runFor(223); await hold.dispatchEvent('pointerdown', { pointerId: 1 }); await page.clock.runFor(83);
    assert.equal(await page.evaluate(() => globalThis.reference.state().job?.held.left), true);
    await page.clock.runFor(1); await hold.dispatchEvent('pointerup', { pointerId: 1 }); await page.clock.runFor(99);
    const released = await page.evaluate(() => ({ active: globalThis.reference.state().active, held: globalThis.reference.state().job?.held, canvasHeld: document.querySelector('canvas').dataset.leftHeld }));
    assert.deepEqual(released, { active: true, held: { left: false, right: false }, canvasHeld: 'false' }, 'A queued held heartbeat must not expire release within the original100ms age');
    const final = await page.evaluate(async () => { await globalThis.reference.close(); return globalThis.reference.state(); });
    assert.equal(final.lastJob.deliveryTimerArmed, false); assert.equal(final.active, false); assert.equal(final.retiring, false); assert.equal(final.listeners, 0); assert.equal(final.framePending, false); assert.equal(final.expiryArmed, false); assert.deepEqual(errors, []);
    return { browser: browser.browserType().name(), version: browser.version(), check: 'queued-heartbeat-before-release', clock: 'explicit-controlled-software-clock', controlEvents: 'explicit-synthetic-DOM-seam', maxAgeMs: 100, released, cleanup: { deliveryTimerArmed: false, listeners: 0, framePending: false, expiryArmed: false }, nativeTimingEvidence: false };
  } finally { await context.close(); }
}


async function checkCollaborativeReleaseRefusal(browser, origin) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.clock.install({ time: 0 }); await page.goto(origin); await page.clock.pauseAt(1000);
    const approve = async () => page.evaluate(() => {
      for (const checkbox of document.querySelectorAll('input[type=checkbox]')) checkbox.click();
      const start = [...document.querySelectorAll('button')].find(button => button.textContent === 'Start'); start.click();
    });
    await approve(); await page.evaluate(() => {
      const click = name => [...document.querySelectorAll('button')].find(button => button.textContent === name).click();
      for (const side of ['left', 'right']) { click('Request ' + side + ' partition'); click('Approve pending request'); }
    });
    await page.clock.runFor(223); await page.getByRole('button', { name: 'Hold contact', exact: true }).nth(0).dispatchEvent('pointerdown', { pointerId: 1 }); await page.clock.runFor(83);
    assert.equal(await page.evaluate(() => globalThis.reference.state().job?.held.left), true);
    // An explicit software burst fills the unchanged reliable queue4. A refused
    // release must retire the job, rather than leave a stale captured edge retrying.
    await page.evaluate(() => {
      const hold = [...document.querySelectorAll('button')].find(button => button.textContent === 'Hold contact');
      for (const [type, pointerId] of [['pointerup', 1], ['pointerdown', 2], ['pointerup', 2], ['pointerdown', 3], ['pointerup', 3]]) hold.dispatchEvent(new PointerEvent(type, { pointerId }));
    });
    await page.clock.fastForward(101); await page.clock.runFor(200);
    const released = await page.evaluate(() => { const state = globalThis.reference.state(); return { active: state.active, retiring: state.retiring, sourceApproved: state.sourceApproved, sinkApproved: state.sinkApproved, held: state.lastJob?.held, listeners: state.lastJob?.listeners, deliveryTimerArmed: state.lastJob?.deliveryTimerArmed, framePending: state.framePending, expiryArmed: state.expiryArmed, canvasRemoved: document.querySelector('canvas') === null, focusOnApproval: document.activeElement === document.querySelector('input[type=checkbox]') }; });
    assert.deepEqual(released, { active: false, retiring: false, sourceApproved: false, sinkApproved: false, held: { left: false, right: false }, listeners: 0, deliveryTimerArmed: false, framePending: false, expiryArmed: false, canvasRemoved: true, focusOnApproval: true }, 'Rejected reliable release must clear actual effects and retire authority, callbacks and input listeners');
    assert.equal(await page.getByRole('button', { name: 'Start', exact: true }).isDisabled(), true);
    assert.match(await page.getByRole('status').textContent(), /Input could not be delivered/);
    await approve(); const fresh = await page.evaluate(() => globalThis.reference.state()); assert.equal(fresh.active, true); assert.equal(fresh.attempts, 2); assert.deepEqual(fresh.job.held, { left: false, right: false });
    const final = await page.evaluate(async () => { await globalThis.reference.close(); return globalThis.reference.state(); });
    assert.equal(final.active, false); assert.equal(final.retiring, false); assert.equal(final.listeners, 0); assert.equal(final.framePending, false); assert.equal(final.expiryArmed, false); assert.equal(final.lastJob.deliveryTimerArmed, false); assert.deepEqual(errors, []);
    return { browser: browser.browserType().name(), version: browser.version(), check: 'reliable-release-capacity-refusal-retires-and-requires-fresh-approvals', clock: 'explicit-controlled-software-clock', controlEvents: 'explicit-synthetic-DOM-seam', queueCapacity: 4, maxAgeMs: 100, released, freshRetry: true, nativeTimingEvidence: false };
  } finally { await context.close(); }
}

let generated, receipt, negative;
const results = [], resolutions = [], schedulingResults = [];
try {
  // Negative files are copied into one newly owned fixture; neither the qualified
  // installed consumer nor any user artifact is mutated.
  negative = realpathSync(mkdtempSync('/tmp/101-sdk-consumer-reference-negative-'));
  for (const item of sdk.manifest.packages) for (const file of item.files) { const destination = join(negative, 'node_modules', item.name, file.path); mkdirSync(dirname(destination), { recursive: true }); copyFileSync(join(sdk.consumer, 'node_modules', item.name, file.path), destination); }
  copyFileSync(join(sdk.consumer, 'receipt.json'), join(negative, 'receipt.json'));
  const corrupt = join(negative, 'node_modules/@101/connect/dist/index.js'); writeFileSync(corrupt, readFileSync(corrupt).subarray(0, 3));
  assert.throws(() => generateReferenceApps({ manifestPath: args[1], consumerPath: negative }), /Expected values to be strictly equal|strictly deep-equal/);
  generated = generateReferenceApps({ manifestPath: args[1], consumerPath: args[2] });
  assert.deepEqual(Object.keys(generated.appDirectories), ['pointer', 'sensor-dashboard', 'appliance-remote', 'media-sharing', 'collaborative-controls']);
  for (const id of REFERENCE_APP_IDS.filter(id => selectedApplication === undefined || id === selectedApplication)) {
    const project = generated.appDirectories[id]; assert.ok(project.startsWith(join(realpathSync('/tmp'), '101-reference-apps-'))); assert.equal(realpathSync(project), project); assert.equal(lstatSync(join(project, 'node_modules')).isSymbolicLink(), false);
    const readme = readFileSync(join(project, 'README.md'), 'utf8');
    assert.ok(readme.length > 500); assert.ok(readme.includes('reliable queue' + (id === 'collaborative-controls' ? 4 : 1)), 'Readable bounds match the selected application');
    const resolutionFile = join(project, 'resolution.mjs'); writeFileSync(resolutionFile, `import * as sdk from '@101/connect';import * as runtime from '@101/device-runtime';import * as web from '@101/device-web';if(sdk.createDeviceRuntime!==runtime.createDeviceRuntime||sdk.createBrowserApplicationMedia!==web.createBrowserApplicationMedia)throw Error('Public facade identity');for(const name of ${JSON.stringify(sdk.manifest.packages.map(item => item.name))})console.log(JSON.stringify({name,url:import.meta.resolve(name)}));`);
    const resolved = await run(resolutionFile, { cwd: project }); assert.equal(resolved.status, 0, resolved.stderr); assert.equal(resolved.stderr, '');
    const entries = resolved.stdout.trim().split('\n').map(line => JSON.parse(line)); assert.equal(entries.length, 7);
    for (const entry of entries) assert.equal(entry.url, 'file://' + join(project, 'node_modules', entry.name, 'dist/index.js'));
    resolutions.push({ id, entries });
    const launcher = server(project);
    try {
      const origin = await launcher.ready;
      for (const engine of [chromium, webkit]) {
        const browser = await engine.launch({ headless: true });
        try {
          const context = await browser.newContext(), page = await context.newPage(), errors = [], foreign = [];
          try {
            await context.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { foreign.push(route.request().url()); return route.abort(); } return route.continue(); });
            page.on('pageerror', error => errors.push(error.message));
            await page.addInitScript(() => { globalThis.nativeAudit = { defaultOpens: 0, tracks: [], videos: [] };
              if (navigator.mediaDevices?.getUserMedia) navigator.mediaDevices.getUserMedia = () => { globalThis.nativeAudit.defaultOpens++; throw Error('User hardware acquisition prohibited'); };
              const capture = HTMLCanvasElement.prototype.captureStream; if (capture) HTMLCanvasElement.prototype.captureStream = function(rate) { const stream = capture.call(this, rate); globalThis.nativeAudit.tracks.push(...stream.getTracks()); return stream; };
              const play = HTMLVideoElement.prototype.play; HTMLVideoElement.prototype.play = function() { globalThis.nativeAudit.videos.push(this); return play.call(this); }; });
            await page.goto(origin); await page.waitForFunction(() => !!globalThis.reference);
            const before = await page.evaluate(() => globalThis.reference.state()); assert.equal(before.active, false); assert.equal(before.framePending, false); assert.equal(before.expiryArmed, false); assert.equal(before.job, undefined); assert.equal(await page.getByRole('button', { name: 'Start', exact: true }).isDisabled(), true);
            await page.getByLabel('Approve this selected source').check(); assert.equal(await page.getByRole('button', { name: 'Start', exact: true }).isDisabled(), true);
            await page.getByRole('button', { name: 'Decline', exact: true }).click(); const declined = await page.evaluate(() => globalThis.reference.state()); assert.equal(declined.active, false); assert.equal(declined.sourceApproved, false); assert.equal(declined.sinkApproved, false);
            async function approveAndStart() { await page.getByLabel('Approve this selected source').check(); await page.getByLabel('Approve this application destination').check(); await page.getByRole('button', { name: 'Start', exact: true }).focus(); await page.keyboard.press('Enter'); }
            await approveAndStart();
            if (id !== 'media-sharing') assert.equal(await page.evaluate(() => document.activeElement?.closest('.panel') !== null), true, 'Start must move focus into the actual application job');
            let unsupportedMedia = false;
            if (id === 'pointer') {
              const pad = page.getByRole('group', { name: 'Application pointer pad' }); await pad.focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.down('Space');
              await page.waitForFunction(() => globalThis.reference.state().job?.contact === true && globalThis.reference.state().job?.position.x > 0.5);
              await page.keyboard.up('Space'); await page.waitForFunction(() => globalThis.reference.state().job?.contact === false);
              await pad.focus(); await page.keyboard.down('Space'); await page.waitForFunction(() => globalThis.reference.state().job?.contact === true);
              const traversal = engine === webkit ? 'Alt+Shift+Tab' : 'Shift+Tab';
              await page.keyboard.press(traversal);
              const traversed = await page.evaluate(() => ({ active: globalThis.reference.state().active, focused: document.hasFocus(), pad: document.activeElement?.getAttribute('aria-label') === 'Application pointer pad' }));
              assert.deepEqual(traversed, { active: true, focused: true, pad: false }, engine.name() + ' native in-page traversal while Space is held: ' + traversal);
              await page.keyboard.up('Space');
              // The reliable release traverses the same queue1/pending1 runtime
              // as other input. Require it within the declared500ms value age,
              // rather than assuming three RAFs have completed two route turns.
              try { await page.waitForFunction(() => globalThis.reference.state().job?.contact === false, undefined, { timeout: 500 }); }
              catch { /* The explicit sink assertion below preserves held-state diagnostics. */ }
              const released = await page.evaluate(() => ({ active: globalThis.reference.state().active, contact: globalThis.reference.state().job?.contact, sinkContact: document.querySelector('canvas[aria-label="Application cursor output"]').dataset.contact }));
              assert.deepEqual(released, { active: true, contact: false, sinkContact: 'false' }, 'Space followed by Shift+Tab and release on another control must clear actual held sink contact without stopping the session');
              await pad.hover(); await page.mouse.down(); await page.waitForFunction(() => globalThis.reference.state().job?.contact === true);
              await page.keyboard.press(traversal);
              await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
              assert.equal(await page.evaluate(() => globalThis.reference.state().job?.contact), true, 'Pad keyboard blur preserves an independently active captured pointer');
              await page.mouse.move(8, 8); await page.mouse.up(); await page.waitForFunction(() => globalThis.reference.state().job?.contact === false);
              await pad.hover(); await page.mouse.down(); await page.waitForFunction(() => globalThis.reference.state().job?.contact === true);
              try {
                await page.evaluate(() => { const original = window.requestAnimationFrame, pending = [];
                  globalThis.restoreReferenceFrames = () => { window.requestAnimationFrame = original; for (const callback of pending) original.call(window, callback); delete globalThis.restoreReferenceFrames; };
                  window.requestAnimationFrame = callback => { pending.push(callback); return 0; };
                  return new Promise(resolve => original.call(window, () => original.call(window, resolve))); });
                await page.mouse.move(8, 8); await page.mouse.up();
                try { await page.waitForFunction(() => globalThis.reference.state().job?.contact === false, undefined, { timeout: 500 }); }
                catch { /* Keep the original contact-age bound and inspect the real sink. */ }
                assert.deepEqual(await page.evaluate(() => ({ active: globalThis.reference.state().active, contact: globalThis.reference.state().job?.contact, sinkContact: document.querySelector('canvas[aria-label="Application cursor output"]').dataset.contact })), { active: true, contact: false, sinkContact: 'false' }, 'Native pointer release must clear SDK/canvas contact within500ms with presentation frames withheld');
              } finally { await page.evaluate(() => globalThis.restoreReferenceFrames?.()); }
            } else if (id === 'sensor-dashboard') {
              await page.waitForFunction(() => globalThis.reference.state().job?.samples >= 2); const state = await page.evaluate(() => globalThis.reference.state().job); assert.equal(state.producer, 'actual-browser-timer-lateness'); assert.ok(state.retainedRows <= 32); assert.equal(state.latest.lateness.provenance.physicalDevice, false); assert.equal(state.latest.lateness.clockDomain, 'reference-browser-sensor'); assert.ok(state.latest.lateness.value >= 0 && state.latest.lateness.value <= 10000);
              await page.getByLabel('Alert when lateness exceeds').focus(); await page.keyboard.press('Home');
            } else if (id === 'appliance-remote') {
              await page.getByRole('button', { name: 'Request lamp on', exact: true }).click(); await page.waitForFunction(() => globalThis.reference.state().job?.commands === 1 && globalThis.reference.state().job?.latest.observed?.value === true);
              const state = await page.evaluate(() => globalThis.reference.state().job); assert.equal(state.physicalAppliance, false); assert.equal(state.modelOn, true); assert.equal(state.operations.find(operation => operation.effectEvidence === 'target-acknowledged').handlerResult, 'returned'); assert.ok(state.observations > 0);
              await page.getByRole('button', { name: 'Request lamp off', exact: true }).click(); await page.waitForFunction(() => globalThis.reference.state().job?.commands === 2 && globalThis.reference.state().job?.latest.observed?.value === false);
            } else if (id === 'media-sharing') {
              await page.waitForFunction(() => globalThis.reference.state().job?.binding?.state === 'active' || !globalThis.reference.state().active && !globalThis.reference.state().retiring);
              const state = await page.evaluate(() => globalThis.reference.state()); unsupportedMedia = !state.active;
              if (unsupportedMedia) { assert.equal(state.lastJob.binding.reason, 'unsupported'); assert.equal(state.lastJob.captures, 0); assert.equal(state.lastJob.pending, 0); }
              else {
                async function pixels() { return await page.evaluate(() => { const canvas = document.querySelector('canvas[aria-label="Approved local application drawing"]'); return canvas ? [...canvas.getContext('2d').getImageData(1, 1, 1, 1).data] : []; }); }
                await page.waitForFunction(() => { const canvas = document.querySelector('canvas[aria-label="Approved local application drawing"]'); return canvas?.getContext('2d').getImageData(1, 1, 1, 1).data[0] > 240; }); assert.deepEqual(await pixels(), [255, 0, 0, 255]);
                await page.getByRole('button', { name: 'Change drawing', exact: true }).click(); await page.waitForFunction(() => { const canvas = document.querySelector('canvas[aria-label="Approved local application drawing"]'); return canvas?.getContext('2d').getImageData(1, 1, 1, 1).data[2] > 240; }); assert.deepEqual(await pixels(), [0, 0, 255, 255]);
              }
            } else {
              await page.getByRole('button', { name: 'Request left partition', exact: true }).click(); await page.getByRole('button', { name: 'Approve pending request', exact: true }).click();
              await page.getByRole('button', { name: 'Request right partition', exact: true }).click(); await page.getByRole('button', { name: 'Approve pending request', exact: true }).click();
              const holds = page.getByRole('button', { name: 'Hold contact', exact: true });
              await holds.nth(0).hover(); await page.mouse.down(); await page.waitForFunction(() => globalThis.reference.state().job?.held.left === true);
              await page.mouse.move(8, 8); await page.mouse.up();
              try { await page.waitForFunction(() => globalThis.reference.state().job?.held.left === false, undefined, { timeout: 100 }); }
              catch { /* Assert actual fixed-schema state rather than a timeout alone. */ }
              assert.deepEqual(await page.evaluate(() => ({ active: globalThis.reference.state().active, held: globalThis.reference.state().job?.held })), { active: true, held: { left: false, right: false } }, 'An actual held button drag outside and release must clear its partition effect without focus loss');
              await holds.nth(0).hover(); await page.mouse.down(); await page.waitForFunction(() => globalThis.reference.state().job?.held.left === true);
              // A native release must reach its SDK sink even before the next UI frame.
              try {
                await page.evaluate(() => { const original = window.requestAnimationFrame, pending = [];
                  globalThis.restoreReferenceFrames = () => { window.requestAnimationFrame = original; for (const callback of pending) original.call(window, callback); delete globalThis.restoreReferenceFrames; };
                  window.requestAnimationFrame = callback => { pending.push(callback); return 0; };
                  return new Promise(resolve => original.call(window, () => original.call(window, resolve))); });
                await page.mouse.move(8, 8); await page.mouse.up();
                try { await page.waitForFunction(() => globalThis.reference.state().job?.held.left === false, undefined, { timeout: 100 }); }
                catch { /* Keep the same release bound and assert the actual sink. */ }
                assert.deepEqual(await page.evaluate(() => ({ active: globalThis.reference.state().active, held: globalThis.reference.state().job?.held })), { active: true, held: { left: false, right: false } }, 'Actual release must reach the partition SDK sink without another UI animation frame');
              } finally { await page.evaluate(() => globalThis.restoreReferenceFrames?.()); }
              await holds.nth(0).dispatchEvent('pointerdown', { pointerId: 1, isPrimary: true }); await holds.nth(1).dispatchEvent('pointerdown', { pointerId: 2, isPrimary: false });
              await page.waitForFunction(() => globalThis.reference.state().job?.held.left && globalThis.reference.state().job?.held.right);
              await page.getByRole('button', { name: 'Request control 2 for left partition', exact: true }).click(); const pending = await page.evaluate(() => globalThis.reference.state().job.ownership.slots); assert.equal(pending[0].owner.sourceId, 'alpha'); assert.equal(pending[0].request.sourceId, 'beta');
              await page.getByRole('button', { name: 'Decline pending request', exact: true }).click(); assert.equal(await page.evaluate(() => globalThis.reference.state().job.ownership.slots[0].owner.sourceId), 'alpha');
              await page.getByRole('button', { name: 'Request control 2 for left partition', exact: true }).click(); await page.getByRole('button', { name: 'Cancel pending request', exact: true }).click(); assert.equal(await page.evaluate(() => globalThis.reference.state().job.ownership.slots[0].owner.sourceId), 'alpha');
              await page.getByRole('button', { name: 'Request control 2 for left partition', exact: true }).click(); await page.getByRole('button', { name: 'Approve pending request', exact: true }).click(); assert.equal(await page.evaluate(() => globalThis.reference.state().job.ownership.slots[0].owner.sourceId), 'beta');
            }
            if (!unsupportedMedia) await page.getByLabel('Approve this application destination').uncheck();
            await page.waitForFunction(() => !globalThis.reference.state().active && !globalThis.reference.state().retiring);
            const revoked = await page.evaluate(() => globalThis.reference.state()); if (id === 'pointer' || id === 'collaborative-controls') assert.equal(revoked.lastJob.deliveryTimerArmed, false, 'Retirement cancels the owned delivery clock'); assert.equal(revoked.sourceApproved, false); assert.equal(revoked.sinkApproved, false); assert.equal(revoked.framePending, false); assert.equal(revoked.expiryArmed, false);
            assert.equal(await page.getByLabel('Approve this selected source').evaluate(element => element === document.activeElement), true, 'Released authority returns focus to fresh approval');
            if (id !== 'media-sharing') { await approveAndStart(); assert.equal(await page.evaluate(() => globalThis.reference.state().active), true); await page.getByRole('button', { name: 'Stop', exact: true }).click(); await page.waitForFunction(() => !globalThis.reference.state().retiring); }
            const final = await page.evaluate(async () => { await globalThis.reference.close(); return { state: globalThis.reference.state(), tracksEnded: globalThis.nativeAudit.tracks.every(track => track.readyState === 'ended'), videosDetached: globalThis.nativeAudit.videos.every(video => video.srcObject === null && !video.isConnected), defaultOpens: globalThis.nativeAudit.defaultOpens, captureTracks: globalThis.nativeAudit.tracks.length }; });
            assert.equal(final.state.active, false); assert.equal(final.state.retiring, false); assert.equal(final.state.listeners, 0); assert.equal(final.state.framePending, false); assert.equal(final.state.expiryArmed, false); assert.equal(final.tracksEnded, true); assert.equal(final.videosDetached, true); assert.equal(final.defaultOpens, 0); assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
            results.push({ id, browser: engine.name(), version: browser.version(), supportedSelectedMedia: id === 'media-sharing' ? !unsupportedMedia : undefined, checks: ['inert-before-two-independent-approvals', 'decline-grants-none', 'actual-selected-interactive-job', ...(id === 'pointer' ? ['Space-Shift+Tab-other-control-release-clears-held-sink', 'keyboard-blur-preserves-native-captured-pointer', 'native-pointer-release-clears-SDK-sink-before-next-UI-frame'] : id === 'collaborative-controls' ? ['native-drag-outside-release-clears-partition', 'native-release-clears-SDK-sink-before-next-UI-frame'] : []), 'revoke-releases-current-effects', 'fresh-explicit-retry-or-honest-media-unsupported', 'native-keyboard-controls-visible-focus', 'closed-runtime-native-and-UI-lifetime'], final, physicalHardwareQualification: false, automatedControlEvents: id === 'collaborative-controls' ? 'Actual native mouse drag/outside-release plus explicit synthetic DOM control events for simultaneous local software partitions; no hardware evidence' : 'Owned native browser keyboard/control automation' });
          } catch (error) { console.error(JSON.stringify({ phase: 'owned-browser-journey', application: id, browser: engine.name(), version: browser.version() })); throw error; }
          finally { await context.close(); }
          if (id === 'collaborative-controls') { schedulingResults.push(await checkCollaborativeClock(browser, origin)); schedulingResults.push(await checkCollaborativeReleaseRefusal(browser, origin)); }
        } finally { await browser.close(); }
      }
    } finally { await launcher.close(); }
  }
  for (const [path, pin] of Object.entries(generated.generatedPins)) assert.equal(hash(readFileSync(join(generated.directory, path))), pin, 'Immutable generated bytes');
  for (const [path, pin] of Object.entries(callerPins)) assert.equal(hash(readFileSync(join(root, path))), pin);
  for (const [path, pin] of Object.entries(sdk.installedPins)) assert.equal(hash(readFileSync(join(sdk.consumer, 'node_modules', path))), pin);
  for (const [path, pin] of Object.entries(tarballPins)) assert.equal(hash(readFileSync(path)), pin);
  assert.equal(hash(readFileSync(sdk.manifestFile)), sdk.manifestSha256);
  receipt = { result: 'pass', mode: 'five-independent-ordinary-installed-sdk-projects', sourceTree, ...(callerTree ? { callerTree } : {}), immutableManifest: { path: sdk.manifestFile, sha256: sdk.manifestSha256 }, callerPins, dependencyPins, installedPins: sdk.installedPins, tarballPins,
    generatedPins: generated.generatedPins, generatedProjects: REFERENCE_APP_IDS, ...(selectedApplication ? { selectedApplication } : {}), publicResolutions: resolutions, node: process.version, results, schedulingResults, physicalHardwareQualification: false, remotePeopleAuthentication: false, softwareProducersExplicit: true, manualCaptureLossQualified: false, cleanup: { ownedProjects: 0, negativeConsumers: 0, launchers: 0, browsers: 0, contexts: 0, defaultUserMediaOpens: 0 } };
} finally {
  generated?.cleanup(); if (negative) { assert.ok(negative.startsWith(join(realpathSync('/tmp'), '101-sdk-consumer-reference-negative-'))); rmSync(negative, { recursive: true, force: true }); }
}
assert.equal(generated && existsSync(generated.directory), false); assert.equal(negative && existsSync(negative), false);
console.log(JSON.stringify(receipt, null, 2));
