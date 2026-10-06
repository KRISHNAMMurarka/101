#!/usr/bin/env node
import { registerHooks } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCoordinatorFixtures } from './qa-https-coordinator.mjs';

export const LOCAL_OPERATOR_LIFETIME_MS = 15_000;
const root = resolve(import.meta.dirname, '..');
const names = ['hub-server', 'protocol', 'pairing', 'device-model', 'device-runtime', 'device-web', 'transport-webrtc', 'transport-websocket', 'vision', 'connect'];

/** Disposable repository-source harness. It accepts no credentials, paths,
 * listener address or remote endpoint. Relay remains explicitly unavailable. */
export async function runLocalOperator(mode, signal, report = value => console.log(JSON.stringify(value))) {
  if (!['exercise', 'serve'].includes(mode)) throw new Error('Select exercise or serve.');
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    const name = specifier.startsWith('@101/') ? specifier.slice(5) : '';
    return nextResolve(names.includes(name) ? pathToFileURL(join(root, 'packages', name, 'src/index.ts')).href : specifier, context);
  } });
  let fixture, startup, timer, wake;
  const lifetime = new AbortController();
  let reason = signal?.aborted ? 'cancelled' : undefined;
  const cancel = () => { reason = 'cancelled'; lifetime.abort(); wake?.(); };
  signal?.addEventListener('abort', cancel, { once: true });
  const waiting = new Promise(resolve => { wake = resolve; });
  const endpoints = [];
  let result;
  try {
    const { prepareOperatorStartup, OPERATOR_CONFIGURATION_PROFILE } = await import('@101/hub-server');
    const { pointerSourceDescriptor, parseDeviceDescriptor } = await import('@101/connect');
    if (reason) return;
    fixture = createCoordinatorFixtures();
    const host = fixture.clients[0], peer = fixture.clients[2], origin = 'https://disposable-operator.example';
    const resource = parseDeviceDescriptor({ ...pointerSourceDescriptor('node'), id: 'disposable-observation', label: 'Disposable observation' });
    const configuration = { schemaVersion: 1, profile: OPERATOR_CONFIGURATION_PROFILE,
      identity: { serverCertificatePem: fixture.server.certificatePem, serverPrivateKeyPem: fixture.server.privateKeyPem, clientCaCertificatePem: fixture.ca,
        enrollments: [host, peer].map(({ principalId, deviceId, certificatePem }) => ({ principalId, deviceId, certificatePem })) },
      origins: [origin], listener: { host: '127.0.0.1', port: 0 },
      directory: { resources: [{ principalId: host.principalId, deviceId: host.deviceId, descriptor: resource, capabilityIds: ['position'] }] },
      storage: { mode: 'ephemeral', acknowledgeLossOnStop: true }, relay: { mode: 'disabled' }, quotas: { profile: 'fixed-coordinator-directory/1' } };
    if (reason) return;
    if (mode === 'exercise') {
      const { runOperatorStartupExample } = await import('../examples/coordinator/operator-startup.ts');
      // The existing actual producer caller owns both starts, all authenticated
      // clients and metadata grants, and retires them in its finally block.
      const proof = await runOperatorStartupExample({ configuration, origin, host, peer, resourceId: resource.id, signal: lifetime.signal });
      if (reason) return;
      result = { event: 'exercised', profile: OPERATOR_CONFIGURATION_PROFILE, proof };
    } else {
      const prepared = prepareOperatorStartup(configuration);
      if (!prepared.ok) throw new Error(prepared.issue.message);
      startup = prepared.controller;
      if (reason) return;
      const started = await startup.start();
      if (!started.ok) throw new Error(started.issue.message);
      endpoints.push(started.endpoint);
      if (reason) return;
      timer = setTimeout(() => { reason = 'expired'; lifetime.abort(); wake(); }, LOCAL_OPERATOR_LIFETIME_MS);
      report({ event: 'ready', profile: OPERATOR_CONFIGURATION_PROFILE, endpoint: started.endpoint,
        lifetimeMs: LOCAL_OPERATOR_LIFETIME_MS, storage: 'ephemeral', relay: 'disabled', grants: 0 });
      await waiting;
    }
  } catch (error) {
    if (!reason) throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    await startup?.stop();
    fixture?.close();
    hooks.deregister();
    // This is emitted only after actual listener retirement and removal of the
    // exact fixture creator's newly owned temporary credentials directory.
    report({ event: 'removed', reason: reason ?? 'completed', endpoints, temporaryCredentialsRemoved: true });
  }
  if (result) report(result);
}

async function main() {
  const [argument, ...extra] = process.argv.slice(2);
  if (extra.length || !['--exercise', '--serve'].includes(argument)) {
    console.error('Use node tools/local-operator.mjs --exercise or --serve. Serve stops after 15 seconds or Ctrl+C.');
    process.exitCode = 2; return;
  }
  const abort = new AbortController(), cancel = () => abort.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try { await runLocalOperator(argument.slice(2), abort.signal); }
  catch { console.error('Disposable operator failed. Check the local Node/OpenSSL requirements and retry. A removed event confirms completed cleanup.'); process.exitCode = 1; }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
