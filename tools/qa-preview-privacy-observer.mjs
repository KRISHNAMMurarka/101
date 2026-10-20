// Behavioral regression for the bounded observer, using real isolated browser stores.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import test from 'node:test';
import { chromium, webkit } from 'playwright';

const old = process.argv.includes('--old');
const source = readFileSync(new URL(old ? '../outputs/controllers/2026-10-18-s15-privacy/page-module-corrected.mjs.txt' : './qa-preview-privacy-page.mjs', import.meta.url), 'utf8');
const helper = source.slice(source.indexOf('const LIMIT ='), source.indexOf('async function cacheSnapshot()'));
const oldDelete = 'await new Promise(resolve => { const request = indexedDB.deleteDatabase(dbName); request.onsuccess = request.onerror = request.onblocked = resolve; });';
assert.ok(!old || source.includes(oldDelete));
const deletion = old ? `async function deleteOwnedDatabase(dbName) { ${oldDelete} }` : source.slice(source.indexOf('async function deleteOwnedDatabase('), source.indexOf('async function positiveControl('));
for (const engine of [chromium, webkit]) {
  test(engine.name() + ': structured raster forms are visible to the bounded observer', { timeout: 15000 }, async () => {
    await isolated(async page => {
      const found = await page.evaluate(async helper => {
        const inspectStores = new Function(helper + '; return idbSnapshot;')();
        const sequence = '7,19,31,43';
        const cases = [ ['numeric-array', [7,19,31,43], sequence], ['nested-raster', [[7,19],[31,43]], '[[7,19],[31,43]]'],
          ['object-key', { [sequence]: 'owned' }, sequence], ['map-key', new Map([[sequence, 'owned']]), sequence],
          ['map-value', new Map([['owned', [7,19,31,43]]]), sequence], ['set-value', new Set([[7,19,31,43]]), sequence],
          ['typed-bytes', Uint8Array.of(7,19,31,43), sequence],
          ['array-own-property', Object.assign([], { raster: sequence }), sequence], ['heterogeneous-array', [7,19,31,43,'owned'], sequence] ];
        const dbName = 'owned-structured-values-' + crypto.randomUUID();
        const db = await new Promise((resolve, reject) => { const request = indexedDB.open(dbName, 1); request.onupgradeneeded = () => { for (const [label] of cases) request.result.createObjectStore(label); }; request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        let observed, removed = false;
        try {
          await new Promise((resolve, reject) => { const transaction = db.transaction(cases.map(([label]) => label), 'readwrite'); for (const [label, value] of cases) transaction.objectStore(label).put(value, 'owned'); transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
          const snapshot = await inspectStores();
          observed = cases.map(([label, , want]) => ({ label, found: snapshot.find(item => item.database === dbName && item.store === label)?.strings.includes(want) === true }));
        } finally {
          db.close();
          await new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase(dbName); const timer = setTimeout(() => reject(Error('structured fixture deletion deadline')), 2500); request.onsuccess = () => { clearTimeout(timer); resolve(); }; request.onerror = () => { clearTimeout(timer); reject(request.error); }; });
          removed = !(await indexedDB.databases()).some(item => item.name === dbName);
        }
        if (!removed) throw Error('structured fixture remains');
        return observed;
      }, helper);
      assert.deepEqual(found, ['numeric-array','nested-raster','object-key','map-key','map-value','set-value','typed-bytes','array-own-property','heterogeneous-array'].map(label => ({ label, found: true })));
    });
  });
  test(engine.name() + ': blocked database deletion remains pending until actual success and disappearance', { timeout: 15000 }, async () => {
    await isolated(async page => {
      const result = await page.evaluate(async deletion => {
        const dbName = 'owned-blocked-delete-' + crypto.randomUUID();
        const blocker = await new Promise((resolve, reject) => { const request = indexedDB.open(dbName, 1); request.onupgradeneeded = () => request.result.createObjectStore('owned'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        const remove = new Function(deletion + '; return deleteOwnedDatabase;')();
        let settled = false, blocked = false, rawRequest;
        const intrinsic = IDBFactory.prototype.deleteDatabase;
        IDBFactory.prototype.deleteDatabase = function(name) { const request = Reflect.apply(intrinsic, this, [name]); rawRequest = request; request.addEventListener('blocked', () => { blocked = true; }); return request; };
        let pending;
        try {
          pending = remove(dbName).then(() => { settled = true; });
          const deadline = performance.now() + 2500;
          while (!blocked && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
          if (!blocked) throw Error('actual blocked event was not observed');
          await new Promise(resolve => setTimeout(resolve, 0));
          const premature = settled;
          const rawSuccess = new Promise((resolve, reject) => { rawRequest.addEventListener('success', resolve, { once: true }); rawRequest.addEventListener('error', () => reject(rawRequest.error), { once: true }); });
          blocker.close(); await rawSuccess; await pending;
          const absent = !(await indexedDB.databases()).some(item => item.name === dbName);
          return { blocked, premature, settled, absent };
        } finally { blocker.close(); IDBFactory.prototype.deleteDatabase = intrinsic; await pending; }
      }, deletion);
      assert.deepEqual(result, { blocked: true, premature: false, settled: true, absent: true });
    });
  });
  async function isolated(run) {
    const server = createServer((_, response) => response.end('<!doctype html><title>Owned privacy observer regression</title>'));
    let browser, context;
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const origin = 'http://127.0.0.1:' + server.address().port;
      browser = await engine.launch({ headless: true }); context = await browser.newContext();
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      const page = await context.newPage(); await page.goto(origin); await run(page);
    } finally {
      if (context) { await context.close(); assert.equal(context.pages().length, 0); }
      if (browser) { await browser.close(); assert.equal(browser.isConnected(), false); }
      if (server.listening) await new Promise(resolve => server.close(resolve));
    }
  }
}
