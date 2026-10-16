import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'vite';
import { chromium, webkit } from 'playwright';
import { startProdServer } from '../node_modules/vinext/dist/server/prod-server.js';

assert.equal(process.argv.length, 2);
const root = resolve(import.meta.dirname, '..'), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const paths = ['app/components/GravityStackGame.tsx', 'app/lib/use-game-host.ts', 'app/components/GameControllerOverlay.tsx',
  'games/gravitystack/src/game.ts', 'packages/physics/src/index.ts', 'packages/game-host/src/index.ts', 'tools/qa-gravitystack-recovery.mjs'];
const sourceSha256 = Object.fromEntries(paths.map(path => [path, hash(readFileSync(resolve(root, path)))]));
const buildSha256 = hash(readFileSync(resolve(root, 'dist/server/index.js'))), results = [];
const fixtureId = resolve(root, '__qa-gravity-controller.ts');
const fixtureSource = `import { BroadcastChannelTransport, PROTOCOL_VERSION } from '@101/protocol';
const transport = new BroadcastChannelTransport('GRAVCOPY'); window.__messages = [];
transport.onMessage(message => window.__messages.push(message));
window.__hello = () => transport.sendReliable({type:'hello', version:PROTOCOL_VERSION, deviceId:'internal-device-7b3f', device:'Living room controller', capabilities:{touch:true}});
window.__stop = () => transport.disconnect();
transport.connect().then(() => {window.__hello();window.__ready=true;});`;
const fixture = await build({ root, configFile: false, envFile: false, publicDir: false, logLevel: 'silent',
  plugins: [{ name: 'owned-gravity-controller', resolveId: id => id === fixtureId ? id : undefined, load: id => id === fixtureId ? fixtureSource : undefined }],
  build: { write: false, minify: false, lib: { entry: fixtureId, formats: ['iife'], name: 'OwnedGravityController' } } });
const fixtureCode = (Array.isArray(fixture) ? fixture[0] : fixture).output.find(file => file.type === 'chunk').code;
const lifecycleId = resolve(root, '__qa-gravity-lifecycle.tsx');
const lifecycleSource = `import React from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
import {KeyboardAdapter} from '@101/adapter-keyboard';
import GravityStackGame from './app/components/GravityStackGame.tsx';
const start=KeyboardAdapter.prototype.start;
KeyboardAdapter.prototype.start=function(...args){const result=Reflect.apply(start,this,args);if(!window.__holdNextKeyboard)return result;window.__holdNextKeyboard=false;window.__keyboardStartHeld=true;return Promise.resolve(result).then(()=>new Promise(resolve=>{window.__releaseKeyboardStart=resolve;}));};
let root; const render=session=>root.render(<GravityStackGame sessionId={session} onConnect={()=>{}} onExit={()=>window.__unmount()} />);
window.__mount=()=>{root=createRoot(document.getElementById('root'));render('GRAVLIFE');};
window.__switchSession=session=>{if(session==='GRAVHELD')window.__holdNextKeyboard=true;flushSync(()=>render(session));};
window.__unmount=()=>root.unmount(); window.__mount();`;
const lifecycle = await build({ root, configFile: false, envFile: false, publicDir: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' }, resolve: { alias: { '@': root } },
  plugins: [{ name: 'owned-gravity-lifecycle', resolveId: id => id === lifecycleId ? id : undefined, load: id => id === lifecycleId ? lifecycleSource : undefined }],
  build: { write: false, minify: false, lib: { entry: lifecycleId, formats: ['iife'], name: 'OwnedGravityLifecycle' } } });
