#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';

assert.deepEqual(process.argv.slice(2), ['--source']);
assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
const root = fileURLToPath(new URL('../', import.meta.url));
const owned = mkdtempSync(join(tmpdir(), '101-native-rss-c-'));
const files = ['bindings/resource-runtime/c/one01_rss_runtime.h',
  'bindings/resource-runtime/c/one01_rss_runtime.c', 'bindings/resource-runtime/c/one01_rss_runtime_test.c',
  'examples/native-resource-runtime/rss-agent.c', 'examples/native-resource-runtime/process-port.mjs',
  'examples/native-resource-runtime/consumer.mjs', 'tools/qa-native-resource-runtime.mjs',
  'tests/native-resource-runtime.test.ts'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceSha256 = Object.fromEntries(files.map(path => [path, hash(readFileSync(join(root, path)))]));
const flags = ['clang', '-std=c11', '-D_DARWIN_C_SOURCE', '-Wall', '-Wextra', '-Werror', '-pedantic',
  '-I', join(root, 'bindings/resource-runtime/c')];
const compiler = execFileSync('/usr/bin/xcrun', ['clang', '--version'], { encoding: 'utf8' }).split('\n')[0];
let hooks;
try {
  const harness = join(owned, 'rss-runtime-test'), executable = join(owned, 'rss-agent');
  execFileSync('/usr/bin/xcrun', [...flags, join(root, 'bindings/resource-runtime/c/one01_rss_runtime.c'),
    join(root, 'bindings/resource-runtime/c/one01_rss_runtime_test.c'), '-o', harness], { timeout: 10000 });
  const cChecks = execFileSync(harness, [], { encoding: 'utf8', timeout: 5000 }).trim();
  assert.equal(cChecks, 'native-c-groups:denial,identity,read,stop,replacement,limit,reentrancy-thread-destroy');
  execFileSync('/usr/bin/xcrun', [...flags, join(root, 'bindings/resource-runtime/c/one01_rss_runtime.c'),
    join(root, 'examples/native-resource-runtime/rss-agent.c'), '-o', executable], { timeout: 10000 });
  const executableSha256 = hash(readFileSync(executable));
  const token = '0123456789abcdef0123456789abcdef';
  const denied = spawnSync(executable, [], { input: `READ 1 123 900 ${token}\nSTOP 1\n`, encoding: 'utf8', timeout: 5000 });
  assert.equal(denied.status, 0); assert.match(denied.stdout, /^HELLO 1 [1-9][0-9]*\nDENIED 1\nSTOPPED 1\n$/);
  const wrongVersion = spawnSync(executable, [], { input: `START 2 123 9000 ${token}\n`, encoding: 'utf8', timeout: 5000 });
  assert.equal(wrongVersion.status, 2); assert.match(wrongVersion.stdout, /^HELLO 1 [1-9][0-9]*\n$/);
  const loaded = new Map();
  hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith('@101/')) return nextResolve(specifier, context);
    const name = specifier.slice(5);
    assert.ok(['device-model', 'device-runtime'].includes(name), `Unexpected public dependency ${specifier}`);
    const entry = pathToFileURL(join(root, 'packages', name, 'src/index.ts')).href;
    loaded.set(specifier, entry); return nextResolve(entry, context);
  } });
  const { createNativeRssBridge } = await import('../examples/native-resource-runtime/process-port.mjs');
  const reviewChecks = [];
  const scope = Object.freeze({ ownerId: 'reviewed-c-rss', applicationId: 'qa-native-rss', sessionId: 'review' });
  {
    const registration = new AbortController(); let opened = 0;
    const bridge = createNativeRssBridge({ executable: realpathSync(executable), sha256: executableSha256, scope,
      authorizeRegistration(request) { return { request, expiresAt: performance.now() + 9000, signal: registration.signal }; },
      authorizeRead() {}, onProcess() { opened++; } });
    try { const started = await bridge.start(); assert.equal(started.ok, true, 'signal-only registration grant must start');
      assert.equal(opened, 1); reviewChecks.push('signal-only-grant-is-authority'); }
    finally { await bridge.close(); }
  }
  const approval = (request, signal, ms = 9000) =>
    ({ request, expiresAt: performance.now() + ms, signal: signal.signal });
  for (const mode of ['hidden-currentness', 'forged-signal']) {
    const registration = new AbortController(); let opened = 0;
    const bridge = createNativeRssBridge({ executable: realpathSync(executable), sha256: executableSha256, scope,
      authorizeRegistration(request) { const grant = approval(request, registration);
        return mode === 'hidden-currentness' ? { ...grant, isCurrent: () => true } :
          { ...grant, signal: Object.create(AbortSignal.prototype) }; },
      authorizeRead() {}, onProcess() { opened++; } });
    try { assert.equal((await bridge.start()).ok, false); assert.equal(opened, 0);
      reviewChecks.push(`reject-${mode}-grant`); }
    finally { await bridge.close(); }
  }
  {
    const registration = new AbortController(); let bridge, opened = 0;
    bridge = createNativeRssBridge({ executable: realpathSync(executable), sha256: executableSha256, scope,
      authorizeRegistration(request) { void bridge.stop(); return approval(request, registration); },
      authorizeRead() {}, onProcess() { opened++; } });
    try { const started = await bridge.start(); assert.equal(started.ok, false);
      assert.equal(opened, 0); assert.equal(bridge.status().starts, 0); reviewChecks.push('reentrant-Stop-authorizer-zero-child'); }
    finally { await bridge.close(); }
  }
  {
    const registration = new AbortController(); let opened = 0;
    const bridge = createNativeRssBridge({ executable: realpathSync(executable), sha256: executableSha256, scope,
      authorizeRegistration(request) { registration.abort(); return approval(request, registration); },
      authorizeRead() {}, onProcess() { opened++; } });
    try { assert.equal((await bridge.start()).ok, false); assert.equal(opened, 0);
      reviewChecks.push('registration-signal-abort-in-authorizer-zero-child'); }
    finally { await bridge.close(); }
  }
  {
    const registration = new AbortController(); let startWrites = 0, opened = 0;
    const bridge = createNativeRssBridge({ executable: realpathSync(executable), sha256: executableSha256, scope,
      authorizeRegistration(request) { return approval(request, registration, 10); }, authorizeRead() {},
      onProcess(child) { opened++; const write = child.stdin.write.bind(child.stdin);
        child.stdin.write = (...args) => { if (String(args[0]).startsWith('START ')) startWrites++; return write(...args); };
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
      } });
    try { assert.equal((await bridge.start()).ok, false); assert.equal(opened, 1); assert.equal(startWrites, 0);
      reviewChecks.push('post-observer-expiry-zero-native-start'); }
    finally { await bridge.close(); }
  }
  {
    const registration = new AbortController(); let opened = 0;
    const bridge = createNativeRssBridge({ executable: realpathSync(executable), sha256: executableSha256, scope,
      authorizeRegistration(request) { return approval(request, registration); },
      authorizeRead() {}, onProcess() { opened++; registration.abort(); } });
    try { assert.equal((await bridge.start()).ok, false); assert.equal(opened, 1);
      reviewChecks.push('registration-signal-abort-in-observer-fences-start'); }
    finally { await bridge.close(); }
  }
  for (const mode of ['modify', 'replace']) {
    const source = join(owned, `candidate-${mode}`), replacement = join(owned, `replacement-${mode}`);
    copyFileSync(executable, source); chmodSync(source, 0o700);
    writeFileSync(replacement, 'invalid-native-image');
    const registration = new AbortController(); let bridge, opened = 0, launched;
    bridge = createNativeRssBridge({ executable: realpathSync(source), sha256: executableSha256, scope,
      authorizeRegistration(request) { return approval(request, registration); }, authorizeRead() {}, onProcess(child) {
        opened++; launched = child.spawnfile;
        assert.notEqual(launched, realpathSync(source), 'Launch must use the verified private copy');
        assert.equal(lstatSync(launched).mode & 0o777, 0o500);
        assert.equal(lstatSync(dirname(launched)).mode & 0o777, 0o700);
        if (mode === 'modify') writeFileSync(source, 'invalid-native-image');
        else renameSync(replacement, source);
      } });
    try { const started = await bridge.start(); assert.equal(started.ok, true, `verified private image survives ${mode}`);
      assert.equal(opened, 1); reviewChecks.push(`verified-launch-survives-source-${mode}`); }
    finally { await bridge.close(); if (launched) { assert.equal(existsSync(launched), false);
      assert.equal(existsSync(dirname(launched)), false); } }
  }
  {
    const registration = new AbortController(), read = new AbortController(); let nativeWrites = 0;
    const bridge = createNativeRssBridge({ executable: realpathSync(executable), sha256: executableSha256, scope,
      authorizeRegistration(request) { return approval(request, registration); },
      authorizeRead(request) { registration.abort(); return approval(request, read, 900); },
      onProcess(child) { const write = child.stdin.write.bind(child.stdin);
        child.stdin.write = (...args) => { if (String(args[0]).startsWith('READ ')) nativeWrites++; return write(...args); }; } });
    try { const started = await bridge.start(); assert.ok(started.ok);
      assert.equal((await bridge.read(started.value)).ok, false);
      assert.equal(nativeWrites, 0, 'registration abort during read authorization must precede native READ');
      reviewChecks.push('opposite-registration-abort-in-read-authorizer-zero-native-read'); }
    finally { await bridge.close(); }
  }
  for (const mode of ['read-signal-abort', 'read-approval-expiry']) {
    const registration = new AbortController(), read = new AbortController(); let nativeWrites = 0;
    const bridge = createNativeRssBridge({ executable: realpathSync(executable), sha256: executableSha256, scope,
      authorizeRegistration(request) { return approval(request, registration); },
      authorizeRead(request) { const grant = approval(request, read, mode === 'read-signal-abort' ? 900 : 1);
        if (mode === 'read-signal-abort') read.abort();
        else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        return grant; },
      onProcess(child) { const write = child.stdin.write.bind(child.stdin);
        child.stdin.write = (...args) => { if (String(args[0]).startsWith('READ ')) nativeWrites++; return write(...args); }; } });
    try { const started = await bridge.start(); assert.ok(started.ok, JSON.stringify({ mode, started, status: bridge.status() }));
      assert.equal((await bridge.read(started.value)).ok, false); assert.equal(nativeWrites, 0);
      reviewChecks.push(`${mode}-zero-native-read`); }
    finally { await bridge.close(); }
  }
  {
    const registration = new AbortController(); let raw = '', child;
    const bridge = createNativeRssBridge({ executable: realpathSync(executable), sha256: executableSha256, scope,
      authorizeRegistration(request) { return approval(request, registration, 100); },
      authorizeRead() {}, onProcess(value) { child = value; child.stdout.on('data', chunk => { raw += String(chunk); });
        process.kill(child.pid, 'SIGSTOP'); } });
    try { const starting = bridge.start(); await new Promise(resolve => setTimeout(resolve, 160));
      process.kill(child.pid, 'SIGCONT'); assert.equal((await starting).ok, false);
      await bridge.stop(); assert.equal(raw.includes('READY 1 '), false, 'expired queued START cannot activate native RSS');
      reviewChecks.push('queued-native-start-expiry-before-activation'); }
    finally { if (child?.exitCode === null) { try { process.kill(child.pid, 'SIGCONT'); } catch { /* Child already exited. */ } } await bridge.close(); }
  }
  {
    const registration = new AbortController(), read = new AbortController(); let raw = '', child;
    const bridge = createNativeRssBridge({ executable: realpathSync(executable), sha256: executableSha256, scope,
      authorizeRegistration(request) { return approval(request, registration); },
      authorizeRead(request) { return approval(request, read, 100); },
      onProcess(value) { child = value; child.stdout.on('data', chunk => { raw += String(chunk); }); } });
    try { const started = await bridge.start(); assert.ok(started.ok); process.kill(child.pid, 'SIGSTOP');
      const pending = bridge.read(started.value);
      await new Promise(resolve => setTimeout(resolve, 160)); process.kill(child.pid, 'SIGCONT');
      assert.equal((await pending).ok, false); await bridge.stop();
      assert.ok(raw.includes('DENIED 1\n'), 'expired queued READ must be denied natively');
      assert.equal(raw.includes('SAMPLE 1 '), false, 'expired queued READ must not capture RSS');
      reviewChecks.push('queued-native-read-expiry-before-capture'); }
    finally { if (child?.exitCode === null) { try { process.kill(child.pid, 'SIGCONT'); } catch { /* Child already exited. */ } } await bridge.close(); }
  }
  const { runNativeResourceRuntimeExample } = await import('../examples/native-resource-runtime/consumer.mjs');
  const native = await runNativeResourceRuntimeExample({ executable: realpathSync(executable), sha256: executableSha256 });
  assert.equal(native.profile, 'fixed-own-rss-c/1'); assert.ok(native.rssBytes > 0);
  assert.equal(native.rawPending, 0); assert.equal(native.childAlive, false);
  assert.equal(native.cleanupVerified, true);
  assert.equal(native.oldHandleAccepted, false); assert.equal(native.copiedHandleAccepted, false);
  console.log(JSON.stringify({ result: 'pass', sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    compiler, node: process.version, platform: process.platform, arch: process.arch, sourceSha256,
    executableSha256, nativeCChecks: cChecks, nativeFrameChecks: ['read-before-start-denied', 'wrong-version-closed'], reviewChecks,
    publicEntries: Object.fromEntries(loaded), native,
    clockMapping: { native: 'macOS CLOCK_MONOTONIC nanoseconds', host: 'Node performance.now milliseconds',
      anchor: 'C HELLO sampled before its host receipt', deadline: 'HELLO + host expiry minus host HELLO receipt minus 5 ms',
      assumption: 'These Mac monotonic clocks advance within 5 ms of each other during a bounded 10-second native lifetime; clock divergence or system sleep beyond that bound is unqualified.',
      nativeGate: 'C validates the absolute deadline after approval/currentness callbacks and before task_info, then again before returning the sample.' },
    grantContract: 'Exact {request,expiresAt,signal} with genuine AbortSignal; mutable revocation must abort the signal. Hidden isCurrent callbacks are rejected.',
    trust: 'Cooperative same-user host and fixed private stdio child; no hostile same-process isolation, installed app, other OS, physical device or SDK distribution claim' }, null, 2));
} finally { hooks?.deregister(); rmSync(owned, { recursive: true, force: true }); }
