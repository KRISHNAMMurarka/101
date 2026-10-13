import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, readdirSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import type { Socket } from 'node:net';
import { createDeviceRuntime, createWorkloadHandoff, createApplicationSnapshot, restoreApplicationSnapshot,
  createEphemeralWebIdentity, RemoteResourcePublisher, RemoteResourceReceiver, authenticatedPeerScope, parseDeviceDescriptor } from '@101/connect';
import type { HandoffHost, HandoffEpoch, JsonValue, Connection, EndpointHandle, DeviceRuntime } from '@101/connect';
import { createAuthenticatedLoopbackRelay, connectAuthenticatedRelay } from '@101/hub-server/loopback-relay';
import { hostedApplicationRequirements, HOSTED_APPLICATION_SOURCE_SHA256 } from '@101/hub-server/hosted-application';
import type { AuthenticatedRelayClient } from '@101/hub-server/loopback-relay';
import { createCoordinatorFixtures } from '../../tools/qa-https-coordinator.mjs';

export const CROSS_HOST_WORKLOAD_PROFILE = 'loopback-node-workload-handoff/1' as const;
export const CROSS_HOST_WORKLOAD_LIMITS = Object.freeze({ concurrentRuns: 1, scenarios: 3, scenarioMs: 15000, aggregateNativeMs: 45000,
  hostProcessesConcurrent: 2, hostStartsPerScenario: 3, rasterChildrenConcurrent: 2, rasterStartsPerScenario: 9, gatewayStartsPerScenario: 2,
  relayPairsConcurrent: 4, clientAttemptsPerScenario: 16, rawIpcPerHost: 1, ipcInboundQueuedPerHost: 1, ipcAttemptsPerHost: 64, ipcMessageBytes: 4096, ipcLifetimeBytes: 65536,
  hostRegistrations: 8, hostRoutes: 4, hostRaw: 2, reliableQueue: 1, latestFrameSlot: 1, frameBytes: 64,
  commandOffersPerScenario: 16, frameOffersPerScenario: 32, routeLeaseMs: 1000, maxAgeMs: 250,
  waitMs: 2500, waitTurnsPerScenario: 1600, checks: 32, receiptBytes: 16384,
  unrelatedTargetPreparationDelayMs: 650, sourcePreparationSamplingWaitMs: 150 });
export interface CrossHostWorkloadScenario {
  readonly name: string; readonly hostPids: readonly number[]; readonly effects: number;
  readonly outputEffects: readonly number[]; readonly admissions: number; readonly releases: number;
  readonly nativeStarts: number; readonly rawIssued: number; readonly rawSettled: number;
  readonly recoveryMs: readonly number[]; readonly originalClockDomains: readonly string[];
  readonly sourcePreparationFrameSequences: readonly number[];
}
export interface CrossHostWorkloadReceipt {
  readonly profile: typeof CROSS_HOST_WORKLOAD_PROFILE; readonly result: 'pass'; readonly checks: readonly string[];
  readonly scenarios: readonly CrossHostWorkloadScenario[];
  readonly cleanup: Readonly<{ processes: 0; callbacks: 0; sockets: 0; timers: 0; fixturesRemoved: true }>;
  readonly scope: Readonly<{ independentNodeProcesses: true; physicalMachines: false; actualIpLoss: false;
    gatewayPlaintextTrusted: true; installedHub: false; captureClockMapping: false; performanceSlo: false;
    rawCounters: 'provider-input-api-invocations-not-system-writes'; issuedEffectsCanCompleteBeforeAbort: true;
    unrelatedTargetPreparationDelayMs: 650; sourcePreparationSamplingWaitMs: 150 }>;
}
const nativeAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const addEvent = EventTarget.prototype.addEventListener, removeEvent = EventTarget.prototype.removeEventListener;
const now = performance.now.bind(performance), encoder = new TextEncoder();
let reserved = false;
const applicationId = 'cross-host-raster';
function active(value: unknown): value is AbortSignal { try { return nativeAborted.call(value) === false; } catch { return false; } }
function object(value: unknown): Record<string, unknown> { if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw Error('Cross-host reply invalid'); return value as Record<string, unknown>; }
function number(value: unknown): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw Error('Cross-host reply invalid'); return value; }
function validState(value: JsonValue): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value).sort().join(',') === 'revision,x,y' && Number.isInteger(value.x) && Number(value.x) >= 0 && Number(value.x) <= 3 &&
    Number.isInteger(value.y) && Number(value.y) >= 0 && Number(value.y) <= 3 && Number.isInteger(value.revision) && Number(value.revision) >= 0 && Number(value.revision) <= 32;
}
function cursorDevice() {
  return parseDeviceDescriptor({ schemaVersion: 1, id: 'shared-cursor-source', label: 'Owned software cursor', revision: 1,
    adapter: { id: 'example:cross-host-cursor', version: '1.0.0' }, runtime: { platform: 'node-software' }, capabilities: [{
      id: 'cursor', semantic: 'connect:hosted-cursor', schemaVersion: 1, kind: 'event', value: { type: 'record', fields: {
        x: { type: 'scalar', unit: '1', min: 0, max: 3, resolution: 1 }, y: { type: 'scalar', unit: '1', min: 0, max: 3, resolution: 1 } } },
      permissions: ['subscribe'], delivery: { mode: 'reliable', maxAgeMs: 250 } }] });
}
const hashPixels = (pixels: unknown) => {
  if (!Array.isArray(pixels) || pixels.length !== 64 || pixels.some(value => !Number.isInteger(value) || value < 0 || value > 255)) throw Error('Native raster invalid');
  return createHash('sha256').update(Uint8Array.from(pixels as number[])).digest('hex');
};
function marker(x: number, y: number) { const pixels: number[] = []; for (let row = 0; row < 4; row++) for (let column = 0; column < 4; column++) pixels.push(...(column === x && row === y ? [255, 0, 64, 255] : [0, 32, 0, 255])); return hashPixels(pixels); }
const diagnosticCode = (value: unknown) => typeof value === 'string' && /^[A-Z0-9_]{1,32}$/.test(value) ? value : 'unknown';

/** Fixed adjacent native runtime host. One semantic IPC operation and its actual
 * send callback remain reserved until response+callback or actual process close. */
