import { prepareOperatorStartup, createCoordinatorFetcher, createPrivateDirectoryClient, HTTPS_COORDINATOR_LIMITS } from '@101/hub-server';
import type { OperatorConfiguration } from '@101/hub-server';
import { createHttpSignalingSession, HttpControllerSignalingClient } from '@101/pairing';
import { randomUUID } from 'node:crypto';

interface Credential { readonly certificatePem: string; readonly privateKeyPem: string; readonly deviceId: string }
export interface OperatorStartupExampleOptions { readonly configuration: OperatorConfiguration; readonly origin: string;
  readonly host: Credential; readonly peer: Credential; readonly resourceId: string; readonly signal?: AbortSignal }

/** Actual selected Node TLS/operator caller; no persistent authority, relay, physical
 * device or public service claim. Credentials are supplied by the current host. */
export async function runOperatorStartupExample(options: OperatorStartupExampleOptions) {
  const prepared = prepareOperatorStartup(options.configuration); if (!prepared.ok) throw new Error(prepared.issue.message);
  const startup = prepared.controller, callers: ReturnType<typeof createCoordinatorFetcher>[] = [], directories: ReturnType<typeof createPrivateDirectoryClient>[] = [];
  const sessionId = 'OPERATOR-' + randomUUID().replaceAll('-', '').slice(0, 12);
  let replacement: typeof startup | undefined;
  const assertCurrent = () => { if (options.signal?.aborted) throw new Error('Operator exercise cancelled.'); };
  const current = async <T,>(work: () => Promise<T>): Promise<T> => { assertCurrent(); const value = await work(); assertCurrent(); return value; };
  const abort = () => {
    directories.forEach(value => value.close()); callers.forEach(value => value.close());
    // Logical cancellation starts retirement now; finally awaits the same actual
    // owner teardown before the caller may remove credential files or report.
    void startup.stop().catch(() => {}); void replacement?.stop().catch(() => {});
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  const checks: string[] = [];
  const check = (condition: boolean, text: string) => { assertCurrent(); if (!condition) throw new Error(text); checks.push(text); };
  const credential = (endpoint: string, owner: Credential, origin = options.origin) => ({ endpoint, origin,
    caCertificatePem: options.configuration.identity.clientCaCertificatePem, certificatePem: owner.certificatePem, privateKeyPem: owner.privateKeyPem });
  try {
    const initial = startup.snapshot(); check(initial.phase === 'prepared' && initial.endpoint === undefined, 'validation is inert before explicit start');
    check(initial.requirements.storage === 'ephemeral' && initial.requirements.relay === 'disabled' && initial.requirements.authorityLostOnStop &&
      initial.requirements.quotas.coordinator === HTTPS_COORDINATOR_LIMITS, 'selected storage/relay and effective server ceilings are truthful');
    const started = await current(() => startup.start()); if (!started.ok) throw new Error(started.issue.message); const endpoint = started.endpoint;
    const host = createCoordinatorFetcher(credential(endpoint, options.host)), peer = createCoordinatorFetcher(credential(endpoint, options.peer)); callers.push(host, peer);
    const denied = createCoordinatorFetcher(credential(endpoint, options.host, 'https://unlisted-operator.example')); callers.push(denied);
    check((await current(() => denied.fetch(endpoint + '/v1/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }) }))).status === 403,
      'configuration acceptance does not bypass exact origin admission');
    const session = await current(() => createHttpSignalingSession(endpoint, sessionId, { fetcher: host.fetch }));
    const peerClient = new HttpControllerSignalingClient(session.ticket, peer.fetch);
    const lease = await current(() => peerClient.join({ deviceId: options.peer.deviceId, label: 'Enrolled local peer', capabilities: {} }));
    check(!!lease.peerId, 'actual independently authenticated host create and peer join');
    const hostDirectory = createPrivateDirectoryClient({ ...credential(endpoint, options.host), sessionId, role: 'host', token: session.hostToken });
    const peerDirectory = createPrivateDirectoryClient({ ...credential(endpoint, options.peer), sessionId, role: 'peer', peerId: lease.peerId, token: lease.peerToken });
    directories.push(hostDirectory, peerDirectory);
    check((await current(() => peerDirectory.list())).resources.length === 0, 'configured catalog and rendezvous membership grant no directory visibility');
    const expiry = Date.now() + 5000; await current(() => hostDirectory.enroll(options.resourceId, expiry)); await current(() => hostDirectory.allow(lease.peerId, [options.resourceId], expiry));
    const visible = await current(() => peerDirectory.list()); check(visible.resources.length === 1 && visible.resources[0]?.id === options.resourceId, 'explicit current host bearer allows only the provisioned directory resource');
    check(!JSON.stringify(startup.snapshot()).includes(options.resourceId) && !JSON.stringify(startup.snapshot()).includes('PRIVATE KEY'), 'status excludes credentials and personal catalog bytes');
    await current(() => hostDirectory.remove(options.resourceId)); check((await current(() => peerDirectory.list())).resources.length === 0, 'explicit host metadata removal withdraws visibility');
    for (let index = 1; index < HTTPS_COORDINATOR_LIMITS.sessionsPerPrincipal; index++) await current(() => createHttpSignalingSession(endpoint, sessionId + '-' + index, { fetcher: host.fetch }));
    check((await current(() => host.fetch(endpoint + '/v1/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sessionId + '-OVER' }) }))).status === 429,
      'selected fixed per-principal session ceiling is actually enforced');
    await current(() => startup.stop()); check(startup.snapshot().phase === 'stopped' && !(await current(() => startup.start())).ok, 'stop retires owner and prevents restart');
    const newlyPrepared = prepareOperatorStartup(options.configuration); if (!newlyPrepared.ok) throw new Error(newlyPrepared.issue.message); replacement = newlyPrepared.controller;
    const restarted = await current(() => replacement!.start()); if (!restarted.ok) throw new Error(restarted.issue.message);
    const freshHost = createCoordinatorFetcher(credential(restarted.endpoint, options.host)); callers.push(freshHost);
    const freshSession = await current(() => createHttpSignalingSession(restarted.endpoint, sessionId, { fetcher: freshHost.fetch }));
    check(freshSession.hostToken !== session.hostToken && (await current(() => freshHost.fetch(restarted.endpoint + '/v1/sessions/' + sessionId + '/host/peers', { headers: { Authorization: 'Bearer ' + session.hostToken } }))).status === 404,
      'fresh explicit startup restores no previous bearer authority');
    const freshDirectory = createPrivateDirectoryClient({ ...credential(restarted.endpoint, options.host), sessionId, role: 'host', token: freshSession.hostToken }); directories.push(freshDirectory);
    check((await current(() => freshDirectory.list())).resources.length === 0, 'fresh startup restores no old directory enrollments or member grants');
    return Object.freeze({ profile: initial.profile, checks: Object.freeze(checks), actualLocalTlsStartups: 2, independentlyAuthorizedDirectoryRows: visible.resources.length,
      storage: 'ephemeral', relay: 'disabled', resourceGrantsFromConfiguration: false, shutdownDropsAuthority: true });
  } finally { options.signal?.removeEventListener('abort', abort); directories.forEach(value => value.close()); callers.forEach(value => value.close()); await startup.stop(); await replacement?.stop(); }
}
