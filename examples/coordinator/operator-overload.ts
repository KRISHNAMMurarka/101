import { prepareOperatorStartup, createCoordinatorFetcher, HTTPS_COORDINATOR_LIMITS } from '@101/hub-server';
import type { OperatorConfiguration, OperatorStartupController } from '@101/hub-server';
import { PRIVATE_DIRECTORY_LIMITS, parsePrivateDirectorySnapshot } from '@101/device-model';
import { createHttpSignalingSession, HttpControllerSignalingClient } from '@101/pairing';
import type { CreatedSignalingSession, ControllerLease } from '@101/pairing';
import { setTimeout as delay } from 'node:timers/promises';

interface Credential { readonly certificatePem: string; readonly privateKeyPem: string; readonly principalId: string; readonly deviceId: string }
export interface OperatorOverloadDrillOptions { readonly configuration: OperatorConfiguration; readonly origin: string;
  /** Exactly five separately enrolled, host-provisioned disposable credentials. No device-supplied selector. */
  readonly credentials: readonly Credential[]; readonly signal?: AbortSignal }

/** Explicit disposable local operator drill. Import/preparation binds nothing.
 * All positive admissions and negative statuses come from the actual loopback
 * TLS1.3 coordinator. Declared directory rows remain inert metadata; no device
 * read/write/invoke or physical capability is exercised or granted here.
 * Original 60s session expiry is observed without clock or quota substitution. */