const lifecycleCode = (Array.isArray(lifecycle) ? lifecycle[0] : lifecycle).output.find(file => file.type === 'chunk').code;
let app;
try {
  app = await startProdServer({ port: 0, host: '127.0.0.1', outDir: resolve(root, 'dist'), silent: true });
  const origin = `http://127.0.0.1:${app.port}`;
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch({ headless: true });
    try {
      for (const scenario of ['session-reuse', 'preload-left', 'copy', 'preload-refused']) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
        try {
          await context.route('**/*', route => {
            const url = new URL(route.request().url());
            if (url.origin !== origin) return route.abort();
            if (url.pathname === '/__qa-gravity-controller') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Owned controller</title><script>' + fixtureCode + '</script>' });
            if (url.pathname === '/__qa-gravity-lifecycle') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Owned game mount</title><div id="root"></div><script src="/__qa-gravity-lifecycle.js"></script>' });
            if (url.pathname === '/__qa-gravity-lifecycle.js') return route.fulfill({ contentType: 'text/javascript', body: lifecycleCode });
            return route.continue();
          });
          const page = await context.newPage(), errors = [], checks = [];
          page.on('pageerror', error => { errors.push({ name: error.name, message: error.message }); console.error(`${name} ${scenario} pageerror: ${error.stack}`); });
          const check = (label, pass, detail = {}) => { checks.push({ name: label, pass, ...detail }); console.error(`${name} ${scenario}: ${label}: ${pass}`); };
          if (scenario === 'preload-refused') await page.addInitScript(() => {
            const instantiate = WebAssembly.instantiate;
            window.__wasmAttempts = 0;
            WebAssembly.instantiate = function (...args) {
              window.__wasmAttempts++;
              if (window.__wasmAttempts === 1) return Promise.reject(new WebAssembly.CompileError('Owned software-controlled compilation refusal'));
              return Reflect.apply(instantiate, this, args);
            };
          });
          if (scenario === 'preload-left') await page.addInitScript(() => {
            const instantiate = WebAssembly.instantiate;
            let first = true;
            WebAssembly.instantiate = function (...args) {
              const native = Reflect.apply(instantiate, this, args);
              if (!first) return native;
              first = false;
              return Promise.resolve(native).then(result => new Promise(resolve => {
                window.__wasmHeld = true; window.__releaseWasm = () => resolve(result);
              }));
            };
          });
          if (scenario === 'preload-left' || scenario === 'session-reuse') await page.addInitScript(() => {
            const add = window.addEventListener, remove = window.removeEventListener;
            const keys = new Map([['keydown', new Set()], ['keyup', new Set()]]);
            window.__keyListeners = () => [...keys.values()].reduce((sum, set) => sum + set.size, 0);
            window.addEventListener = function (type, listener, ...args) {
              keys.get(type)?.add(listener); return Reflect.apply(add, this, [type, listener, ...args]);
            };
            window.removeEventListener = function (type, listener, ...args) {
              keys.get(type)?.delete(listener); return Reflect.apply(remove, this, [type, listener, ...args]);
            };
            window.__openChannels = 0;
            const NativeChannel = BroadcastChannel;
            window.BroadcastChannel = new Proxy(NativeChannel, { construct(target, args, receiver) {
              const channel = Reflect.construct(target, args, receiver), close = channel.close;
              let closed = false; window.__openChannels++;
              channel.close = function (...closeArgs) { if (!closed) { closed = true; window.__openChannels--; } return Reflect.apply(close, this, closeArgs); };
              return channel;
            } });
          });
          const lifecycleScenario = scenario === 'preload-left' || scenario === 'session-reuse';
          await page.goto(origin + (lifecycleScenario ? '/__qa-gravity-lifecycle' : '/games/gravitystack/play?session=GRAVCOPY'));
          if (scenario === 'copy') {
            await page.getByRole('button', { name: 'Show controls', exact: true }).waitFor({ state: 'visible' });
            await page.waitForFunction(() => document.querySelector('button[aria-controls]')?.disabled === false);
            const controller = await context.newPage();
            await controller.goto(origin + '/__qa-gravity-controller');
            await controller.waitForFunction(() => window.__ready);
            await controller.waitForFunction(() => window.__messages.some(message => message.payload?.type === 'controller.configure'));
            await page.locator('.gravity-role-card p.linked').waitFor();
            const status = await page.locator('.gravity-statusbar').innerText();
            const players = await page.locator('.gravity-role-card').innerText();
            check('ready-status-uses-player-language', status.includes('Ready to play'), { observed: status });
            check('assigned-controller-shows-announced-name', players.includes('Living room controller') && !players.includes('internal-device-7b3f'), { observed: players });
            check('unassigned-role-stays-on-this-screen', players.includes('On this screen'));
            await controller.evaluate(() => window.__stop()); await controller.close();
          } else if (scenario === 'preload-refused') {
            await page.waitForFunction(() => window.__wasmAttempts > 0);
            const retry = page.getByRole('button', { name: 'Try again', exact: true });
            const recovery = await retry.isVisible().catch(() => false) || await retry.waitFor({ timeout: 4000 }).then(() => true, () => false);
            check('actual-physics-preload-refusal-has-recovery', recovery, { wasmAttempts: await page.evaluate(() => window.__wasmAttempts), errors: [...errors] });
            if (recovery) {
              check('recovery-focus-and-plain-message', await retry.evaluate(element => element === document.activeElement)
                && (await page.getByRole('alert').innerText()).includes('Back'));
              await retry.press('Space');
              await page.waitForFunction(() => document.querySelector('.gravity-statusbar')?.textContent.includes('Ready to play'));
              await page.locator('.gravity-stage canvas').waitFor();
              check('retry-creates-playable-physics-world', await page.evaluate(() => window.__wasmAttempts > 1));
              await page.locator('.gravity-stage').focus(); await page.keyboard.down('Space');
              try { await page.waitForFunction(() => document.querySelectorAll('.gravity-stats strong')[3]?.textContent === '1'); }
              finally { await page.keyboard.up('Space'); }
              check('retry-accepts-real-drop-input', true);
            }
          } else if (scenario === 'session-reuse') {
            await page.waitForFunction(() => document.querySelector('button[aria-controls]')?.disabled === false);
            const transition = await page.evaluate(() => {
              window.__switchSession('GRAVHELD');
              const pendingB = document.querySelector('button[aria-controls]').disabled && document.body.textContent.includes('Getting the game ready');
              window.__switchSession('GRAVLIFE');
              return { pendingB, pendingA: document.querySelector('button[aria-controls]').disabled && document.body.textContent.includes('Getting the game ready'), held: window.__keyboardStartHeld };
            });
            check('session-A-to-pending-B-to-A-never-reuses-closed-binding', transition.pendingB && transition.pendingA && transition.held, transition);
            await page.waitForFunction(() => document.querySelector('button[aria-controls]')?.disabled === false && typeof window.__releaseKeyboardStart === 'function');
            await page.evaluate(() => window.__releaseKeyboardStart());
            await page.waitForFunction(() => window.__keyListeners() === 2 && window.__openChannels === 1, null, { timeout: 8000 });
            check('abandoned-session-start-retires-without-overwriting-new-run', await page.getByRole('button', { name: 'Show controls', exact: true }).isEnabled() && await page.getByRole('button', { name: 'Try again' }).count() === 0);
            await page.locator('.gravity-stage').focus(); await page.keyboard.down('Space');
            try { await page.waitForFunction(() => document.querySelectorAll('.gravity-stats strong')[3]?.textContent === '1'); }
            finally { await page.keyboard.up('Space'); }
            check('reused-session-starts-a-fresh-playable-world', true);
          } else {
            try { await page.waitForFunction(() => window.__wasmHeld && window.__keyListeners() > 0 && window.__openChannels > 0, null, { timeout: 10000 }); }
            catch (error) { console.error(JSON.stringify({ errors, observed: await page.evaluate(() => ({ held: window.__wasmHeld, keys: window.__keyListeners(), channels: window.__openChannels, text: document.body.innerText.slice(0, 2000) })) })); throw error; }
            await page.evaluate(() => window.__unmount());
            await page.waitForFunction(() => window.__keyListeners() === 0);
            check('leave-during-preload-releases-keyboard', true);
            await page.evaluate(() => window.__releaseWasm());
            await page.waitForFunction(() => window.__openChannels === 0, null, { timeout: 8000 });
            check('late-native-preload-cannot-restore-view-or-session', await page.locator('canvas').count() === 0 && await page.getByRole('button', { name: 'Try again' }).count() === 0);
            await page.evaluate(() => window.__mount());
            await page.waitForFunction(() => document.querySelector('.gravity-statusbar')?.textContent.includes('Ready to play'));
            await page.locator('.gravity-stage canvas').waitFor();
            check('fresh-mount-after-late-preload-is-playable', true);
          }
          check('no-unhandled-page-errors', errors.length === 0, { errors });
          check('no-horizontal-overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          await page.getByRole('button', { name: 'Back', exact: true }).click();
          if (lifecycleScenario) await page.waitForFunction(() => window.__keyListeners() === 0);
          else await page.waitForURL(origin + '/games/gravitystack');
          check('back-exits-current-run', true);
          results.push({ browser: name, version: browser.version(), scenario, checks });
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  }
} finally {
  if (app) { app.server.closeAllConnections(); await new Promise((resolve, reject) => app.server.close(error => error ? reject(error) : resolve())); }
}
for (const [path, pin] of Object.entries(sourceSha256)) assert.equal(hash(readFileSync(resolve(root, path))), pin, 'Source changed during proof');
const pass = results.every(result => result.checks.every(check => check.pass));
console.log(JSON.stringify({ result: pass ? 'pass' : 'fail', sourceSha256, buildSha256, results, cleanup: { browsers: 0, contexts: 0, servers: 0 },
  scope: 'Fresh built GravityStack on Chromium/WebKit; real Physics101/Rapier preload, same-browser native BroadcastChannel transport and actual SessionHost assignment/configuration. One software-controlled WebAssembly compilation refusal, then native compiler on retry. Separate actual-source React fixture holds first native WASM result across unmount, and separately holds actual keyboard adapter start return over A-to-B-to-A prop changes; native call receivers and GameHost connect/launch ownership are preserved. No physical controller, remote pairing, OS permission or native startup qualification.' }, null, 2));
if (!pass) process.exitCode = 1;
