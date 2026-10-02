import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engine = process.argv[2] ?? 'chromium';
const browserType = { chromium, firefox, webkit }[engine];
if (!browserType) throw new Error('Expected chromium, firefox or webkit');
const modules = new Map(), sourceSha256 = {};
function collect(path) {
  const route = `/modules/${relative(root, path).replaceAll('\\', '/')}`;
  if (modules.has(route)) return route;
  const source = readFileSync(path, 'utf8');
  sourceSha256[relative(root, path)] = createHash('sha256').update(source).digest('hex');
  modules.set(route, '');
  const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  modules.set(route, javascript.replace(/((?:from\s*|import\s*)['"])([^'"]+)(['"])/g, (_match, before, specifier, after) => {
    if (!specifier.startsWith('.')) throw new Error(`Unexpected identity QA import ${specifier}`);
    const dependency = resolve(dirname(path), specifier);
    if (!dependency.startsWith(`${root}/packages/device-web/src/`)) throw new Error('Identity QA import outside provider package');
    return before + collect(dependency) + after;
  }));
  return route;
}
const entry = collect(resolve(root, 'packages/device-web/src/web-identity.ts'));
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  response.setHeader('Access-Control-Allow-Origin', '*');
  if (modules.has(path)) { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(modules.get(path)); }
  else if (path === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Local endpoint identity checks</title>'); }
  else { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await browserType.launch({ headless: true });
  const context = await browser.newContext();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await context.newPage(); await page.goto(origin);
  const databaseName = `101-endpoint-qa-${crypto.randomUUID()}`;
  await page.evaluate(async ({ entry, databaseName }) => {
    const api = await import(entry), checks = [];
    function check(value, name) { if (!value) throw new Error(name); checks.push(name); }
    async function rejected(operation, name) { let rejected = false; try { await operation(); } catch { rejected = true; } check(rejected, name); }
    const options = { databaseName };
    const first = api.createWebCryptoIdentityStore(options), second = api.createWebCryptoIdentityStore(options);
    check(await first.load() === undefined, 'load does not create absent key');
    const [left, right] = await Promise.all([first.create(), second.create()]);
    check(left.keyId === right.keyId, 'atomic competing store creation');
    check((await first.create()).keyId === left.keyId, 'explicit create preserves coherent existing key');
    const message = new TextEncoder().encode('persistent browser proof');
    check(await api.webEndpointCrypto.verify(left.publicKey, message, await left.sign(message)), 'actual WebCrypto persisted signature verifies');
    const publicBytes = left.publicKey; publicBytes.fill(0);
    check(left.publicKey[0] === 4, 'public key getter returns copies');
    check(await left.isCurrent(), 'persisted signer reports current');
    let notified = 0; left.onInvalidated(() => { notified++; });
    first.close();
    check(notified === 1, 'close invalidates synchronously');
    check(!await left.isCurrent(), 'closed signer freshness false');
    await rejected(() => left.sign(message), 'closed captured signer rejected');
    await rejected(() => second.remove('0'.repeat(64)), 'wrong expected key cannot delete');
    const active = await second.load();
    check(active?.keyId === right.keyId, 'key retained after rejected expected removal');
    globalThis.identityQa = { api, options, store: second, identity: active, message, checks, rejected, check };
  }, { entry, databaseName });

  // Same origin and browser context, separate tab: IndexedDB must arbitrate creation.
  const other = await context.newPage(); await other.goto(origin);
  const tabsName = `${databaseName}-tabs`;
  const ids = await Promise.all([page, other].map(target => target.evaluate(async ({ entry, databaseName }) => {
    const { createWebCryptoIdentityStore } = await import(entry);
    const store = createWebCryptoIdentityStore({ databaseName });
    try { return (await store.create()).keyId; } finally { store.close(); }
  }, { entry, databaseName: tabsName })));
  assert.equal(ids[0], ids[1]);

  const storage = await page.evaluate(async () => {
    const { api, options, store, identity, message, checks, rejected, check } = globalThis.identityQa;
    async function stored(mutate) {
      const db = await new Promise((resolve, reject) => { const request = indexedDB.open(options.databaseName, 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try {
        return await new Promise((resolve, reject) => {
          const transaction = db.transaction('identity', mutate ? 'readwrite' : 'readonly'), objectStore = transaction.objectStore('identity');
          const request = objectStore.get('endpoint'); let result;
          request.onsuccess = () => { result = request.result; if (mutate) objectStore.put(mutate(result), 'endpoint'); };
          transaction.oncomplete = () => resolve(result); transaction.onabort = transaction.onerror = () => reject(transaction.error);
        });
      } finally { db.close(); }
    }
    const actual = await stored();
    check(actual.privateKey.type === 'private' && actual.privateKey.extractable === false && actual.privateKey.usages.join(',') === 'sign', 'persisted private CryptoKey is nonextractable and sign-only');
    await rejected(() => crypto.subtle.exportKey('pkcs8', actual.privateKey), 'private key export forbidden by actual browser');
    const otherPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const exportable = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const otherCurve = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, false, ['sign', 'verify']);
    const wrongUsage = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    for (const [name, mutate] of [
      ['mismatched public/private key', value => ({ ...value, privateKey: otherPair.privateKey })],
      ['extractable private key', value => ({ ...value, privateKey: exportable.privateKey })],
      ['wrong stored curve', value => ({ ...value, privateKey: otherCurve.privateKey })],
      ['wrong stored algorithm and usage', value => ({ ...value, privateKey: wrongUsage.privateKey })],
      ['public key in private slot', value => ({ ...value, privateKey: actual.publicKey })],
      ['incorrect stored key ID', value => ({ ...value, keyId: '0'.repeat(64) })],
      ['copied key metadata', value => ({ ...value, privateKey: { type: 'private', extractable: false, algorithm: { name: 'ECDSA', namedCurve: 'P-256' }, usages: ['sign'] } })],
    ]) {
      await stored(() => mutate(actual));
      const corrupt = api.createWebCryptoIdentityStore(options);
      try {
        await rejected(() => corrupt.load(), `${name} load fails closed`);
        await rejected(() => corrupt.create(), `${name} create does not rotate`);
        check((await stored()).instanceId === actual.instanceId, `${name} retained for explicit recovery`);
      } finally { corrupt.close(); }
    }
    await stored(() => actual);
    let notifications = 0; identity.onInvalidated(() => { notifications++; });
    const removing = store.remove(identity.keyId);
    check(notifications === 1, 'remove invalidates synchronously');
    await removing;
    check(await store.load() === undefined, 'explicit removal leaves key absent');
    check(!await identity.isCurrent(), 'removed captured signer freshness false');
    await rejected(() => identity.sign(message), 'removed captured signer rejected');
    const fresh = await store.create();
    check(fresh.keyId !== identity.keyId, 'explicit recreation rotates key');
    store.close();
    return { keyId: fresh.keyId, checks };
  });
  await page.reload();
  const reload = await page.evaluate(async ({ entry, databaseName, expectedId }) => {
    const api = await import(entry), store = api.createWebCryptoIdentityStore({ databaseName });
    try {
      const identity = await store.load();
      if (!identity || identity.keyId !== expectedId) throw new Error('Browser reload lost persisted key');
      const message = new TextEncoder().encode('reloaded proof');
      if (!await api.webEndpointCrypto.verify(identity.publicKey, message, await identity.sign(message))) throw new Error('Reloaded signer failed verification');
      return ['reload preserves persisted key', 'reloaded native WebCrypto key signs'];
    } finally { store.close(); }
  }, { entry, databaseName, expectedId: storage.keyId });

  const lifecycle = await page.evaluate(async ({ entry, databaseName }) => {
    const api = await import(entry), checks = [];
    function check(value, name) { if (!value) throw new Error(name); checks.push(name); }
    async function rejected(operation, name) { let rejected = false; try { await operation(); } catch { rejected = true; } check(rejected, name); }
    let reached, release;
    const reachedSign = new Promise(resolve => { reached = resolve; }), resumed = new Promise(resolve => { release = resolve; });
    let armed = false;
    // Scheduling instrumentation: every primitive still runs in the browser's native WebCrypto.
    const realSubtle = crypto.subtle;
    const subtle = new Proxy(realSubtle, { get(target, property) {
      if (property === 'sign') return async (...args) => {
        const result = await target.sign(...args);
        const input = new Uint8Array(args[2]);
        if (armed && !new TextDecoder().decode(input).startsWith('101.endpoint-storage-proof/1\0')) { armed = false; reached(); await resumed; }
        return result;
      };
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const nativeCrypto = { subtle, getRandomValues: value => crypto.getRandomValues(value) };
    const signerStore = api.createWebCryptoIdentityStore({ databaseName, crypto: nativeCrypto });
    const remover = api.createWebCryptoIdentityStore({ databaseName });
    try {
      const captured = await signerStore.load();
      const message = new TextEncoder().encode('pending browser signature');
      armed = true; const signing = captured.sign(message); signing.catch(() => {});
      await Promise.race([reachedSign, new Promise((_, reject) => setTimeout(() => reject(new Error('Native signing delay was not reached')), 10000))]);
      await remover.remove(captured.keyId); release();
      await rejected(() => signing, 'cross-store deletion during actual crypto rejects signature');
      check(!await captured.isCurrent(), 'cross-store deletion invalidates freshness');
      const replacement = await remover.create();
      await rejected(() => captured.sign(message), 'replacement cannot revive captured signer');
      check(await replacement.isCurrent(), 'explicit replacement is current');
    } finally { release(); signerStore.close(); remover.close(); }
    return checks;
  }, { entry, databaseName });

  await page.evaluate(({ origin, entry }) => {
    const frame = document.createElement('iframe'); frame.sandbox = 'allow-scripts';
    frame.srcdoc = `<script type="module">const {createWebCryptoIdentityStore}=await import(${JSON.stringify(origin + entry)});const store=createWebCryptoIdentityStore();const results=[];for(const operation of ['load','create','remove']){try{await store[operation]();results.push(false);}catch{results.push(true);}}store.close();parent.postMessage({identityDenied:results},'*');</script>`;
    globalThis.identityDenied = new Promise(resolve => { addEventListener('message', event => { if (event.source === frame.contentWindow && event.data.identityDenied) resolve(event.data.identityDenied); }, { once: true }); });
    document.body.append(frame);
  }, { origin, entry });
  const denied = await page.evaluate(() => Promise.race([globalThis.identityDenied, new Promise((_, reject) => setTimeout(() => reject(new Error('Opaque-origin denial check timed out')), 10000))]));
  assert.deepEqual(denied, [true, true, true]);
  sourceSha256['tools/qa-web-identity.mjs'] = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
  console.log(JSON.stringify({ scope: 'local real-browser WebCrypto and IndexedDB provider; native signing with scheduling instrumentation for deletion race; no endpoint enrollment or physical-device qualification',
    browser: engine, version: browser.version(), node: process.versions.node, sourceSha256,
    checks: [...storage.checks, 'atomic competing tab creation', ...reload, ...lifecycle, 'opaque-origin storage denial fails closed'] }, null, 2));
} finally { await browser?.close(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
