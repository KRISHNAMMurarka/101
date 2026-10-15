import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'vite';
import { chromium, webkit } from 'playwright';
import { startProdServer } from '../node_modules/vinext/dist/server/prod-server.js';
import { LocalHubServer } from '../packages/hub-server/src/index.ts';
import { createControllerPairingUrl } from '../packages/protocol/src/index.ts';

assert.equal(process.argv.length, 2);
const root = resolve(import.meta.dirname, '..'), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const paths = ['app/controller/Controller.tsx', 'packages/link-controller/src/index.ts', 'packages/session/src/index.ts',
  'packages/pairing/src/index.ts', 'packages/pairing/src/http-signaling.ts', 'packages/protocol/src/index.ts',
  'packages/transport-webrtc/src/peer.ts', 'packages/adapter-motion/src/index.ts', 'games/orbitalcrew/src/roles.ts', 'tools/qa-controller-reconnect.mjs'];
const sourceSha256 = Object.fromEntries(paths.map(p => [p, hash(readFileSync(resolve(root, p)))]));
const buildSha256 = hash(readFileSync(resolve(root, 'dist/server/index.js')));
const results = []; let app;
const hub = new LocalHubServer({ host: '127.0.0.1', advertisedHost: '127.0.0.1', port: 0 });
try {
  const endpoint = await hub.start();
  app = await startProdServer({ port: 0, host: '127.0.0.1', outDir: resolve(root, 'dist'), silent: true });
  const origin = `http://127.0.0.1:${app.port}`;
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext({ reducedMotion: 'reduce' });
      try {
        if (name === 'chromium') await context.grantPermissions(['local-network-access'], { origin });
        const created = hub.createSession(`RECOVERY-${name.toUpperCase()}`, { hostName: 'Owned recovery host' });
        // Real SessionHost configuration producer and real AutomaticPairingHost,
        // using the existing pilot role and native RTC, served only in this context.
        const fixtureSource = `
import { SessionHost, LocalSession } from '@101/session';
import { MultiplexLinkTransport } from '@101/protocol';
import { AutomaticPairingHost, HttpHostSignalingClient } from '@101/pairing';
import { ORBITAL_CREW_ROLES } from './games/orbitalcrew/src/roles.ts';
const mux = new MultiplexLinkTransport();
window.__frames = []; window.__configurations = []; window.__messages = [];
const send = mux.sendReliable.bind(mux);
mux.sendReliable = message => { if(message.type === 'controller.configure') window.__configurations.push(message); return send(message); };
mux.onMessage(message => window.__messages.push(message));
const host = new SessionHost({ gameId:'orbitalcrew', roles:[ORBITAL_CREW_ROLES[0]], transport:mux,
 session:new LocalSession(${JSON.stringify(created.ticket.sessionId)}), onFrame:frame=>window.__frames.push(frame) });
const pairing = new AutomaticPairingHost({ signaling:new HttpHostSignalingClient(${JSON.stringify(endpoint)},${JSON.stringify(created.ticket.sessionId)},${JSON.stringify(created.hostToken)}), transport:mux });
window.__stopHost = async () => { await pairing.stop(); await host.stop(); };
(async()=>{await host.start();await pairing.start();window.__ready=true;})().catch(error=>{window.__hostError=error.message;});
`;
        const fixtureId = resolve(root, '__qa-controller-host.ts');
        const fixture = await build({ root, configFile: false, envFile: false, publicDir: false, logLevel: 'silent',
          plugins: [{ name: 'owned-controller-host', resolveId: id => id === fixtureId ? id : undefined,
            load: id => id === fixtureId ? fixtureSource : undefined }],
          build: { write: false, minify: false, lib: { entry: fixtureId, formats: ['iife'], name: 'OwnedControllerHost' } } });
        const fixtureCode = (Array.isArray(fixture) ? fixture[0] : fixture).output.find(file => file.type === 'chunk').code;
        await context.route('**/*', route => {
          const url = new URL(route.request().url());
          if (url.origin !== origin && url.origin !== endpoint) return route.abort();
          if (url.origin === origin && url.pathname === '/__qa-reconnect-host') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Owned SessionHost</title><script>' + fixtureCode + '</script>' });
          return route.continue();
        });
        const host = await context.newPage(), page = await context.newPage(), errors = [];
        for (const p of [host, page]) {
          p.on('pageerror', e => errors.push({ name: e.name, message: e.message }));
          p.on('requestfailed', r => console.error(JSON.stringify({ browser:name, path:new URL(r.url()).pathname, failure:r.failure() })));
          p.on('console', m => { if (m.type() === 'error') console.error(m.text()); });
        }
        await page.addInitScript(() => {
          window.__channels = []; window.__closedChannels = 0; window.__peers = [];
          const NativePeer = window.RTCPeerConnection;
          window.RTCPeerConnection = new Proxy(NativePeer, { construct(target, args, receiver) {
            const peer = Reflect.construct(target, args, receiver); window.__peers.push(peer);
            peer.addEventListener('datachannel', event => { window.__channels.push(event.channel); event.channel.addEventListener('close', () => window.__closedChannels++); });
            return peer;
          } });
          const Motion = window.DeviceMotionEvent ?? class extends Event {};
          Object.defineProperty(Motion, 'requestPermission', { configurable: true, value: async () => 'granted' });
          Object.defineProperty(window, 'DeviceMotionEvent', { configurable: true, value: Motion });
          for (const type of ['devicemotion', 'deviceorientation']) window.addEventListener(type, event => { if (event.isTrusted) event.stopImmediatePropagation(); }, true);
          window.__tilt = () => { for (const gamma of [0, 25]) { const event = new Event('deviceorientation');
            Object.defineProperties(event, { alpha:{value:0}, beta:{value:0}, gamma:{value:gamma} }); window.dispatchEvent(event); } };
        });
        await host.goto(origin + '/__qa-reconnect-host');
        await host.waitForFunction(() => window.__ready || window.__hostError);
        assert.equal(await host.evaluate(() => window.__hostError), undefined);
        await page.goto(createControllerPairingUrl(origin + '/controller', created.ticket));
        await page.getByRole('heading', { name: 'Connect to this host?' }).waitFor();
        await page.getByRole('button', { name: 'Connect', exact: true }).click();
        await page.locator('.controller-top .mark-label').filter({ hasText: 'Flight Control' }).waitFor();
        await page.getByRole('button', { name: 'Enable motion', exact: true }).click();
        await page.getByRole('button', { name: 'Set neutral', exact: true }).waitFor();
        await page.evaluate(() => window.__tilt());
        await host.waitForFunction(() => window.__frames.some(frame => Math.abs(frame.vectors?.flight?.x ?? 0) > .1));
        await page.getByRole('button', { name: /^EVASIVE BOOST\b/ }).focus();
        await page.keyboard.down('Space');
        await host.waitForFunction(() => window.__frames.at(-1)?.actions.overdrive === true);
        const before = await host.evaluate(() => ({ frames:window.__frames.length, configuration:window.__configurations.at(-1), configurations:window.__configurations.length }));
        const peerCount = await page.evaluate(() => window.__peers.length);
        // Close an actual native RTC data channel. Its real close event reaches
        // PeerDataTransport -> SignaledLinkTransport -> the built player view.
        await page.evaluate(() => { const channel=window.__channels.find(c=>c.label==='101-control' && c.readyState==='open');
          if(!channel) throw Error('Expected actual open native control channel'); channel.close(); });
        await page.waitForFunction(() => window.__closedChannels > 0);
        await host.waitForFunction(count => window.__configurations.length > count, before.configurations);
        await page.waitForFunction(count => window.__peers.length > count && window.__channels.some(c=>c.label==='101-control' && c.readyState==='open'), peerCount);
        await page.getByRole('button', { name: 'Enable motion', exact: true }).waitFor();
        const after = await host.evaluate(count => ({ frames:window.__frames.slice(count), configuration:window.__configurations.at(-1) }), before.frames);
        assert.ok(after.frames.length > 0, 'Reconnect must actually deliver a fresh host frame');
        const held = after.frames.filter(frame => Math.abs(frame.vectors?.flight?.x ?? 0) > .01 || Math.abs(frame.vectors?.flight?.y ?? 0) > .01 ||
          Math.abs(frame.axes?.flightX ?? 0) > .01 || Math.abs(frame.axes?.flightY ?? 0) > .01 || frame.actions.overdrive === true);
        const sameConfiguration = before.configuration.revision === after.configuration.revision && before.configuration.role === after.configuration.role;
        await page.keyboard.up('Space');
        await page.getByRole('button', { name: /^EVASIVE BOOST\b/ }).focus();
        await page.keyboard.down('Space');
        await host.waitForFunction(() => window.__frames.at(-1)?.actions.overdrive === true);
        await page.keyboard.up('Space');
        await host.waitForFunction(() => window.__frames.at(-1)?.actions.overdrive === false);
        await page.getByRole('button', { name: 'Enable motion', exact: true }).click();
        await page.getByRole('button', { name: 'Set neutral', exact: true }).waitFor();
        await page.evaluate(() => window.__tilt());
        await host.waitForFunction(() => Math.abs(window.__frames.at(-1)?.vectors?.flight?.x ?? 0) > .1);
        results.push({ browser:name, version:browser.version(), checks:[
          { name:'actual-native-channel-close-reconnects', pass:true, replacementPeers:await page.evaluate(() => window.__peers.length)-peerCount },
          { name:'same-configuration-reconnect-clears-held-input', pass:held.length===0 && sameConfiguration, heldFrames:held.length, sameConfiguration, deliveredFrames:after.frames.length },
          { name:'fresh-button-press-and-release-after-reconnect', pass:true },
          { name:'fresh-motion-permission-and-sample-after-reconnect', pass:true },
          { name:'zero-page-errors', pass:errors.length===0, errors },
        ] });
        await page.goto(origin + '/');
        await host.evaluate(() => window.__stopHost());
      } finally { await context.close(); }
    } finally { await browser.close(); }
  }
} finally {
  await hub.stop();
  if (app) { app.server.closeAllConnections(); await new Promise((resolve,reject) => app.server.close(error => error ? reject(error) : resolve())); }
}
for (const [path,pin] of Object.entries(sourceSha256)) assert.equal(hash(readFileSync(resolve(root,path))),pin,'Source changed during proof');
const pass=results.every(r=>r.checks.every(c=>c.pass));
console.log(JSON.stringify({ result:pass?'pass':'fail', sourceSha256, buildSha256, results, cleanup:{ browsers:0,contexts:0,servers:0 },
  scope:'Built browser Controller, actual SessionHost with existing pilot role, actual local HTTP signaling and native WebRTC close/reconnect. Chromium disposable context has local-network access pregranted; motion permission and samples are software controlled. No physical sensor, device, native permission prompt or remote-network acceptance.' },null,2));
if(!pass) process.exitCode=1;
