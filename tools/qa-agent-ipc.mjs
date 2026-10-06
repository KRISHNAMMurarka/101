#!/usr/bin/env node
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
assert.ok(args.length === 1 && args[0] === '--workspace-exports' || args.length === 2 && args[0] === '--workspace-exports' && args[1] === '--hub-barrel',
  'Use --workspace-exports [--hub-barrel]; selected public source evidence, not an installed package claim');
assert.equal(process.version, 'v24.14.0', 'Use the pinned Node24.14 native toolchain');
assert.ok(['darwin', 'linux'].includes(process.platform), 'Selected Unix-domain native host only');
const root = fileURLToPath(new URL('../', import.meta.url)), publicEntries = new Map(), loadedSource = new Map();
const names = new Set(['hub-server', 'connect', 'device-model', 'device-runtime', 'device-web', 'transport-webrtc', 'transport-websocket', 'pairing', 'protocol', 'input', 'vision']);
const directHub = !args.includes('--hub-barrel');
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith('@101/')) return nextResolve(specifier, context);
  const name = specifier.slice(5); assert.ok(names.has(name), 'Undeclared public dependency: ' + specifier);
  const entry = pathToFileURL(join(root, 'packages', name, 'src', name === 'hub-server' && directHub ? 'scoped-agent-ipc.ts' : 'index.ts')).href;
  publicEntries.set(specifier, entry); return nextResolve(entry, context);
}, load(url, context, nextLoad) {
  if (url.startsWith(pathToFileURL(join(root, 'packages') + '/').href) && url.endsWith('.ts')) {
    const path = fileURLToPath(url); loadedSource.set(path.slice(root.length), createHash('sha256').update(readFileSync(path)).digest('hex'));
  }
  return nextLoad(url, context);
} });
const nativeChecks = [];
let versionController, blockedController;
try {
  const api = await import('../examples/agent-ipc/consumer.mjs');
  assert.equal(typeof api.runScopedAgentIpcExample, 'function', 'A complete real public native agent caller is required');
  const hub = await import('@101/hub-server');
  const owner = new AbortController(), registration = new AbortController(), reads = new AbortController();
  const approvals = request => ({ request, signal: registration.signal, expiresAt: performance.now() + 9000 });
  versionController = hub.createScopedAgentIpc({ ownerId: 'owned-version-review', signal: owner.signal,
    authorizeRegistration: approvals, authorizeRead: request => ({ request, signal: reads.signal, expiresAt: performance.now() + 1000 }) });
  assert.equal(versionController.status().starts, 0);
  assert.deepEqual(await versionController.start({ purpose: 'declared-next-version', version: 2 }), { ok: false, reason: 'version-mismatch' });
  assert.equal(versionController.status().starts, 1); assert.equal(versionController.status().reads, 0);
  await versionController.close(); assert.equal(versionController.status().cleanupVerified, true);
  nativeChecks.push('declared-version2-versus-actual-native-version1-no-downgrade-or-RSS');
  let observed;
  const blockedOwner = new AbortController();
  blockedController = hub.createScopedAgentIpc({ ownerId: 'owned-blocked-review', signal: blockedOwner.signal,
    authorizeRegistration: approvals, authorizeRead: request => ({ request, signal: reads.signal, expiresAt: performance.now() + 1000 }),
    onAgent(value) { observed = value; } });
  const started = await blockedController.start({ purpose: 'owned-blocked-rss', version: 1 }); assert.ok(started.ok);
  assert.ok(observed); process.kill(observed.pid, 'SIGSTOP');
  const pending = blockedController.readRss(started.value, { purpose: 'owned-blocked-rss', signal: new AbortController().signal });
  assert.equal(blockedController.status().nativePending, 1);
  blockedOwner.abort(); assert.equal(blockedController.status().nativePending, 1);
  assert.equal((await blockedController.start({ purpose: 'forbidden-replacement', version: 1 })).ok, false);
  const issued = await pending; assert.equal(issued.ok, false); assert.equal(issued.issued, true); assert.equal(issued.uncertain, true);
  await blockedController.close();
  assert.equal(blockedController.status().cleanupVerified, true); assert.equal(blockedController.status().nativePending, 0);
  await assert.rejects(stat(observed.socketPath), error => error.code === 'ENOENT');
  await assert.rejects(stat(dirname(observed.socketPath)), error => error.code === 'ENOENT');
  assert.throws(() => process.kill(observed.pid, 0), error => error.code === 'ESRCH');
  nativeChecks.push('actual-owned-SIGSTOP-native-request-retains-raw-slot-through-abort-and-real-exit',
    'issued-work-uncertainty-no-positive-result-after-abort', 'owned-host-directory-cleanup-after-forced-native-exit-not-native-unlink-claim');
  const report = await api.runScopedAgentIpcExample();
  assert.equal(report.result, 'pass'); assert.equal(report.syntheticPositiveResponses, false);
  assert.equal(report.nativeChildrenStarted, 2); assert.equal(report.samples.length, 2);
  assert.deepEqual(report.cleanup, { nativeChildrenAlive: 0, socketsRemaining: 0, operationTimers: 0, rawPending: 0 });
  assert.ok(report.samples.every(sample => sample.rssBytes > 0 && sample.sequence === 1 && sample.quality === 'valid' && sample.sourceTime.clockId !== sample.receiptClockId));
  const pins = ['packages/hub-server/src/scoped-agent-ipc.ts', 'packages/hub-server/src/scoped-agent-ipc.test.ts', 'examples/agent-ipc/consumer.mjs', 'tools/qa-agent-ipc.mjs'];
  const hash = path => createHash('sha256').update(readFileSync(join(root, path))).digest('hex');
  const output = { result: 'pass', node: process.version, platform: process.platform,
    publicSourceMode: directHub ? 'explicit-owned-scoped-agent-module-entry-before-root-barrel-integration' : 'ordinary-integrated-hub-public-barrel',
    publicEntries: Object.fromEntries(publicEntries), sourceSha256: Object.fromEntries(pins.map(path => [path, hash(path)])),
    dependencySourceSha256: Object.fromEntries(loadedSource), nativeChecks, report,
    trust: 'Owned private Unix-domain process capability on this host; cooperative same-user host; no account or sandbox claim',
    exclusions: ['installed-or-published-hub-package', 'update-installation', 'other-OS-qualification', 'user-state', 'UI', 'phone', 'remote'] };
  const text = JSON.stringify(output); assert.equal(text.includes('private-retirement-error-sentinel'), false);
  console.log(JSON.stringify(output, null, 2));
} finally { await versionController?.close(); await blockedController?.close(); hooks.deregister(); }
