import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'vite';
import { chromium, webkit } from 'playwright';
import { startProdServer } from '../node_modules/vinext/dist/server/prod-server.js';
assert.equal(process.argv.length, 2);
const root = resolve(import.meta.dirname, '..'), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = ['app/components/OrbitalCrewGame.tsx', 'app/sharing/ConnectedSharingView.tsx', 'app/sharing/watch/WatchSharingView.tsx', 'tools/qa-player-task-labels.mjs'];
const sourceSha256 = Object.fromEntries(sources.map(path => [path, hash(readFileSync(resolve(root, path)))]));
const buildSha256 = hash(readFileSync(resolve(root, 'dist/server/index.js'))), results = [];
const fixtureId = resolve(root, '__qa-orbital-label.ts');
const fixtureSource = `import {BroadcastChannelTransport,PROTOCOL_VERSION} from '@101/protocol';
const transport=new BroadcastChannelTransport('ORBLABEL');window.__messages=[];
transport.onMessage(message=>window.__messages.push(message));
window.__stop=()=>transport.disconnect();transport.connect().then(()=>{transport.sendReliable({type:'hello',version:PROTOCOL_VERSION,deviceId:'internal-device-7b3f',device:'Living room controller',capabilities:{touch:true}});});`;
const fixture = await build({ root, configFile: false, envFile: false, publicDir: false, logLevel: 'silent',
  plugins: [{ name: 'owned-orbital-label', resolveId: id => id === fixtureId ? id : undefined, load: id => id === fixtureId ? fixtureSource : undefined }],
  build: { write: false, minify: false, lib: { entry: fixtureId, formats: ['iife'], name: 'OwnedOrbitalLabel' } } });
const fixtureCode = (Array.isArray(fixture) ? fixture[0] : fixture).output.find(file => file.type === 'chunk').code;
let app;
try {
  app = await startProdServer({ port: 0, host: '127.0.0.1', outDir: resolve(root, 'dist'), silent: true });
  const origin = `http://127.0.0.1:${app.port}`;
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
      try {
        await context.route('**/*', route => {
          const url = new URL(route.request().url());
          if (url.origin !== origin) return route.abort();
          if (url.pathname === '/__qa-orbital-label') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Owned controller</title><script>' + fixtureCode + '</script>' });
          return route.continue();
        });
        const page = await context.newPage(), errors = [], checks = [];
        page.on('pageerror', error => errors.push(error.message));
        const check = (label, pass, observed) => { checks.push({ name: label, pass, observed }); console.error(`${name}: ${label}: ${pass}`); };
        await page.goto(origin + '/games/orbitalcrew/play?session=ORBLABEL');
        await page.waitForFunction(() => document.querySelector('button[aria-controls]')?.disabled === false);
        const controller = await context.newPage();
        try {
          await controller.goto(origin + '/__qa-orbital-label');
          await controller.waitForFunction(() => window.__messages.some(message => message.payload?.type === 'controller.configure'));
          await page.locator('.crew-roster article.is-assigned').waitFor();
          const roster = await page.locator('.crew-roster').innerText();
          check('assigned-station-announces-controller-name', roster.includes('Living room controller') && !roster.includes('internal-device-7b3f'), roster);
          check('unassigned-stations-keep-local-task-label', roster.includes('Ready on this screen'), roster);
          check('orbital-assignment-fits-narrow-viewport', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        } finally { await controller.evaluate(() => window.__stop()); await controller.close(); }
        await page.goto(origin + '/sharing');
        await page.getByRole('button', { name: 'Connect participants', exact: true }).click();
        await page.getByRole('button', { name: 'Start connected setup', exact: true }).click();
        for (let index = 1; index <= 2; index++) {
          await page.getByRole('button', { name: 'Create participant invitation', exact: true }).click();
          const peer = page.getByTestId(`connected-peer-participant-${index}`); await peer.locator('textarea[readonly]').waitFor();
          const out = `Participant ${index} Code for the participant`, incoming = `Participant ${index} Participant offer`;
          check(`connected-${index}-outgoing-visible-task-name`, await peer.getByRole('textbox', { name: out, exact: true }).count() === 1, await peer.locator('textarea[readonly]').ariaSnapshot());
          check(`connected-${index}-incoming-visible-task-name`, await peer.getByRole('textbox', { name: incoming, exact: true }).count() === 1, await peer.locator('textarea:not([readonly])').ariaSnapshot());
        }
        check('connected-two-peer-fields-fit-narrow-viewport', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.getByRole('button', { name: 'Stop connected setup', exact: true }).click();
        await page.goto(origin + '/sharing/watch');
        await page.getByRole('combobox', { name: 'Page role', exact: true }).selectOption('observer');
        await page.getByRole('button', { name: 'Start watch setup', exact: true }).click();
        const invite = page.getByRole('button', { name: /^Create (owner|observer) invitation$/ }); await invite.waitFor();
        const inviteText = await invite.innerText(); check('observer-action-names-invitation-role', inviteText === 'Create observer invitation', inviteText);
        await invite.click(); const peer = page.getByTestId('watch-peer-owner'); await peer.locator('textarea[readonly]').waitFor();
        check('watch-outgoing-visible-task-name', await peer.getByRole('textbox', { name: 'Owner Code for the other page', exact: true }).count() === 1, await peer.locator('textarea[readonly]').ariaSnapshot());
        check('watch-incoming-visible-task-name', await peer.getByRole('textbox', { name: 'Owner Owner offer', exact: true }).count() === 1, await peer.locator('textarea:not([readonly])').ariaSnapshot());
        await page.getByRole('button', { name: 'Stop watch setup', exact: true }).click();
        check('no-page-errors-or-overflow', errors.length === 0 && await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), errors);
        results.push({ browser: name, version: browser.version(), checks });
      } finally { await context.close(); }
    } finally { await browser.close(); }
  }
} finally {
  if (app) { app.server.closeAllConnections(); await new Promise((resolve, reject) => app.server.close(error => error ? reject(error) : resolve())); }
}
for (const [path, pin] of Object.entries(sourceSha256)) assert.equal(hash(readFileSync(resolve(root, path))), pin);
assert.equal(hash(readFileSync(resolve(root, 'dist/server/index.js'))), buildSha256);
const pass = results.every(result => result.checks.every(check => check.pass));
console.log(JSON.stringify({ schemaVersion: 1, pass, sourceSha256, buildSha256, results, cleanup: { contextsClosed: true, browsersClosed: true, serverClosed: true },
  scope: 'Actual production player UI/native local-channel assignment and invitation creation; no handshake/grant/physical/AT acceptance.' }, null, 2));
if (!pass) process.exitCode = 1;
