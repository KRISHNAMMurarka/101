import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';

const consumer = realpathSync(resolve(process.argv[2] ?? ''));
assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-sdk-consumer-')), 'Use an owned external packed SDK consumer');
const packed = JSON.parse(readFileSync(join(consumer, 'receipt.json'), 'utf8'));
assert.equal(packed.status, 'pass', 'The packed SDK consumer must have passed');
const names = ['device-model', 'device-runtime', 'transport-webrtc', 'transport-websocket', 'device-web', 'vision', 'connect'];
const imports = Object.fromEntries(names.map(name => [`@101/${name}`, `/@101/${name}/dist/index.js`]));
imports['@101/connect/examples/durable-artifact-jobs'] = '/@101/connect/examples/durable-artifact-jobs.js';
const html = `<!doctype html><meta charset="utf-8"><title>Local durable artifact job QA</title>
<script type="importmap">${JSON.stringify({ imports })}</script>
<script type="module">import * as sdk from '@101/connect';
import { runDurableArtifactJobsExample } from '@101/connect/examples/durable-artifact-jobs';
globalThis.artifactSdk = sdk; globalThis.runArtifactExample = runDurableArtifactJobsExample;</script>`;
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
  if (!/^\/@101\/(device-model|device-runtime|transport-webrtc|transport-websocket|device-web|vision|connect)\/dist\/[a-z0-9-]+\.js$/.test(path) &&
    path !== '/@101/connect/examples/durable-artifact-jobs.js') { response.writeHead(404); response.end(); return; }
  try { response.setHeader('Content-Type', 'text/javascript'); response.end(readFileSync(join(consumer, 'node_modules', path))); }
  catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`, receipts = [];
async function ready(page) { await page.goto(origin); await page.waitForFunction(() => !!globalThis.artifactSdk); }
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext(), page = await context.newPage(), errors = [];
      context.on('page', target => target.on('pageerror', error => errors.push(error.name)));
      page.on('pageerror', error => errors.push(error.name)); await ready(page);
      const generated = await page.evaluate(async () => {
        const port = globalThis.artifactSdk.createIndexedDbArtifactJobStorage(indexedDB, 'sdk-artifact-caller');
        try { return await globalThis.runArtifactExample(port, 'caller-owner', 'caller-job'); } finally { port.close(); }
      });
      assert.equal(generated.status, 'completed'); assert.equal(generated.duplicate, false);
      assert.equal(generated.handlerResult, 'returned'); assert.equal(generated.effectEvidence, 'observed');
      assert.ok(generated.artifactText.startsWith('101 retained local artifact\n'));
      await page.reload(); await page.waitForFunction(() => !!globalThis.artifactSdk);
      const retained = await page.evaluate(async () => {
        const port = globalThis.artifactSdk.createIndexedDbArtifactJobStorage(indexedDB, 'sdk-artifact-caller');
        try { return await globalThis.runArtifactExample(port, 'caller-owner', 'caller-job'); } finally { port.close(); }
      });
      assert.equal(retained.duplicate, true); assert.equal(retained.handlerResult, 'not-started');
      assert.deepEqual(retained.output, generated.output); assert.equal(retained.artifactText, generated.artifactText);
      await page.evaluate(async () => {
        const { createDurableArtifactJobStore, createIndexedDbArtifactJobStorage, createAssetReference } = globalThis.artifactSdk;
        const port = createIndexedDbArtifactJobStorage(indexedDB, 'sdk-artifact-crash');
        const store = createDurableArtifactJobStore({ ownerId: 'alice', storage: port,
          authorize: () => ({ expiresAt: Date.now() + 10000, isCurrent: () => true }) });
        const bytes = new TextEncoder().encode('crash input');
        const selected = { idempotencyKey: 'crash-job', applicationId: 'qa', destinationId: 'local',
          profileId: '101:local-artifact', profileRevision: 1, totalUnits: 2,
          input: await createAssetReference('artifact:crash-input', 'text', bytes) };
        if (!(await store.submit(selected)).ok || !(await store.start('crash-job', bytes)).ok) throw new Error('crash-setup');
        // Retain live objects; closing the page simulates lost execution without clean store shutdown.
        globalThis.crashJobs = { port, store };
      });
      await page.close(); const recoveredPage = await context.newPage(); await ready(recoveredPage);
      const recovery = await recoveredPage.evaluate(async () => {
        const { createDurableArtifactJobStore, createIndexedDbArtifactJobStorage } = globalThis.artifactSdk;
        const check = (value, code) => { if (!value) throw new Error(code); };
        const port = createIndexedDbArtifactJobStorage(indexedDB, 'sdk-artifact-crash');
        let approvals = 0, allowed = false;
        const store = createDurableArtifactJobStore({ ownerId: 'alice', storage: port, authorize: request => {
          approvals++; check(request.ownerId === 'alice' && request.request?.idempotencyKey === 'crash-job', 'recovery-scope');
          return allowed ? { expiresAt: Date.now() + 10000, isCurrent: () => true } : undefined;
        } });
        try {
          const history = await store.inspect();
          check(history.ok && history.value.jobs[0].requiresReview && history.value.jobs[0].lastKnownState === 'running' && approvals === 0, 'no-auto-replay');
          const bytes = new TextEncoder().encode('crash input');
          const deniedStart = await store.start('crash-job', bytes); check(!deniedStart.ok && deniedStart.reason === 'review-required', 'review-required');
          const deniedRecovery = await store.restartReviewed('crash-job', bytes); check(!deniedRecovery.ok && deniedRecovery.reason === 'denied', 'new-grant-required');
          allowed = true; const restarted = await store.restartReviewed('crash-job', bytes); check(restarted.ok, 'reviewed-restart');
          check((await restarted.value.progress(2)).ok && (await restarted.value.commit(new TextEncoder().encode('recovered artifact'))).ok, 'recovery-output');
          const finished = await store.inspect();
          check(finished.ok && finished.value.jobs[0].attempts.map(x => x.outcome).join(',') === 'interrupted,artifact-stored', 'accurate-attempt-history');
          return { pageLoss: true, noAutomaticReplay: true, explicitOwnerReview: true, freshGrant: true, interruptedAttemptRetained: true };
        } finally { await store.close(); port.close(); }
      });
      const faultChecks = await recoveredPage.evaluate(async () => {
        const { createDurableArtifactJobStore, createIndexedDbArtifactJobStorage, createAssetReference } = globalThis.artifactSdk;
        const check = (value, code) => { if (!value) throw new Error(code); };
        const bytes = new TextEncoder().encode('fault input');
        const selected = { idempotencyKey: 'fault-job', applicationId: 'qa', destinationId: 'local', profileId: '101:local-artifact',
          profileRevision: 1, totalUnits: 2, input: await createAssetReference('artifact:fault-input', 'text', bytes) };
        const port = createIndexedDbArtifactJobStorage(indexedDB, 'sdk-artifact-faults');
        let allowed = false; const grantSignal = new AbortController();
        const store = createDurableArtifactJobStore({ ownerId: 'alice', storage: port, authorize: () => allowed
          ? { expiresAt: Date.now() + 10000, isCurrent: () => true, signal: grantSignal.signal } : undefined });
        try {
          check((await store.submit(selected)).ok, 'submit');
          const denied = await store.start('fault-job', bytes); check(!denied.ok && denied.reason === 'denied', 'denial');
          allowed = true;
          const changed = await store.submit({ ...selected, destinationId: 'other' }); check(!changed.ok && changed.reason === 'idempotency-conflict', 'immutable-scope');
          check((await store.submit(selected)).ok, 'same-idempotency');
          const input = await store.start('fault-job', new Uint8Array([1])); check(!input.ok && input.reason === 'integrity', 'input-integrity');
          const running = await store.start('fault-job', bytes); check(running.ok, 'start');
          const badProgress = await running.value.progress(3); check(!badProgress.ok && badProgress.reason === 'invalid', 'progress-bound');
          check((await running.value.progress(2)).ok, 'progress');
          const oversized = await running.value.commit(new Uint8Array(4097)); check(!oversized.ok && oversized.reason === 'capacity', 'artifact-bound');
          check((await store.cancel('fault-job')).ok && running.value.signal.aborted, 'cancel');
          const late = await running.value.commit(bytes); check(!late.ok && late.reason === 'cancelled', 'late-result');
          const none = await store.readOutput('fault-job'); check(!none.ok && none.reason === 'no-output', 'cancel-no-output');
          check((await store.submit({ ...selected, idempotencyKey: 'revoke-job' })).ok, 'revoke-submit');
          const revoking = await store.start('revoke-job', bytes); check(revoking.ok, 'revoke-start');
          grantSignal.abort(); check(revoking.value.signal.aborted, 'immediate-revoke');
          await new Promise(resolve => setTimeout(resolve, 20));
          const history = await store.inspect(); check(history.ok && history.value.jobs[1].state === 'interrupted', 'revoke-history');
          const raw = await port.read(store.key);
          check(!['expiresAt', 'isCurrent', 'privateKey', 'credentials', 'grants'].some(field => raw.includes(field)), 'no-stored-authority');
          const expected = await port.read(store.key);
          check(await port.compareAndSwap(store.key, expected, 'guard must reject', { isCurrent: () => false }) === false && await port.read(store.key) === expected, 'atomic-current-guard');
          const bob = createDurableArtifactJobStore({ ownerId: 'bob', storage: port, authorize: () => undefined });
          const isolated = await bob.inspect(); check(isolated.ok && isolated.value.jobs.length === 0 && bob.key !== store.key, 'owner-isolation'); await bob.close();
          await store.close(); port.close();
          const retired = await createDurableArtifactJobStore({ ownerId: 'alice', storage: port, authorize: () => undefined }).inspect();
          check(!retired.ok && retired.reason === 'unavailable', 'retired-storage');
          return { denied: true, immutableScope: true, inputIntegrity: true, boundedProgress: true, boundedArtifact: true,
            cancellation: true, lateResultFenced: true, immediateRevocation: true, noPersistedAuthority: true, atomicCurrentGuard: true, ownerIsolation: true, retiredStorage: true };
        } finally { await store.close(); port.close(); }
      });
      const corruptionChecks = await recoveredPage.evaluate(async () => {
        const { createDurableArtifactJobStore, createIndexedDbArtifactJobStorage } = globalThis.artifactSdk;
        const check = (value, code) => { if (!value) throw new Error(code); };
        const port = createIndexedDbArtifactJobStorage(indexedDB, 'sdk-artifact-corrupt');
        const store = createDurableArtifactJobStore({ ownerId: 'alice', storage: port,
          authorize: () => ({ expiresAt: Date.now() + 10000, isCurrent: () => true }) });
        const seed = async raw => { const previous = await port.read(store.key); check(await port.compareAndSwap(store.key, previous, raw), 'seed'); };
        try {
          for (const [raw, reason] of [['{private malformed', 'corrupt'], [JSON.stringify({ version: 2, ownerId: 'alice', revision: 1 }), 'incompatible']]) {
            await seed(raw); const failed = await store.inspect(); check(!failed.ok && failed.reason === reason && await port.read(store.key) === raw, 'preservation');
            check((await store.recoverStorageReviewed()).ok, 'explicit-recovery');
          }
          const foreign = JSON.stringify({ version: 1, ownerId: 'bob', revision: 1, jobs: [] }); await seed(foreign);
          const failed = await store.recoverStorageReviewed(); check(!failed.ok && failed.reason === 'wrong-owner' && await port.read(store.key) === foreign, 'foreign-preservation');
          return { corruptPreserved: true, futurePreserved: true, ownerReviewedRecovery: true, foreignOwnerPreserved: true };
        } finally { await store.close(); port.close(); }
      });
      // Real cross-tab transactions, with both owners explicitly approving this pending recovery.
      await recoveredPage.evaluate(async () => {
        const port = globalThis.artifactSdk.createIndexedDbArtifactJobStorage(indexedDB, 'sdk-artifact-tabs');
        const store = globalThis.artifactSdk.createDurableArtifactJobStore({ ownerId: 'alice', storage: port, authorize: () => undefined });
        const bytes = new TextEncoder().encode('tab input');
        const admitted = await store.submit({ idempotencyKey: 'tab-job', applicationId: 'qa', destinationId: 'local', profileId: '101:local-artifact',
          profileRevision: 1, totalUnits: 1, input: await globalThis.artifactSdk.createAssetReference('artifact:tab-input', 'text', bytes) });
        if (!admitted.ok) throw new Error('tab-setup'); port.close();
      });
      const otherPage = await context.newPage(); await ready(otherPage);
      const prepareClaim = async target => target.evaluate(() => {
        const port = globalThis.artifactSdk.createIndexedDbArtifactJobStorage(indexedDB, 'sdk-artifact-tabs');
        let approve; const approval = new Promise(resolve => { approve = resolve; });
        const store = globalThis.artifactSdk.createDurableArtifactJobStore({ ownerId: 'alice', storage: port, authorize: async () => {
          globalThis.claimApprovalReached = true; await approval; return { expiresAt: Date.now() + 10000, isCurrent: () => true };
        } });
        globalThis.claim = { port, store, approve, result: store.restartReviewed('tab-job', new TextEncoder().encode('tab input')) };
      });
      await Promise.all([prepareClaim(recoveredPage), prepareClaim(otherPage)]);
      await Promise.all([recoveredPage.waitForFunction(() => globalThis.claimApprovalReached), otherPage.waitForFunction(() => globalThis.claimApprovalReached)]);
      await Promise.all([recoveredPage.evaluate(() => globalThis.claim.approve()), otherPage.evaluate(() => globalThis.claim.approve())]);
      const getClaim = target => target.evaluate(async () => {
        const result = await globalThis.claim.result;
        if (result.ok) {
          if (!(await result.value.progress(1)).ok || !(await result.value.commit(new TextEncoder().encode('one tab artifact'))).ok) throw new Error('tab-effect');
        }
        await globalThis.claim.store.close(); globalThis.claim.port.close(); return { ok: result.ok, reason: result.reason };
      });
      const claims = await Promise.all([getClaim(recoveredPage), getClaim(otherPage)]);
      assert.equal(claims.filter(x => x.ok).length, 1); assert.equal(claims.filter(x => !x.ok && x.reason === 'conflict').length, 1);
      await otherPage.close();
      assert.deepEqual(errors, []);
      receipts.push({ engine: engine.name(), version: browser.version(), artifact: { byteLength: generated.output.byteLength, sha256: generated.output.sha256 },
        checks: { actualKindJobCaller: true, atomicArtifactAndReceipt: true, durableReload: true, repeatedCallerNoEffect: true,
          ...recovery, ...faultChecks, ...corruptionChecks, simultaneousTabsOneClaim: true }, pageErrors: 0 });
      await context.close();
    } finally { await browser.close(); }
  }
  console.log(JSON.stringify({ schemaVersion: 1, task: 'B04', result: 'pass', profile: { id: '101:local-artifact', revision: 1 },
    sourceTree: packed.source.tree, sdkManifestSha256: packed.manifest.sha256,
    qaToolSha256: createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex'),
    environment: { node: process.version }, receipts, physicalQualification: 'deferred', published: false }, null, 2));
} finally { await new Promise(resolve => server.close(resolve)); }