export async function runOperatorOverloadDrill(options: OperatorOverloadDrillOptions) {
  const began = performance.now(), lifetime = new AbortController(), checks: string[] = [];
  if (options.signal?.aborted) throw new Error('Operator overload drill aborted before startup.');
  const config = options.configuration, credentials = options.credentials;
  if (config.listener.host !== '127.0.0.1' || config.listener.port !== 0 || credentials.length !== 5 ||
    config.directory.resources.length !== PRIVATE_DIRECTORY_LIMITS.resourcesPerSession + 2 ||
    !credentials.every(credential => config.identity.enrollments.some(value => value.principalId === credential.principalId &&
      value.deviceId === credential.deviceId && value.certificatePem === credential.certificatePem))) {
    throw new Error('Operator overload drill requires its bounded disposable configuration.');
  }
  const resources = config.directory.resources, hostResources = resources.filter(value => value.principalId === credentials[0]!.principalId && value.deviceId === credentials[0]!.deviceId);
  if (hostResources.length !== PRIVATE_DIRECTORY_LIMITS.resourcesPerSession + 1) throw new Error('Operator overload drill requires the selected owned catalog.');
  const foreign = resources.find(value => value.principalId !== credentials[0]!.principalId)!;
  let operationTimers = 0, pendingRequests = 0, nativeRequests = 0, caseName = 'preparation';
  const statuses: Record<string, number> = Object.create(null);
  const abort = () => lifetime.abort(); options.signal?.addEventListener('abort', abort, { once: true });
  const deadline = setTimeout(abort, 85_000); operationTimers++;
  let startup: OperatorStartupController | undefined;
  const callers: ReturnType<typeof createCoordinatorFetcher>[] = [];
  const check = (condition: boolean, name: string) => { caseName = name; if (!condition) throw new Error('Drill assertion failed.'); checks.push(name); };
  async function until(at: number) {
    while (Date.now() < at) {
      if (lifetime.signal.aborted) throw new Error('Drill stopped.');
      operationTimers++;
      try { await delay(Math.min(500, at - Date.now()), undefined, { signal: lifetime.signal }); }
      finally { operationTimers--; }
    }
  }
  const nextWindow = () => until(Math.floor(Date.now() / 1000) * 1000 + 1050);
  try {
    const relay = prepareOperatorStartup({ ...config, relay: { mode: 'enabled', credential: 'excluded-secret' } });
    check(!relay.ok && relay.issue.code === 'relay-unsupported', 'relay-configuration-rejected');
    const region = prepareOperatorStartup({ ...config, regions: ['unavailable-region'] });
    check(!region.ok && region.issue.code === 'configuration-invalid', 'regions-configuration-rejected');
    const prepared = prepareOperatorStartup(config); if (!prepared.ok) throw new Error('Drill startup rejected.');
    startup = prepared.controller;
    const started = await prepared.controller.start(); if (!started.ok || lifetime.signal.aborted) throw new Error('Drill startup unavailable.');
    const endpoint = started.endpoint;
    for (const credential of credentials) callers.push(createCoordinatorFetcher({ endpoint, origin: options.origin,
      caCertificatePem: config.identity.clientCaCertificatePem, certificatePem: credential.certificatePem, privateKeyPem: credential.privateKeyPem }));
    const fetchers: typeof fetch[] = callers.map(caller => async (input, init) => {
      if (lifetime.signal.aborted || nativeRequests >= 160) throw new Error('Drill request admission exhausted.');
      nativeRequests++; pendingRequests++;
      try {
        const signal = init?.signal ? AbortSignal.any([lifetime.signal, init.signal]) : lifetime.signal;
        const result = await caller.fetch(input, { ...init, signal }); statuses[result.status] = (statuses[result.status] ?? 0) + 1;
        return result;
      } finally { pendingRequests--; }
    });
    const send = (principal: number, path: string, method = 'GET', token?: string, body?: unknown) => fetchers[principal]!(endpoint + path, {
      method, ...(token ? { headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) } } :
        body === undefined ? {} : { headers: { 'Content-Type': 'application/json' } }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const create = (principal: number, id: string) => createHttpSignalingSession(endpoint, id, { ttlMs: 60_000, fetcher: fetchers[principal]! });
    const sessions: CreatedSignalingSession[] = [];
    caseName = 'native-session-admission';
    for (let index = 0; index < HTTPS_COORDINATOR_LIMITS.sessionsPerPrincipal; index++) sessions.push(await create(0, 'OVERLOAD-A-' + index));
    check((await send(0, '/v1/sessions', 'POST', undefined, { sessionId: 'OVERLOAD-A-EXTRA' })).status === 429, 'principal-session-capacity-rejected');
    sessions.push(await create(1, 'OVERLOAD-B-0')); check(sessions.length === 5, 'other-principal-session-independent');
    for (let principal = 1; principal < 4; principal++) for (let index = principal === 1 ? 1 : 0; index < HTTPS_COORDINATOR_LIMITS.sessionsPerPrincipal; index++) {
      sessions.push(await create(principal, 'OVERLOAD-' + principal + '-' + index));
    }
    check(sessions.length === HTTPS_COORDINATOR_LIMITS.sessions &&
      (await send(4, '/v1/sessions', 'POST', undefined, { sessionId: 'OVERLOAD-GLOBAL-EXTRA' })).status === 429, 'global-session-capacity-rejected');
    const selected = sessions[0]!, selectedPath = '/v1/sessions/' + selected.ticket.sessionId;
    check((await send(1, selectedPath + '/host/peers', 'GET', selected.hostToken)).status === 404, 'copied-host-bearer-rejected');
    await nextWindow(); caseName = 'native-peer-admission';
    const peers = [0, 1, 2].map(index => new HttpControllerSignalingClient(sessions[index]!.ticket, fetchers[4]!));
    const leases: ControllerLease[] = [];
    const device = { deviceId: credentials[4]!.deviceId, label: 'Display label grants no identity', capabilities: {} };
    for (let index = 0; index < HTTPS_COORDINATOR_LIMITS.peersPerSession; index++) leases.push(await peers[0]!.join(device));
    check((await send(4, selectedPath + '/peers', 'POST', selected.ticket.joinToken, device)).status === 429, 'session-peer-capacity-rejected');
    for (let index = 0; index < HTTPS_COORDINATOR_LIMITS.peersPerSession; index++) await peers[1]!.join(device);
    check((await send(4, '/v1/sessions/' + sessions[2]!.ticket.sessionId + '/peers', 'POST', sessions[2]!.ticket.joinToken, device)).status === 429,
      'principal-peer-capacity-rejected');
    const departed = leases[0]!; await peers[0]!.leave(departed);
    check((await send(4, selectedPath + '/peers/' + departed.peerId + '/offer', 'GET', departed.peerToken)).status === 404, 'departure-retires-old-lease');
    const retried = await peers[2]!.join(device); check(retried.peerId !== departed.peerId, 'fresh-peer-retry-admitted');
    const independent = new HttpControllerSignalingClient(sessions[2]!.ticket, fetchers[3]!);
    check((await independent.join({ ...device, deviceId: credentials[3]!.deviceId })).peerId !== retried.peerId, 'other-peer-principal-independent');
    await nextWindow(); caseName = 'native-directory-admission';
    const directoryPath = selectedPath + '/host/directory', expiry = Date.now() + 20_000, shortExpiry = Date.now() + 1500;
    for (let index = 0; index < PRIVATE_DIRECTORY_LIMITS.resourcesPerSession; index++) {
      const result = await send(0, directoryPath + '/resources', 'POST', selected.hostToken,
        { resourceId: hostResources[index]!.descriptor.id, expiresAt: index === PRIVATE_DIRECTORY_LIMITS.resourcesPerSession - 1 ? shortExpiry : expiry });
      if (result.status !== 201) throw new Error('Drill directory admission failed.');
    }
    const extraResource = hostResources[PRIVATE_DIRECTORY_LIMITS.resourcesPerSession]!.descriptor.id;
    check((await send(0, directoryPath + '/resources', 'POST', selected.hostToken, { resourceId: extraResource, expiresAt: expiry })).status === 429,
      'directory-capacity-rejected');
    check((await send(0, directoryPath + '/resources', 'POST', selected.hostToken, { resourceId: foreign.descriptor.id, expiresAt: expiry })).status === 404,
      'foreign-resource-rejected-before-capacity');
    check((await send(1, directoryPath, 'GET', selected.hostToken)).status === 404 &&
      (await send(0, '/v1/sessions/' + sessions[1]!.ticket.sessionId + '/host/directory', 'GET', selected.hostToken)).status === 404,
      'copied-directory-bearer-rejected');
    const member = leases[1]!, peerDirectoryPath = selectedPath + '/peers/' + member.peerId + '/directory';
    const list = async () => parsePrivateDirectorySnapshot(await (await send(4, peerDirectoryPath, 'GET', member.peerToken)).json());
    check((await list()).resources.length === 0, 'peer-has-no-implicit-visibility');
    const expiringId = hostResources[PRIVATE_DIRECTORY_LIMITS.resourcesPerSession - 1]!.descriptor.id;
    if ((await send(0, directoryPath + '/members/' + member.peerId, 'PUT', selected.hostToken,
      { resourceIds: [expiringId], expiresAt: expiry })).status !== 204) throw new Error('Drill explicit visibility failed.');
    const visible = await list(); check(visible.resources.length === 1 && visible.resources[0]!.id === expiringId, 'explicit-metadata-visibility');
    await until(shortExpiry + 10);
    check((await send(0, directoryPath + '/resources', 'POST', selected.hostToken, { resourceId: extraResource, expiresAt: expiry })).status === 201,
      'actual-directory-expiry-frees-capacity');
    if ((await send(0, directoryPath + '/resources/' + hostResources[0]!.descriptor.id, 'DELETE', selected.hostToken)).status !== 204 ||
      (await send(0, directoryPath + '/resources', 'POST', selected.hostToken, { resourceId: expiringId, expiresAt: expiry })).status !== 201) {
      throw new Error('Drill re-enrollment failed.');
    }
    check((await list()).resources.length === 0, 'reenrollment-does-not-restore-visibility');
    await nextWindow(); caseName = 'actual-native-rate-window'; const rateWindow = Math.floor(Date.now() / 1000);
    for (let index = 0; index < HTTPS_COORDINATOR_LIMITS.requestsPerSecond; index++) {
      if ((await send(0, '/v1/health')).status !== 200) throw new Error('Drill rate fill rejected early.');
    }
    check(Math.floor(Date.now() / 1000) === rateWindow && (await send(0, '/v1/health')).status === 429, 'principal-rate-capacity-rejected');
    check((await send(1, '/v1/health')).status === 200, 'other-principal-rate-independent');
    await nextWindow(); check((await send(0, '/v1/health')).status === 200, 'actual-next-window-explicit-retry');
    caseName = 'actual-session-wall-clock-expiry';
    const latestExpiry = Math.max(...sessions.map(session => session.ticket.expiresAt));
    await until(latestExpiry + 10);
    check((await send(0, selectedPath + '/host/peers', 'GET', selected.hostToken)).status === 404 &&
      (await send(4, selectedPath + '/peers', 'POST', selected.ticket.joinToken, device)).status === 404,
      'actual-session-expiry-retires-bearers-and-invitations');
    const fresh = await create(0, 'OVERLOAD-A-EXPLICIT-RETRY'), otherFresh = await create(4, 'OVERLOAD-GLOBAL-EXPLICIT-RETRY');
    check(fresh.hostToken !== selected.hostToken && otherFresh.ticket.sessionId !== fresh.ticket.sessionId,
      'actual-session-expiry-frees-principal-and-global-capacity');
  } catch { throw new Error('Operator overload drill failed at ' + caseName + '.'); }
  finally {
    lifetime.abort(); options.signal?.removeEventListener('abort', abort); clearTimeout(deadline); operationTimers--;
    for (const caller of callers) caller.close();
    if (startup) await startup.stop();
  }
  return Object.freeze({ profile: 'operator-loopback-overload-drill/1', checks: Object.freeze(checks), elapsedMs: performance.now() - began,
    nativeRequests, observedStatusCounts: Object.freeze(statuses), limits: Object.freeze({ coordinator: HTTPS_COORDINATOR_LIMITS, directory: PRIVATE_DIRECTORY_LIMITS }),
    resourceOperationsExercised: 0, syntheticPositiveResponses: false, clock: 'actual-wall-clock-no-substitution',
    cleanup: Object.freeze({ callersClosed: callers.length, ownerPhase: startup!.snapshot().phase, operationTimers, pendingRequests }) });
}
