import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';

const consumer = realpathSync(resolve(process.argv[2] ?? ''));
assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-sdk-consumer-')), 'Use an owned external packed SDK consumer');
const packedReceipt = JSON.parse(readFileSync(join(consumer, 'receipt.json'), 'utf8'));
assert.equal(packedReceipt.status, 'pass', 'Packed consumer must have passed');
const names = ['device-model', 'device-runtime', 'transport-webrtc', 'device-web', 'vision', 'connect'];
const imports = Object.fromEntries(names.map(name => [`@101/${name}`, `/@101/${name}/dist/index.js`]));
const html = `<!doctype html><meta charset="utf-8"><title>Local settings storage QA</title>
<script type="importmap">${JSON.stringify({ imports })}</script>
<script type="module">import { createSettingsStore, createIndexedDbSettingsStorage } from '@101/connect';
globalThis.settingsSdk = { createSettingsStore, createIndexedDbSettingsStorage };</script>`;
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
  if (!/^\/@101\/(device-model|device-runtime|transport-webrtc|device-web|vision|connect)\/dist\/[a-z0-9-]+\.js$/.test(path)) {
    response.writeHead(404); response.end(); return;
  }
  try {
    response.setHeader('Content-Type', 'text/javascript'); response.end(readFileSync(join(consumer, 'node_modules', path)));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const receipts = [];
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext(); const page = await context.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.name));
      await page.goto(origin); await page.waitForFunction(() => !!globalThis.settingsSdk);
      const first = await page.evaluate(async () => {
        const { createSettingsStore, createIndexedDbSettingsStorage } = globalThis.settingsSdk;
        const port = createIndexedDbSettingsStorage(indexedDB, 'sdk-settings-qa');
        try {
          const store = createSettingsStore({ ownerId: 'alice', storage: port, availableDevices: () => ['sensor'] });
          const fresh = await store.load();
          const saved = await store.save(0, { preferences: { theme: 'dark', handedness: 'left', motion: 'reduce' },
            profiles: [{ id: 'desk', deviceId: 'sensor', profileId: 'example:scalar', profileRevision: 1, calibration: { scale: 2, offset: -1 } }] });
          return { fresh: fresh.ok && fresh.status === 'fresh', saved: saved.ok && saved.value.revision === 1 };
        } finally { port.close(); }
      });
      assert.deepEqual(first, { fresh: true, saved: true });
      await page.reload(); await page.waitForFunction(() => !!globalThis.settingsSdk);
      const checks = await page.evaluate(async () => {
        const { createSettingsStore, createIndexedDbSettingsStorage } = globalThis.settingsSdk;
        const a = createIndexedDbSettingsStorage(indexedDB, 'sdk-settings-qa');
        const b = createIndexedDbSettingsStorage(indexedDB, 'sdk-settings-qa');
        const check = (value, code) => { if (!value) throw new Error(code); };
        const preferences = { theme: 'light', handedness: 'right', motion: 'system' };
        const options = port => ({ ownerId: 'alice', storage: port, availableDevices: () => ['sensor'] });
        try {
          const left = createSettingsStore(options(a)), right = createSettingsStore(options(b));
          const reload = await left.load();
          check(reload.ok && reload.value.revision === 1 && reload.value.profiles.length === 1 && reload.value.preferences.theme === 'dark', 'durable-reload');
          const writes = await Promise.all([left.save(1, { preferences, profiles: [] }), right.save(1, { preferences, profiles: [] })]);
          check(writes.filter(x => x.ok).length === 1 && writes.filter(x => !x.ok && x.reason === 'conflict').length === 1, 'atomic-conflict');
          const authority = await left.save(2, { preferences, profiles: [], grants: [{ expiresAt: 9999 }] });
          check(!authority.ok && authority.reason === 'invalid', 'authority-rejected');
          const key = left.key;
          const seed = async raw => { const current = await a.read(key); check(await a.compareAndSwap(key, current, raw), 'seed-transaction'); };
          const profile = { id: 'desk', deviceId: 'sensor', profileId: 'example:scalar', profileRevision: 1, calibration: { scale: 1, offset: 0 } };
          await seed(JSON.stringify({ version: 1, ownerId: 'alice', revision: 4, preferences: { theme: 'dark', handedness: 'left' }, profiles: [profile] }));
          const migrated = await left.load();
          check(migrated.ok && migrated.status === 'migrated' && migrated.value.revision === 5 && migrated.value.preferences.motion === 'system', 'v1-migration');
          const future = JSON.stringify({ version: 3, ownerId: 'alice', revision: 6 }); await seed(future);
          const incompatible = await left.load();
          check(!incompatible.ok && incompatible.reason === 'incompatible' && await a.read(key) === future, 'future-preserved');
          await seed('{malformed');
          const corrupt = await left.load();
          check(!corrupt.ok && corrupt.reason === 'corrupt' && await a.read(key) === '{malformed', 'corrupt-preserved');
          const reset = await left.reset(); check(reset.ok && reset.value.revision === 6 && reset.value.profiles.length === 0, 'explicit-recovery');
          const before = await a.read(key);
          check((await left.save(6, { preferences, profiles: [profile] })).ok, 'profile-save');
          await seed(before);
          const rollback = await createSettingsStore({ ...options(a), minimumRevision: 7 }).load();
          check(!rollback.ok && rollback.reason === 'rollback', 'trusted-rollback-floor');
          check((await left.reset()).ok, 'rollback-recovery');
          const bob = createSettingsStore({ ownerId: 'bob', storage: b, availableDevices: () => [] });
          check((await bob.load()).ok && (await bob.save(0, { preferences, profiles: [] })).ok && bob.key !== key, 'owner-isolation');
          const foreign = JSON.stringify({ version: 2, ownerId: 'bob', revision: 20, preferences, profiles: [] }); await seed(foreign);
          const denied = await left.reset(); check(!denied.ok && denied.reason === 'wrong-owner' && await a.read(key) === foreign, 'foreign-reset-rejected');
          await seed(JSON.stringify({ version: 2, ownerId: 'alice', revision: 20, preferences, profiles: [profile] }));
          const absent = createSettingsStore({ ...options(a), availableDevices: () => [] });
          const pruned = await absent.load();
          check(pruned.ok && pruned.status === 'pruned' && pruned.value.revision === 21 && pruned.value.profiles.length === 0, 'removed-device-pruned');
          check(!Object.hasOwn(pruned.value, 'grants') && !Object.hasOwn(pruned.value, 'identity'), 'no-restored-authority');
          a.close();
          const closed = await left.load(); check(!closed.ok && closed.reason === 'unavailable', 'retired-database');
          const deniedPort = createIndexedDbSettingsStorage({ open() { throw new DOMException('Private backend', 'SecurityError'); } }, 'sdk-settings-denied');
          try {
            const unavailable = await createSettingsStore(options(deniedPort)).load();
            check(!unavailable.ok && unavailable.reason === 'unavailable', 'injected-storage-denial');
          } finally { deniedPort.close(); }
          return { durableReload: true, atomicCompareAndSwap: true, migration: true, corruptionRecovery: true, futurePreservation: true,
            trustedRollbackFloor: true, ownerIsolation: true, removedDevicePruning: true, authorityRejected: true, retiredDatabase: true, injectedStorageDenial: true };
        } finally { a.close(); b.close(); }
      });
      assert.deepEqual(errors, []);
      receipts.push({ engine: engine.name(), version: browser.version(), checks, pageErrors: 0 });
      await context.close();
    } finally { await browser.close(); }
  }
  console.log(JSON.stringify({ schemaVersion: 1, task: 'B03', result: 'pass', sourceTree: packedReceipt.source.tree,
    sdkManifestSha256: packedReceipt.manifest.sha256, qaToolSha256: createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex'),
    environment: { node: process.version }, receipts, physicalQualification: 'deferred', published: false }, null, 2));
} finally { await new Promise(resolve => server.close(resolve)); }