class HostPort {
  readonly child: ChildProcess; readonly closed: Promise<void>; pid = 0; keyId = ''; alive = true;
  readonly nativePids = new Set<number>(); summary: Record<string, unknown> = {};
  private done!: () => void; private reply?: { id: number; resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void };
  private sequence = 0; private bytes = 0; private callbacks = new Set<Promise<void>>(); private callDone?: Promise<unknown>;
  private hello!: (value: void) => void; readonly ready = new Promise<void>(resolve => { this.hello = resolve; });
  readonly reports: Record<string, unknown>[] = []; private stderrBytes = 0;
  private stderrTail = '';
  private startup: { spawnEnteredAt: number; spawnReturnedAt: number; spawnAt?: number; helloAt?: number;
    closeAt?: number; exitCode?: number | null; signalCode?: string | null; errorCode?: string } = { spawnEnteredAt: 0, spawnReturnedAt: 0 };
  private milestones: { event: string; childAt: number; receivedAt: number }[] = [];
  constructor() {
    const environment: NodeJS.ProcessEnv = { NODE_ENV: 'production', PATH: process.env.PATH };
    if (process.env.CROSS_HOST_RESOLUTIONS) environment.CROSS_HOST_RESOLUTIONS = process.env.CROSS_HOST_RESOLUTIONS;
    this.closed = new Promise(resolve => { this.done = resolve; });
    this.startup.spawnEnteredAt = now();
    this.child = spawn(process.execPath, ['--import', new URL('../../tools/qa-cross-host-workload.mjs?host-loader', import.meta.url).href,
      new URL('./runtime-host.mjs', import.meta.url).pathname], { env: environment, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    this.startup.spawnReturnedAt = now();
    this.child.once('spawn', () => { this.startup.spawnAt = now(); });
    this.child.on('error', error => { this.startup.errorCode = diagnosticCode((error as NodeJS.ErrnoException).code); this.child.kill('SIGTERM'); });
    this.child.stderr?.on('data', (value: Buffer) => {
      this.stderrBytes += value.byteLength; if (this.stderrBytes > 4096) { this.child.kill('SIGTERM'); return; }
      this.stderrTail += value.toString();
      for (;;) {
        const end = this.stderrTail.indexOf('\n'); if (end < 0) break;
        const line = this.stderrTail.slice(0, end); this.stderrTail = this.stderrTail.slice(end + 1);
        try {
          const record = object(JSON.parse(line));
          if (Object.keys(record).sort().join(',') === 'at,event,kind' && record.kind === 'cross-host-startup' &&
            ['loader-body-enter', 'module-body-enter', 'identity-ready', 'hello-sent'].includes(String(record.event)) &&
            typeof record.at === 'number' && Number.isFinite(record.at) && record.at >= 0 &&
            this.milestones.length < 4 && !this.milestones.some(value => value.event === record.event))
            this.milestones.push({ event: record.event as string, childAt: record.at, receivedAt: now() });
        } catch { /* Raw child stderr is never retained in public diagnostics. */ }
      }
    });
    this.child.on('message', value => {
      try {
        const message = object(value); if (encoder.encode(JSON.stringify(message)).byteLength > 4096) throw Error('Host reply quota');
        if (message.kind === 'hello') { this.pid = number(message.pid); if (typeof message.keyId !== 'string' || !/^[a-f0-9]{64}$/.test(message.keyId)) throw Error('Host key invalid'); this.keyId = message.keyId; this.startup.helloAt = now(); this.hello(); return; }
        if (message.nativePids !== undefined) {
          if (!Array.isArray(message.nativePids) || message.nativePids.length > 3) throw Error('Native child count invalid');
          for (const pid of message.nativePids) { if (!Number.isSafeInteger(pid) || pid < 1) throw Error('Native PID invalid'); this.nativePids.add(pid); }
        }
        const selected = this.reply; if (!selected || message.id !== selected.id) return;
        if (message.ok !== true) { selected.reject(Error('Native host refused fixed ' + String(message.phase ?? 'operation'))); return; }
        const result = object(message.value); this.reports.push(result); if ('rawIssued' in result) this.summary = { ...this.summary, ...result }; if (this.reports.length > 64) throw Error('Host reply quota'); selected.resolve(result);
      } catch { this.child.kill('SIGTERM'); }
    });
    this.child.once('close', (code, signal) => { this.startup.closeAt = now(); this.startup.exitCode = code;
      this.startup.signalCode = signal === null ? null : diagnosticCode(signal);
      this.alive = false; this.reply?.reject(Error('Native host closed')); this.hello(); this.done(); });
  }
  diagnostics() { return Object.freeze({ ...this.startup, stderrBytes: this.stderrBytes,
    milestones: Object.freeze(this.milestones.map(value => Object.freeze({ ...value }))) }); }
  async call(kind: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (!this.alive || this.reply || this.callDone || this.sequence >= 64 || this.callbacks.size) throw Error('Host control busy or closed');
    const id = ++this.sequence, message = { ...fields, kind, id }, bytes = encoder.encode(JSON.stringify(message)).byteLength;
    if (bytes > 4096 || this.bytes + bytes > 65536) throw Error('Host control quota'); this.bytes += bytes;
    let yes!: (value: Record<string, unknown>) => void, no!: (error: Error) => void;
    const response = new Promise<Record<string, unknown>>((resolve, reject) => { yes = resolve; no = reject; });
    this.reply = { id, resolve: yes, reject: no }; void response.catch(() => {});
    let sent!: () => void; const callback = new Promise<void>(resolve => { sent = resolve; }); this.callbacks.add(callback);
    const timeout = setTimeout(() => { this.child.kill('SIGTERM'); }, 2500);
    const work = (async () => {
      try {
        try { this.child.send(message, error => { this.callbacks.delete(callback); sent(); if (error) this.child.kill('SIGTERM'); }); }
        catch { this.callbacks.delete(callback); sent(); this.child.kill('SIGTERM'); }
        const result = await response; await callback; return result;
      } catch (error) { await this.closed; await callback; throw error; }
      finally { clearTimeout(timeout); if (this.reply?.id === id) this.reply = undefined; }
    })(); this.callDone = work;
    try { return await work; } finally { if (this.callDone === work) this.callDone = undefined; }
  }
  pending() { return this.callbacks.size + Number(!!this.callDone); }
  async stop(): Promise<void> {
    if (this.alive) {
      if (!this.callDone) { try { await this.call('close'); } catch { /* Native close is independently awaited. */ } }
      if (this.alive) this.child.kill('SIGTERM');
    }
    await this.closed; await Promise.allSettled([...this.callbacks]); if (this.callDone) await this.callDone.catch(() => {});
    for (const pid of this.nativePids) {
      let alive = false; try { process.kill(pid, 0); alive = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      if (alive) throw Error('Observed owned native raster child remains alive after host stop');
    }
  }
}

/** Two real process hosts and existing native raster programs, not embedded
 * callbacks. Owner fixture and gateway are trusted with plaintext. All controls
 * are fixed, local and disposable; no caller credentials/paths/code accepted. */
export async function runCrossHostWorkloadQualification(options: { readonly signal: AbortSignal }): Promise<Readonly<CrossHostWorkloadReceipt>> {
  if (reserved) throw Error('Cross-host runner busy'); reserved = true;
  let fixture: ReturnType<typeof createCoordinatorFixtures> | undefined, directory: string | undefined, failure: unknown;
  let selectedSignal: AbortSignal | undefined;
  const owner = new AbortController(), hosts = new Set<HostPort>(), sockets = new Map<Socket, Promise<void>>(), timers = new Set<ReturnType<typeof setTimeout>>();
  const operations = new AsyncLocalStorage<object>(), tag = Object.freeze({}), nativeSockets = channel('net.client.socket');
  const checks: string[] = [], scenarios: CrossHostWorkloadScenario[] = [], cleanups: (() => Promise<void>)[] = [];
  const native = <T>(work: () => T): T => operations.run(tag, work);
  const socketObserver = (message: unknown) => {
    if (operations.getStore() !== tag) return;
    const socket = (message as { socket: Socket }).socket;
    const settled = new Promise<void>(resolve => socket.once('close', () => { sockets.delete(socket); resolve(); })); sockets.set(socket, settled);
    if (!active(owner.signal)) socket.destroy();
  };
  const cancel = () => { owner.abort(); for (const host of hosts) host.child.kill('SIGTERM'); for (const socket of sockets.keys()) socket.destroy(); };
  function current() { if (!active(owner.signal) || !active(selectedSignal)) throw Error('Cross-host run retired'); }
  function check(condition: unknown, name: string) { current(); if (!condition || checks.length >= 32) throw Error('Cross-host assertion: ' + name); checks.push(name); }
  const wait = (ms: number) => new Promise<void>(resolve => { const timer = setTimeout(() => { timers.delete(timer); resolve(); }, ms); timers.add(timer); });
  try {
    if (!options || Object.getPrototypeOf(options) !== Object.prototype || Reflect.ownKeys(options).join(',') !== 'signal') throw Error('Cross-host owner signal invalid');
    const descriptor = Object.getOwnPropertyDescriptor(options, 'signal');
    if (!descriptor || !('value' in descriptor) || !active(descriptor.value)) throw Error('Cross-host owner signal retired or invalid');
    selectedSignal = descriptor.value as AbortSignal;
    addEvent.call(selectedSignal, 'abort', cancel, { once: true }); current(); nativeSockets.subscribe(socketObserver);
    fixture = createCoordinatorFixtures(); current();
    chmodSync(fixture.directory, 0o700); for (const name of readdirSync(fixture.directory).filter(value => value.endsWith('.key'))) chmodSync(join(fixture.directory, name), 0o600);
    directory = realpathSync(mkdtempSync(join(tmpdir(), '101-cross-host-'))); chmodSync(directory, 0o700);
    const sentinel = join(directory, 'unrelated-sentinel'); writeFileSync(sentinel, 'untouched fixture owner\n', { mode: 0o600 });
    for (const id of ['host-a', 'host-b', 'host-c']) {
      const owned = join(directory, id); mkdirSync(owned, { mode: 0o700 });
      const client = fixture.clients.find(value => value.principalId === (id === 'host-c' ? 'other' : id)); if (!client) throw Error('Fixed fixture client missing');
      for (const [name, value] of [['client.pem', client.certificatePem], ['client.key', client.privateKeyPem], ['ca.pem', fixture.ca]] as const)
        writeFileSync(join(owned, name), value, { mode: 0o600 });
    }
    for (let trial = 0; trial < 3; trial++) {
      current(); const began = now(), scenarioOwner = new AbortController(), deadline = began + 15000;
      const lifetime = setTimeout(cancel, 15000); timers.add(lifetime);
      const localHosts: HostPort[] = [], clients = new Set<AuthenticatedRelayClient>(), openings = new Set<Promise<AuthenticatedRelayClient>>();
      const gatewayOwners: AbortController[] = [], gateways: ReturnType<typeof createAuthenticatedLoopbackRelay>[] = [];
      const data = new Map<HostPort, { owner: AbortController; sourcePermission: AbortController; clients: AuthenticatedRelayClient[]; pairIds: string[]; publisher: RemoteResourcePublisher; receiver: RemoteResourceReceiver;
        runtime: ReturnType<typeof createDeviceRuntime>; routes: Connection[]; sinks: EndpointHandle[]; outputs: { count: number; digest?: string }[];
        epoch: string; authority: HandoffEpoch; approvals: ReadonlyMap<string, AbortController>; tick: ReturnType<typeof setInterval>; latestState?: JsonValue; lastConfirmedAt: number; declinedAdmissions: Map<string, number> }>();
      const recoveries: number[] = [], preparationFrames: number[] = [], clockDomains = new Set<string>(); let offers = 0, frames = 0, admissions = 0, lastConfirmedAt = 0, waitTurns = 0, clientAttempts = 0;
      let preparationImpairment: Readonly<{ delayMs: 650; beganAt: number; sourceLastConfirmedAt: number;
        sourceRoutes: readonly ReturnType<Connection['status']>[]; sourceLimits: readonly ReturnType<Connection['limits']>[];
        dataOwner: boolean; sourcePermission: boolean; handoff: boolean; handoffSignal: boolean }> | undefined;
      function alive() { current(); if (!active(scenarioOwner.signal) || now() >= deadline) throw Error('Cross-host scenario retired'); }
      async function until(condition: () => boolean) {
        const expires = Math.min(deadline, now() + 2500); let turns = 0;
        while (!condition()) { alive(); if (++turns > 500 || ++waitTurns > 1600 || now() >= expires) throw Error('Cross-host current effect deadline'); await wait(5); }
        alive();
      }
      async function closeData(host: HostPort) { const prior = data.get(host); if (!prior) return; data.delete(host); prior.owner.abort(); prior.sourcePermission.abort(); clearInterval(prior.tick); timers.delete(prior.tick);
        prior.publisher.stop(); prior.receiver.stop(); prior.runtime.close(); await Promise.all(prior.clients.map(value => value.stop()));
        await Promise.all(prior.pairIds.map(value => gateway.revokePair(value))); }
      async function closeScenario() {
        scenarioOwner.abort(); for (const host of localHosts) await closeData(host);
        for (const gatewayOwner of gatewayOwners) gatewayOwner.abort();
        await Promise.allSettled([...openings]); await Promise.all([...clients].map(value => value.stop()));
        await Promise.all(localHosts.map(host => host.stop())); await Promise.all(gateways.map(value => value.stop()));
        clearTimeout(lifetime); timers.delete(lifetime);
      }
      cleanups.push(closeScenario);
      async function host(id: string, sessionId: string) {
        alive(); if (localHosts.length >= 3 || localHosts.filter(value => value.alive).length >= 2) throw Error('Host start quota');
        const port = new HostPort(); hosts.add(port); localHosts.push(port);
        await until(() => port.pid > 0 || !port.alive); if (!port.alive) throw Error('Fixed native runtime host unavailable');
        const initialized = await port.call('init', { hostId: id, sessionId, directory: join(directory!, id) }); alive();
        if (initialized.codeSha256 !== HOSTED_APPLICATION_SOURCE_SHA256 || port.keyId !== initialized.keyId) throw Error('Native host code/identity mismatch');
        return port;
      }
      const session = 'cross-host-' + trial, source = await host('host-a', session), target = await host('host-b', trial === 2 ? session + '-unrelated' : session);
      const parentIdentity = await createEphemeralWebIdentity(); alive();
      const parentCertificate = fixture.clients.find(value => value.principalId === 'peer-a')!;
      async function startGateway(members: HostPort[]) {
        alive(); if (gateways.length >= 2) throw Error('Gateway start quota'); const granted = new AbortController(); gatewayOwners.push(granted);
        const gateway = createAuthenticatedLoopbackRelay({ serverCertificatePem: fixture!.server.certificatePem, serverPrivateKeyPem: fixture!.server.privateKeyPem,
          clientCaCertificatePem: fixture!.ca, origin: 'https://cross-host-fixture.example', signal: granted.signal,
          enrollments: [{ principalId: parentCertificate.principalId, deviceId: parentCertificate.deviceId, certificatePem: parentCertificate.certificatePem, endpointKeyId: parentIdentity.keyId }, ...members.map(port => {
            const id = port === source ? 'host-a' : port === target ? 'host-b' : 'other', value = fixture!.clients.find(client => client.principalId === id)!;
            return { principalId: value.principalId, deviceId: value.deviceId, certificatePem: value.certificatePem, endpointKeyId: port.keyId };
          })] });
        gateways.push(gateway); await native(() => gateway.start()); alive(); return gateway;
      }
      const portId = (port: HostPort) => port === source ? 'host-a' : port === target ? 'host-b' : 'host-c';
      let gateway = await startGateway([source, target]);
      async function openData(port: HostPort, sessionId: string, token: HandoffEpoch) {
        alive(); if (!token.isCurrent()) throw Error('Handoff authority retired'); await closeData(port);
        const wireEpoch = randomBytes(16).toString('hex'), parentOwner = new AbortController(), sourcePermission = new AbortController();
        clientAttempts += 4; if (clientAttempts > 16) throw Error('Actual gateway client attempt quota');
        const principal = port === source ? 'host-a' : port === target ? 'host-b' : 'other';
        const pair = (sourcePrincipalId: string, receiverPrincipalId: string) => gateway.issuePair({ selectedPath: 'authenticated-loopback-relay', applicationId, sessionId, epoch: wireEpoch,
          sourcePrincipalId, receiverPrincipalId, ttlMs: Math.min(8000, Math.floor(deadline - now())) }, request => ({ request, expiresAt: request.expiresAt, signal: parentOwner.signal }));
        const input = pair('peer-a', principal), output = pair(principal, 'peer-a');
        const opening = [input.source, output.receiver].map(credential => native(() => connectAuthenticatedRelay({ credential, caCertificatePem: fixture!.ca,
          certificatePem: parentCertificate.certificatePem, privateKeyPem: parentCertificate.privateKeyPem, identity: parentIdentity, signal: parentOwner.signal })));
        for (const promise of opening) { openings.add(promise); void promise.then(client => { clients.add(client); if (!active(scenarioOwner.signal)) void client.stop(); }, () => {}).finally(() => openings.delete(promise)); }
        // Connect both gateway roles concurrently. The host's open operation
        // waits for its real ingress; the parent publication must exist first.
        const hostOpening = port.call('open', { wireEpoch, input: input.receiver, output: output.source });
        const [sender, receiverClient] = await Promise.all(opening); alive();
        for (const [client, role] of [[sender, 'source'], [receiverClient, 'receiver']] as const) {
          const scope = authenticatedPeerScope(client!.peer); if (!scope || scope.epoch !== wireEpoch || scope.role !== role || scope.localKeyId !== parentIdentity.keyId || scope.applicationId !== applicationId || scope.sessionId !== sessionId) throw Error('Actual parent authenticated scope invalid');
        }
        const publication = new RemoteResourcePublisher({ peer: sender!.peer, epoch: wireEpoch, clockId: 'cross-host-parent-clock', now,
          device: cursorDevice(), available: capability => capability === 'cursor' && active(parentOwner.signal) && active(sourcePermission.signal) && token.isCurrent() && port.alive });
        const routes: Connection[] = [], outputs = [{ count: 0, digest: undefined as string | undefined }, { count: 0, digest: undefined as string | undefined }];
        const admitted = new Map<string, AbortController>(), declinedAdmissions = new Map<string, number>(), sinks: EndpointHandle[] = [];
        const local = createDeviceRuntime({ now, clockDomain: 'cross-host-parent-clock', maxRoutes: 4, maxRegistrations: 8, maxSubscribers: 2, maxPendingDeliveries: 2,
          authorize(request) { const approval = admitted.get(request.sink.registrationId);
            if (!active(parentOwner.signal) || !token.isCurrent() || !port.alive || request.principalId !== 'peer-a' || request.applicationId !== applicationId || request.sessionId !== sessionId || request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write' || request.source.deviceId !== portId(port) + ':raster-source' ||
              request.source.capabilityId !== 'frame' || request.source.descriptorRevision !== 1 || request.source.schemaVersion !== 1 || request.sink.capabilityId !== 'frame') return;
            if (!approval || !active(approval.signal)) {
              const observed = declinedAdmissions.get(request.sink.registrationId);
              if (observed !== undefined) declinedAdmissions.set(request.sink.registrationId, observed + 1);
              return;
            }
            admissions++; return { expiresAt: began + 9000, maxAgeMs: 250, maxHz: 30 };
          } });
        // Every port call delegates to the actual runtime; spreading the native
        // class instance would omit its prototype methods. Capture only actual
        // handles returned by its public route method.
        const routePort: DeviceRuntime = { clockDomain: local.clockDomain,
          registerSource: local.registerSource.bind(local), registerSink: local.registerSink.bind(local), unregister: local.unregister.bind(local),
          setReadiness: local.setReadiness.bind(local), publish: local.publish.bind(local),
          revoke: local.revoke.bind(local), flush: local.flush.bind(local), close: local.close.bind(local),
          route(request) { const result = local.route(request); routes.push(result); return result; } };
        const reception = new RemoteResourceReceiver({ peer: receiverClient!.peer, epoch: wireEpoch, clockId: 'cross-host-parent-clock', now, runtime: routePort,
          principalId: 'peer-a', applicationId, sessionId });
        const tick = setInterval(() => { if (active(parentOwner.signal)) { publication.tick(); reception.tick(); local.flush(); } }, 5); timers.add(tick);
        const entry = { owner: parentOwner, sourcePermission, clients: [sender!, receiverClient!], pairIds: [input.pairId, output.pairId], publisher: publication, receiver: reception, runtime: local, routes, sinks, outputs, epoch: wireEpoch, authority: token, approvals: admitted, tick, lastConfirmedAt: 0, declinedAdmissions };
        data.set(port, entry); const opened = await hostOpening; alive();
        if (opened.group !== 'active' || number(opened.nativeStarts) < 1 || number(opened.groupStarts) < 1) throw Error('Real host group did not start');
        if (!publication.start()) throw Error('Approved parent input publisher refused');
        const hostAdmission = port.call('admit');
        await until(() => !!reception.description()); const descriptor = reception.description()!;
        for (let index = 0; index < 2; index++) {
          const sinkDevice = parseDeviceDescriptor({ ...descriptor, id: 'private-output-' + index, capabilities: descriptor.capabilities.map(value => ({ ...value, kind: 'property', permissions: ['write'], ownership: { mode: 'exclusive' } })) });
          const grant = new AbortController();
          const sink = local.registerSink({ device: sinkDevice, capability: 'frame', apply(observation, context) {
            if (!active(parentOwner.signal) || !active(grant.signal) || !token.isCurrent() || !port.alive || !context.isCurrent() || !active(context.signal)) return;
            const value = object(observation.value), sourceTime = object(value.sourceTime); clockDomains.add(String(sourceTime.clockId));
            const digest = hashPixels(value.pixels); if (!context.isCurrent() || !active(context.signal) || !active(grant.signal) || !active(parentOwner.signal) || !token.isCurrent()) return;
            outputs[index]!.count++; outputs[index]!.digest = digest; lastConfirmedAt = now();
            const selected = data.get(port); if (selected) selected.lastConfirmedAt = lastConfirmedAt;
          }, release() { outputs[index]!.digest = undefined; } });
          sinks.push(sink); admitted.set(sink.id, grant); local.setReadiness(sink, 'available');
          if (!reception.approve({ capability: 'frame', sink, sinkDevice, sinkCapability: 'frame', grant: { expiresAt: began + 9000, maxAgeMs: 250, maxHz: 30 }, leaseMs: 1000 })) throw Error('Private output refused');
        }
        const admittedHost = await hostAdmission; alive(); if (admittedHost.admitted !== true || admittedHost.group !== 'active') throw Error('Real host ingress admission refused');
        await until(() => reception.status().active === 2 && reception.status().clockReady); return entry;
      }
      function adapter(port: HostPort, id: string, sessionId: string): HandoffHost {
        const definition = hostedApplicationRequirements(id);
        return { id, assets: [],
          async pause(epoch) { alive(); await closeData(port); const result = await port.call('pause', { epoch: epoch.epoch }); alive();
            const restored = await restoreApplicationSnapshot(definition.workload, definition.context, result.capsule, [], validState);
            alive(); if (!restored.ok) throw Error('Native host snapshot invalid'); return restored.state; },
          async stage(state, epoch) { alive(); const capsule = createApplicationSnapshot(definition.workload, definition.context, state);
            const result = await port.call('stage', { capsule, epoch: epoch.epoch }); alive(); if (result.ok !== true) throw Error('Target reviewed format refused'); },
          async resume(epoch) { alive(); if (!epoch.isCurrent() || !active(epoch.signal)) throw Error('Current transfer authority required');
            await port.call('resume', { epoch: epoch.epoch }); alive(); await openData(port, sessionId, epoch); alive(); },
          async stop(epoch) { await closeData(port); if (port.alive) await port.call('retire', { epoch: epoch.epoch }); },
          async abort(epoch) { await closeData(port); if (port.alive) await port.call('retire', { epoch: epoch.epoch }); } };
      }
      async function command(port: HostPort, x: number, y: number) {
        alive(); if (++offers > 16) throw Error('Command offer quota'); const entry = data.get(port); if (!entry) throw Error('Host data unavailable');
        const before = number((await port.call('stats')).nativeEffects); alive();
        const at = now();
        if (!entry.publisher.publish('cursor', { x, y }, { capturedAt: at, deadline: at + 250 })) throw Error('Command publication refused');
        if (!entry.routes.every(route => route.status().state === 'active')) throw Error('Current output routes required before native command');
        let stats: Record<string, unknown>;
        do { if (++waitTurns > 1600) throw Error('Cross-host wait quota'); await wait(5); stats = await port.call('stats'); alive(); } while (number(stats.nativeEffects) === before && now() < Math.min(deadline, began + 9000));
        if (number(stats.nativeEffects) !== before + 1 || stats.pending === true || object(stats.operation).effectEvidence !== 'target-acknowledged') throw Error('Actual native input acknowledgment required');
        await sample(port, x, y); return object(data.get(port)!.latestState) as JsonValue;
      }
      async function sample(port: HostPort, x: number, y: number) {
        alive(); if (++frames > 32) throw Error('Frame offer quota'); const entry = data.get(port); if (!entry) throw Error('Host data unavailable');
        const sampledAt = now(), lastConfirmedBefore = entry.lastConfirmedAt;
        const beforeRoutes = entry.routes.slice(0, 2).map(route => route.status());
        const counts = entry.outputs.map(value => value.count); const result = await port.call('sample'); alive();
        const nativeReturnedAt = now();
        const state = object(result.state); if (state.x !== x || state.y !== y || !validState(state as JsonValue)) throw Error('Native state mismatch'); entry.latestState = state as JsonValue;
        try { await until(() => entry.outputs.every((value, index) => value.count > counts[index]! && value.digest === marker(x, y))); }
        catch (error) {
          // Failure-only observations of the actual captured handles/reply. No
          // new provider call, grant, renewal, effect, timer or frame is issued.
          const failedAt = now();
          const diagnostic = Object.freeze({ trial, host: portId(port), receiver: entry.receiver.status(),
            preparationImpairment,
            routesBefore: beforeRoutes, routesAfter: entry.routes.slice(0, 2).map(route => route.status()),
            outputs: entry.outputs.map((value, index) => ({ before: counts[index], current: value.count, expectedMarker: value.digest === marker(x, y) })),
            signals: { run: active(owner.signal), caller: active(selectedSignal), scenario: active(scenarioOwner.signal),
              dataOwner: active(entry.owner.signal), sourcePermission: active(entry.sourcePermission.signal),
              outputOwners: entry.sinks.slice(0, 2).map(sink => active(entry.approvals.get(sink.id)?.signal)),
              handoff: entry.authority.isCurrent(), handoffSignal: active(entry.authority.signal), hostAlive: port.alive },
            monotonic: { sampledAt, nativeReturnedAt, failedAt, sampleElapsedMs: failedAt - sampledAt,
              lastConfirmedBefore, lastConfirmedAt: entry.lastConfirmedAt, gapSinceConfirmationMs: failedAt - entry.lastConfirmedAt,
              scenarioBegan: began, scenarioDeadline: deadline, parentGrantExpiresAt: began + 9000,
              waitMs: 2500, maxWaitTurns: 500, maxAgeMs: 250, receiverMinimumSilenceMs: 500, leaseMs: 1000 },
            nativeReply: { state, sequence: result.sequence, nativeEffects: result.nativeEffects, expectedMarker: result.digest === marker(x, y) },
            lastReportedNativeStats: { scope: 'last completed stats reply; not a current native-group observation after wait',
              group: port.summary.group, pending: port.summary.pending, rawIssued: port.summary.rawIssued, rawSettled: port.summary.rawSettled } });
          if (error instanceof Error && encoder.encode(JSON.stringify(diagnostic)).byteLength <= 4096)
            Object.defineProperty(error, 'crossHostSampleDiagnostics', { value: diagnostic });
          throw error;
        }
        if (!entry.routes.every(route => route.status().state === 'active')) throw Error('Confirmed raster needs current recipients'); return result;
      }

      async function deniedRecipients(port: HostPort) {
        const entry = data.get(port)!; alive();
        if (!entry.routes.every(route => route.status().state === 'active')) throw Error('Permission checks require current native baseline');
        for (const [name, app, chosenSession] of [['application', 'foreign-application', session], ['session', applicationId, 'foreign-session']] as const) {
          let denied = false;
          try { new RemoteResourceReceiver({ peer: entry.clients[1]!.peer, epoch: entry.epoch, clockId: 'cross-host-parent-clock', now,
            runtime: entry.runtime, principalId: 'peer-a', applicationId: app, sessionId: chosenSession }); }
          catch (error) { denied = error instanceof TypeError && /scope|application|session|match/.test(error.message); }
          check(denied && entry.routes.every(route => route.status().state === 'active'), 'actual-authenticated-' + name + '-recipient-refused');
        }
        const descriptor = entry.receiver.description()!;
        const sinkDevice = parseDeviceDescriptor({ ...descriptor, id: 'declined-private-output', capabilities: descriptor.capabilities.map(value => ({ ...value, kind: 'property', permissions: ['write'], ownership: { mode: 'exclusive' } })) });
        let declinedEffects = 0;
        const sink = entry.runtime.registerSink({ device: sinkDevice, capability: 'frame', apply() { declinedEffects++; }, release() {} });
        entry.runtime.setReadiness(sink, 'available'); entry.declinedAdmissions.set(sink.id, 0);
        // A receiver constraint is not host authorization. The real host has
        // deliberately not admitted this exact destination registration.
        const before = entry.routes.length;
        entry.receiver.approve({ capability: 'frame', sink, sinkDevice, sinkCapability: 'frame', grant: { expiresAt: began + 9000, maxAgeMs: 250, maxHz: 30 }, leaseMs: 1000 });
        const declined = entry.routes.splice(before)[0];
        if (!declined) throw Error('Declined recipient did not reach actual host route');
        await until(() => declined.status().state === 'closed');
        const declinedReason = declined.status().reason;
        await sample(port, 3, 2);
        const facts = { actualAuthorizationRefusals: entry.declinedAdmissions.get(sink.id), finalReceiverDisposition: declinedReason,
          declinedEffects, incumbentHandles: entry.routes.length, incumbentsCurrent: entry.routes.every(route => route.status().state === 'active') };
        if (facts.actualAuthorizationRefusals !== 1 || facts.finalReceiverDisposition !== 'incompatible' || facts.declinedEffects !== 0 || facts.incumbentHandles !== 2 || !facts.incumbentsCurrent)
          throw Error('Cross-host assertion: unapproved-real-recipient-zero-new-output ' + JSON.stringify(facts));
        check(true, 'unapproved-real-recipient-zero-new-output'); entry.declinedAdmissions.delete(sink.id);
        entry.runtime.unregister(sink);
      }
      try {
        await source.call('launch'); alive();
        const handoff = createWorkloadHandoff({ workload: hostedApplicationRequirements('host-a').workload, context: hostedApplicationRequirements('host-a').context,
          source: adapter(source, 'host-a', session), validateState: validState });
        await adapter(source, 'host-a', session).resume(handoff.authority());
        const initial = await command(source, 3, 2); let beforeTransfer = data.get(source)!.lastConfirmedAt;
        check(data.get(source)!.outputs.every(value => value.count > 0), trial === 0 ? 'shared-output-two-current-granted-effects' : trial === 1 ? 'format-trial-current-native-baseline' : 'loss-trial-current-native-baseline');
        if (trial === 0) {
          await deniedRecipients(source); beforeTransfer = data.get(source)!.lastConfirmedAt;
          const old = handoff.authority(), oldData = data.get(source)!, oldRoutes = oldData.routes.slice();
          await source.call('hold-next');
          const heldAt = now();
          if (++offers > 16 || !data.get(source)!.publisher.publish('cursor', { x: 0, y: 3 }, { capturedAt: heldAt, deadline: heldAt + 250 })) throw Error('Controlled queued command refused');
          let held: Record<string, unknown>;
          do { if (++waitTurns > 1600) throw Error('Cross-host wait quota'); await wait(5); held = await source.call('stats'); alive(); } while (held.held !== true && now() < deadline);
          check(held.held === true && object(held.operation).handlerResult === 'running' && number(held.nativeEffects) === 1, 'controlled-unissued-native-command-held');
          const result = await handoff.transfer(adapter(target, 'host-b', session)); alive();
          check(result.ok && !old.isCurrent() && oldRoutes.every(value => value.status().state === 'closed'), 'source-retired-before-target-group');
          const staleAt = now();
          check(!oldData.publisher.publish('cursor', { x: 0, y: 0 }, { capturedAt: staleAt, deadline: staleAt + 250 }), 'retired-public-endpoint-refuses-new-command');
          const retired = await source.call('stats');
          check(object(retired.operation).state === 'cancelled' && number(retired.nativeEffects) === 1 && retired.pending === false, 'queued-old-epoch-retired-without-native-dispatch');
          await sample(target, 3, 2); recoveries.push(data.get(target)!.lastConfirmedAt - beforeTransfer);
          const next = await command(target, 1, 0);
          check(number(object(next).revision) === number(object(initial).revision) + 1, 'compatible-native-state-continuity');
          check(new Set([source.pid, target.pid]).size === 2 && number((await target.call('stats')).groupStarts) > 0, 'two-independent-runtime-host-groups');
        } else if (trial === 1) {
          await target.call('format', { format: 2 }); const before = await target.call('stats');
          const result = await handoff.transfer(adapter(target, 'host-b', session)); alive();
          const after = await target.call('stats');
          check(!result.ok && result.recovered && number(after.stageCalls) === number(before.stageCalls) && number(after.nativeStarts) === 0, 'target-format-refused-before-native-stage');
          await sample(source, 3, 2); recoveries.push(data.get(source)!.lastConfirmedAt - beforeTransfer);
          check(handoff.authority().epoch > 1, 'compatible-source-recovery-new-epoch');
          const stats = await source.call('deny-input', { owner: 'source' }), effects = number(stats.effects), entry = data.get(source)!;
          const deniedAt = now(); if (++offers > 16) throw Error('Command offer quota');
          entry.publisher.publish('cursor', { x: 0, y: 0 }, { capturedAt: deniedAt, deadline: deniedAt + 250 });
          await wait(50); const refused = await source.call('stats'); alive();
          check(number(refused.nativeEffects) === effects && refused.group === 'closed', 'owner-denial-zero-new-native-input');
          await openData(source, session, handoff.authority()); await command(source, 1, 1);
          check(data.get(source)!.routes.every(route => route.status().state === 'active'), 'fresh-source-and-sink-grants-recover-current-effect');
          const sinkDenied = await source.call('deny-input', { owner: 'sink' }), sinkEffects = number(sinkDenied.effects), renewed = data.get(source)!;
          const sinkAt = now(); if (++offers > 16) throw Error('Command offer quota');
          renewed.publisher.publish('cursor', { x: 2, y: 2 }, { capturedAt: sinkAt, deadline: sinkAt + 250 });
          await wait(50); const sinkRefused = await source.call('stats'); alive();
          check(number(sinkRefused.nativeEffects) === sinkEffects && sinkRefused.group === 'closed', 'independent-sink-owner-denial-zero-new-input');
        } else {
          // Fixed software preparation impairment. The keeper below reads new
          // frames from the actual source while this real asynchronous target
          // preparation remains pending; neither cached pixels nor authority is
          // replayed, restamped or reopened to keep the old slots alive.
          const baseline = data.get(source)!, baselineRoutes = baseline.routes.slice(0, 2).map(route => route.status());
          if (baselineRoutes.length !== 2 || !baselineRoutes.every(route => route.state === 'active')) throw Error('Current source required before controlled target preparation');
          preparationImpairment = Object.freeze({ delayMs: 650, beganAt: now(), sourceLastConfirmedAt: baseline.lastConfirmedAt,
            sourceRoutes: baselineRoutes, sourceLimits: baseline.routes.slice(0, 2).map(route => route.limits()),
            dataOwner: active(baseline.owner.signal), sourcePermission: active(baseline.sourcePermission.signal),
            handoff: baseline.authority.isCurrent(), handoffSignal: active(baseline.authority.signal) });
          if (!preparationImpairment.dataOwner || !preparationImpairment.sourcePermission || !preparationImpairment.handoff || !preparationImpairment.handoffSignal ||
            !preparationImpairment.sourceLimits.every(limit => limit !== undefined && limit.expiresAt > preparationImpairment!.beganAt && limit.maxAgeMs === 250))
            throw Error('Current original source grants required before controlled target preparation');
          let preparationDone = false, preparationFailed = false, preparationFailure: unknown;
          const failPreparation = (error: unknown) => {
            if (!preparationFailed) preparationFailure = error;
            preparationFailed = true; cancel();
          };
          const targetPreparation = (async () => {
            await wait(650); alive();
            await target.call('launch'); alive();
            const independent = createWorkloadHandoff({ workload: hostedApplicationRequirements('host-b').workload, context: hostedApplicationRequirements('host-b').context,
              source: adapter(target, 'host-b', session + '-unrelated'), validateState: validState });
            await adapter(target, 'host-b', session + '-unrelated').resume(independent.authority()); alive();
            await command(target, 0, 1); alive();
          })().then(() => { preparationDone = true; }, error => { preparationDone = true; failPreparation(error); });
          const sourceKeeper = (async () => {
            while (!preparationDone) {
              // sample() reserves and charges the same32-frame/64-IPC budgets
              // before a genuine provider.frame request, waits for both actual
              // native output effects, and fences the original owner/epoch.
              const result = await sample(source, 3, 2); alive();
              const sequence = number(result.sequence), prior = preparationFrames.at(-1);
              if (!Number.isSafeInteger(sequence) || prior !== undefined && sequence <= prior) throw Error('Fresh native preparation frame sequence required');
              preparationFrames.push(sequence);
              if (!preparationDone) { await wait(150); alive(); }
            }
          })().catch(failPreparation);
          // Logical cancellation never frees either actual request/IPC/send
          // callback reservation. Both jobs and owned waits settle before the
          // first error is rethrown and the existing native finally runs.
          await Promise.all([targetPreparation, sourceKeeper]);
          if (preparationFailed) throw preparationFailure;
          check(preparationFrames.length > 0 && data.get(source)!.routes.every(route => route.status().state === 'active') &&
            data.get(target)!.routes.every(route => route.status().state === 'active'), 'source-native-frames-current-during-controlled-target-preparation');
          const saved = createApplicationSnapshot(hostedApplicationRequirements('host-a').workload, hostedApplicationRequirements('host-a').context, initial);
          await sample(source, 3, 2);
          if (!data.get(source)!.routes.every(route => route.status().state === 'active') || !data.get(target)!.routes.every(route => route.status().state === 'active')) throw Error('Actual current source and unrelated baseline required before loss');
          const oldKey = source.keyId, oldRoutes = data.get(source)!.routes.slice(), failureAt = data.get(source)!.lastConfirmedAt;
          source.child.kill('SIGTERM'); await source.closed; await closeData(source); alive();
          await sample(target, 0, 1);
          check(oldRoutes.every(route => route.status().state === 'closed') && data.get(target)!.routes.every(route => route.status().state === 'active'), 'lost-host-retired-unrelated-group-current');
          await closeData(target); for (const client of clients) await client.stop(); for (const grant of gatewayOwners) grant.abort(); await gateway.stop();
          const replacement = await host('host-c', session); gateway = await startGateway([replacement, target]);
          const recovered = createWorkloadHandoff({ workload: hostedApplicationRequirements('host-c').workload, context: hostedApplicationRequirements('host-c').context,
            source: adapter(replacement, 'host-c', session), validateState: validState });
          const staged = await replacement.call('stage', { capsule: saved, epoch: recovered.authority().epoch }); alive(); if (staged.ok !== true) throw Error('Fresh host restore refused');
          await adapter(replacement, 'host-c', session).resume(recovered.authority()); await sample(replacement, 3, 2); recoveries.push(data.get(replacement)!.lastConfirmedAt - failureAt);
          check(replacement.pid !== source.pid && replacement.keyId !== oldKey && data.get(replacement)!.outputs.every(value => value.count > 0), 'lost-host-fresh-identity-and-consent');
          await command(replacement, 2, 3);
        }
        await Promise.all(localHosts.filter(value => value.alive).map(value => value.call('stats'))); alive();
        const stats = localHosts.map(value => value.summary).filter(value => 'rawIssued' in value);
        const activeData = [...data.values()];
        scenarios.push(Object.freeze({ name: ['shared-group-live-handoff', 'snapshot-refusal-and-owner-loss', 'owned-host-loss-and-recovery'][trial]!,
          hostPids: Object.freeze(localHosts.map(value => value.pid)), effects: stats.reduce((sum, value) => sum + number(value.nativeEffects), 0),
          outputEffects: Object.freeze(activeData.flatMap(value => value.outputs.map(output => output.count))), admissions,
          releases: stats.reduce((sum, value) => sum + number(value.releases), 0), nativeStarts: stats.reduce((sum, value) => sum + number(value.nativeStarts), 0),
          rawIssued: stats.reduce((sum, value) => sum + number(value.rawIssued), 0), rawSettled: stats.reduce((sum, value) => sum + number(value.rawSettled), 0),
          recoveryMs: Object.freeze(recoveries), originalClockDomains: Object.freeze([...clockDomains]), sourcePreparationFrameSequences: Object.freeze(preparationFrames) }));
        check(stats.every(value => value.rawIssued === value.rawSettled && value.pending === false), 'scenario-' + trial + '-actual-provider-results-settled');
      } finally { await closeScenario(); cleanups.pop(); }
      check(localHosts.every(value => !value.alive && value.pending() === 0) && gateways.every(value => value.snapshot().nativeConnections === 0 && value.snapshot().pendingRaw === 0), 'scenario-' + trial + '-native-close');
    }
    check(readFileSync(sentinel, 'utf8') === 'untouched fixture owner\n', 'unrelated-fixture-sentinel-preserved');
  } catch (error) { failure = error; cancel(); }
  finally {
    cancel(); for (const close of cleanups.reverse()) { try { await close(); } catch (error) { failure ??= error; } }
    await Promise.all([...hosts].map(value => value.stop())); await Promise.all([...sockets.values()]);
    for (const timer of timers) clearTimeout(timer); timers.clear(); nativeSockets.unsubscribe(socketObserver);
    if (selectedSignal) removeEvent.call(selectedSignal, 'abort', cancel);
    if (directory) rmSync(directory, { recursive: true, force: true }); fixture?.close();
    if ([...hosts].some(value => value.alive || value.pending()) || sockets.size || directory && existsSync(directory) || fixture && existsSync(fixture.directory)) failure ??= Error('Cross-host cleanup incomplete');
    reserved = false;
  }
  if (failure) {
    if (failure instanceof Error) Object.defineProperty(failure, 'startupDiagnostics', { value: Object.freeze({
      parentClock: 'parent-performance', childClock: 'runtime-host-performance',
      clockScope: 'Child loader-body-enter excludes its static builtin imports; module-body-enter excludes host static ESM imports. Child and parent times are separate clocks; parent receipt includes delivery and scheduling.',
      hosts: Object.freeze([...hosts].map(value => value.diagnostics())),
      cleanup: Object.freeze({ processes: [...hosts].filter(value => value.alive).length,
        callbacks: [...hosts].reduce((sum, value) => sum + value.pending(), 0), sockets: sockets.size, timers: timers.size,
        fixturesRemoved: (!directory || !existsSync(directory)) && (!fixture || !existsSync(fixture.directory)) })
    }) });
    throw failure;
  }
  const result: CrossHostWorkloadReceipt = Object.freeze({ profile: CROSS_HOST_WORKLOAD_PROFILE, result: 'pass', checks: Object.freeze(checks), scenarios: Object.freeze(scenarios),
    cleanup: Object.freeze({ processes: 0, callbacks: 0, sockets: 0, timers: 0, fixturesRemoved: true }),
    scope: Object.freeze({ independentNodeProcesses: true, physicalMachines: false, actualIpLoss: false, gatewayPlaintextTrusted: true, installedHub: false, captureClockMapping: false, performanceSlo: false,
      rawCounters: 'provider-input-api-invocations-not-system-writes', issuedEffectsCanCompleteBeforeAbort: true,
      unrelatedTargetPreparationDelayMs: 650, sourcePreparationSamplingWaitMs: 150 }) });
  if (encoder.encode(JSON.stringify(result) + '\n').byteLength > 16384) throw Error('Cross-host receipt quota'); return result;
}
