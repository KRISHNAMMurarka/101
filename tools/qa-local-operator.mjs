#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect, Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runLocalOperator } from './local-operator.mjs';

const root = resolve(import.meta.dirname, '..');
assert.deepEqual(process.argv.slice(2), ['--source']);
const sourcePaths = ['tools/local-operator.mjs', 'tools/qa-local-operator.mjs', 'tools/qa-https-coordinator.mjs',
  'examples/coordinator/operator-startup.ts', 'packages/hub-server/src/index.ts', 'packages/hub-server/src/operator-configuration.ts',
  'packages/hub-server/src/https-coordinator.ts', 'packages/hub-server/src/private-directory.ts'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceSha256 = Object.fromEntries(sourcePaths.map(path => [path, hash(readFileSync(join(root, path)))]));
const environment = { ...process.env }; delete environment.NODE_OPTIONS; delete environment.NODE_PATH;
const checks = [];
async function child(argument, cancelOnReady = false) {
  const directory = mkdtempSync(join(tmpdir(), '101-local-operator-qa-'));
  writeFileSync(join(directory, 'untouched-sentinel'), 'preserve unrelated owner data\n', { mode: 0o600 });
  const processChild = spawn(process.execPath, [join(root, 'tools/local-operator.mjs'), argument], {
    cwd: root, env: { ...environment, TMPDIR: directory }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let text = '', errors = '', sent = false, failure;
  const events = [];
  const timeout = setTimeout(() => { failure ??= new Error('Disposable child exceeded its bounded lifetime'); processChild.kill('SIGTERM'); }, 25_000);
  processChild.stdout.on('data', chunk => {
    if (failure) return;
    try {
    text += chunk;
    assert.ok(Buffer.byteLength(text) <= 32 * 1024, 'Bounded redacted diagnostics');
    while (text.includes('\n')) {
      const end = text.indexOf('\n'), line = text.slice(0, end); text = text.slice(end + 1);
      const value = JSON.parse(line); events.push(value);
      if (value.event === 'ready') {
        assert.equal(new URL(value.endpoint).hostname, '127.0.0.1');
        assert.equal(value.relay, 'disabled'); assert.equal(value.grants, 0);
        const owned = readdirSync(directory).filter(name => name !== 'untouched-sentinel');
        assert.equal(owned.length, 1); assert.match(owned[0], /^101-coordinator-tls-/);
        assert.equal(statSync(join(directory, owned[0])).mode & 0o777, 0o700);
        for (const name of readdirSync(join(directory, owned[0])).filter(name => name.endsWith('.key')))
          assert.equal(statSync(join(directory, owned[0], name)).mode & 0o077, 0);
        if (cancelOnReady && !sent) { sent = true; processChild.kill('SIGTERM'); }
      }
    }
    } catch (error) { failure = error; processChild.kill('SIGTERM'); }
  });
  processChild.stderr.on('data', chunk => { errors += chunk; if (Buffer.byteLength(errors) > 32 * 1024) { failure ??= new Error('Unbounded child errors'); processChild.kill('SIGTERM'); } });
  try {
    const exited = await new Promise((resolve, reject) => { processChild.once('error', reject); processChild.once('close', (code, signal) => resolve({ code, signal })); });
    if (failure) throw failure;
    assert.deepEqual(exited, { code: argument === '--invalid' ? 2 : 0, signal: null });
    assert.deepEqual(readdirSync(directory), ['untouched-sentinel']);
    assert.equal(readFileSync(join(directory, 'untouched-sentinel'), 'utf8'), 'preserve unrelated owner data\n');
    if (argument !== '--invalid') {
      assert.equal(errors, ''); const removed = events.find(value => value.event === 'removed'); assert.ok(removed?.temporaryCredentialsRemoved);
      for (const endpoint of removed.endpoints) {
        const url = new URL(endpoint);
        await new Promise((resolve, reject) => {
          const socket = connect({ host: url.hostname, port: Number(url.port) });
          socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Listener closure check timed out')); });
          socket.once('connect', () => { socket.destroy(); reject(new Error('Owned listener remained open')); });
          socket.once('error', error => error.code === 'ECONNREFUSED' ? resolve() : reject(error));
        });
      }
      for (const forbidden of ['PRIVATE KEY', 'BEGIN CERTIFICATE', 'hostToken', 'joinToken', 'peerToken']) assert.equal(JSON.stringify(events).includes(forbidden), false);
    }
    return events;
  } finally {
    clearTimeout(timeout);
    if (processChild.exitCode === null && processChild.signalCode === null) {
      const closed = new Promise(resolve => processChild.once('close', resolve)); processChild.kill('SIGTERM'); await closed;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}
const exercise = await child('--exercise'); assert.equal(exercise.find(value => value.event === 'exercised').proof.actualLocalTlsStartups, 2);
checks.push('actual mTLS create/join/directory grant/withdraw/quota and fresh-owner exercise; exact owned credentials removed');
const cancelled = await child('--serve', true); assert.equal(cancelled.find(value => value.event === 'removed').reason, 'cancelled');
checks.push('actual loopback listener and 0700/0600 temporary identity; SIGTERM closes listener and removes only owned directory');
const expired = await child('--serve'); assert.equal(expired.find(value => value.event === 'removed').reason, 'expired');
checks.push('actual bounded 15-second lifetime expires and retires native listener and temporary identity');
await child('--invalid'); checks.push('unknown CLI input rejected before temporary identity or listener allocation');
// Observe a genuine producer bind, preserving native arguments and return value.
// Cancellation at that boundary must prevent later grants and a second owner.
const abort = new AbortController(), originalListen = Server.prototype.listen, cancellationEvents = [], listeners = [];
Server.prototype.listen = function (...args) {
  const value = Reflect.apply(originalListen, this, args);
  if (args.includes('127.0.0.1')) this.once('listening', () => { listeners.push({ port: this.address().port, signalAlreadyAborted: abort.signal.aborted }); abort.abort(); });
  return value;
};
try {
  await runLocalOperator('exercise', abort.signal, value => cancellationEvents.push(value));
  assert.equal(listeners.length, 1); assert.equal(listeners[0].signalAlreadyAborted, false);
  assert.equal(cancellationEvents.some(value => value.event === 'exercised'), false);
  assert.equal(cancellationEvents.find(value => value.event === 'removed').reason, 'cancelled');
  checks.push('abort at first actual exercise bind retires current owner, prevents later grants/replacement listener and suppresses success');
} finally { Server.prototype.listen = originalListen; }
console.log(JSON.stringify({ schemaVersion: 1, result: 'pass', profile: 'disposable-loopback-operator/1', node: process.version,
  publicResolution: 'repository-source-barrels', sourceSha256, checks, cancellation: { listeners, events: cancellationEvents }, relay: 'disabled', remoteConnections: 0,
  scope: 'Selected disposable local coordinator/directory only. No persistent backend, TURN/gateway relay, container/service install, production deployment or SIGKILL cleanup claim.' }, null, 2));
