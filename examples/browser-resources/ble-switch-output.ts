import { createBrowserBleSwitchProvider, createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import type { Authorize, BrowserBleSwitchActivation, BrowserBleSwitchCaptureGrant, BrowserBleSwitchCaptureRequest,
  BrowserBleSwitchEnvironment, BrowserBleSwitchOptions, BrowserBleSwitchOutputGrant, BrowserBleSwitchOutputRequest,
  BrowserBleSwitchProfile, Connection, NativeBleSwitchCharacteristic, NativeBleSwitchDevice, NativeBleSwitchManager,
  NativeBleSwitchProperties, NativeBleSwitchServer, NativeBleSwitchService, Observation } from '@101/connect';

const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const isAborted = (value: AbortSignal): boolean => Reflect.apply(aborted, value, []) as boolean;
export interface BrowserBleSwitchOutputCallerOptions {
  readonly ownerSignal: AbortSignal; readonly reviewedProfile: BrowserBleSwitchProfile; readonly now?: () => number;
  readonly authorizeCapture: (request: BrowserBleSwitchCaptureRequest) => BrowserBleSwitchCaptureGrant | undefined;
  readonly authorizeOutput: (request: BrowserBleSwitchOutputRequest) => BrowserBleSwitchOutputGrant | undefined;
  readonly authorizeRoutes: Authorize; readonly environment?: BrowserBleSwitchEnvironment;
}

/** One selected GATT owner. API return is independent from separately routed
 * notification state. Stop removes local authority and never writes a reset. */
export function createBrowserBleSwitchOutputCaller(options: BrowserBleSwitchOutputCallerOptions) {
  const now = options.now ?? (() => performance.now()), scope = Object.freeze({ principalId: 'ble-output-owner', applicationId: 'ble-output-example', sessionId: 'ble-output-session' });
  const runtime = createDeviceRuntime({ now, clockDomain: 'ble-output-host-receipt', authorize: options.authorizeRoutes, maxRegistrations: 4, maxRoutes: 2, maxPendingDeliveries: 2 });
  const routes = new Map<string, Connection>(), endpoints = new Set<ReturnType<typeof runtime.registerSource>>();
  let active: BrowserBleSwitchActivation | undefined, command: ReturnType<typeof runtime.registerSource> | undefined, commandRoute: Connection | undefined;
  let held = false, delivered = 0, releases = 0, last: Observation | undefined, epoch = 0, closed = false, operation = 0;
  let pending: Promise<Awaited<ReturnType<ReturnType<typeof createBrowserBleSwitchProvider>['start']>>> | undefined, closing: Promise<void> | undefined;
  const outputDeliveryLimits: NonNullable<BrowserBleSwitchOptions['outputDeliveryLimits']> = context => {
    const connection = routes.get(context.routeId), limits = connection?.limits();
    if (!connection || connection !== commandRoute || connection.status().state !== 'active' || !limits || !context.operationId) return;
    const record = connection.operations().find(row => row.id === context.operationId && row.handlerResult === 'running'); if (!record) return;
    return Object.freeze({ context, expiresAt: Math.min(limits.expiresAt, record.deadline), maxAgeMs: Math.min(limits.maxAgeMs, 100), maxHz: Math.min(limits.maxHz, 2) });
  };
  const provider = createBrowserBleSwitchProvider({ runtime, ownerSignal: options.ownerSignal, scope, now, reviewedProfile: options.reviewedProfile,
    authorizeCapture: options.authorizeCapture, authorizeOutput: options.authorizeOutput, outputDeliveryLimits, ...(options.environment ? { environment: options.environment } : {}) });
  function current(turn: number) { return !closed && epoch === turn && !isAborted(options.ownerSignal); }
  function stop() {
    epoch++; active = undefined; command = undefined; commandRoute = undefined; operation = 0;
    const connections = [...routes.values()], handles = [...endpoints]; routes.clear(); endpoints.clear();
    provider.stop(); for (const route of connections) route.stop('ble-output-caller-stop'); for (const handle of handles) runtime.unregister(handle);
    held = false; last = undefined;
  }
  return Object.freeze({ provider,
    activate(purpose: string) {
      if (closed || pending || active || isAborted(options.ownerSignal)) return Promise.resolve({ ok: false as const, reason: 'busy' as const });
      const turn = ++epoch; let finish!: (value: Awaited<ReturnType<typeof provider.start>>) => void;
      const result = new Promise<Awaited<ReturnType<typeof provider.start>>>(resolve => { finish = resolve; }); pending = result;
      void (async () => {
        try {
          const chosen = await provider.choose(); if (!chosen.ok) { finish(chosen); return; } if (!current(turn)) { finish({ ok: false, reason: 'cancelled' }); return; }
          const activated = await provider.start(chosen.value, { purpose }); if (!activated.ok) { finish(activated); return; }
          if (!current(turn)) { provider.stop(); finish({ ok: false, reason: 'cancelled' }); return; }
          active = activated.value;
          const device = parseDeviceDescriptor({ ...activated.value.device, id: activated.value.device.id + ':display', capabilities: activated.value.device.capabilities.map(row => ({ ...row, permissions: ['write'], ownership: { mode: 'observe' } })) });
          const sink = runtime.registerSink({ device, capability: 'switch', apply(observation, context) {
            if (!current(turn) || !context.isCurrent() || isAborted(context.signal) || !current(turn)) return;
            held = (observation.value as { active: boolean }).active; last = observation; delivered++;
          }, release() { held = false; last = undefined; releases++; } });
          if (!current(turn)) { runtime.unregister(sink); finish({ ok: false, reason: 'cancelled' }); return; } endpoints.add(sink);
          if (!runtime.setReadiness(sink, 'available').ok || !current(turn)) { stop(); finish({ ok: false, reason: 'cancelled' }); return; }
          const route = runtime.route({ ...scope, from: activated.value.source, to: sink, leaseMs: 30000, queueCapacity: 8 });
          if (!current(turn)) { route.stop('late-ble-notification-route'); stop(); finish({ ok: false, reason: 'cancelled' }); return; } routes.set(route.id, route);
          if (!route.start().ok || !current(turn)) { stop(); finish({ ok: false, reason: 'denied' }); return; } finish(activated);
        } catch { stop(); finish({ ok: false, reason: 'unavailable' }); }
        finally { if (pending === result) pending = undefined; }
      })(); return result;
    },
    connectOutput(purpose: string) {
      const turn = epoch; if (!active || !current(turn) || command || commandRoute) return { ok: false as const, reason: 'busy' as const };
      const bound = provider.bindOutput(active, { purpose }); if (!bound.ok) return bound;
      if (!current(turn)) return { ok: false as const, reason: 'cancelled' as const };
      const device = parseDeviceDescriptor({ ...bound.value.device, id: bound.value.device.id + ':commands', capabilities: bound.value.device.capabilities.map(row => ({ ...row, kind: 'event' as const, permissions: ['subscribe'] })) });
      const source = runtime.registerSource({ device, capability: 'switch-setting' });
      if (!current(turn)) { runtime.unregister(source); return { ok: false as const, reason: 'cancelled' as const }; } endpoints.add(source); command = source;
      if (!runtime.setReadiness(source, 'available').ok || !current(turn)) { stop(); return { ok: false as const, reason: 'cancelled' as const }; }
      const at = now(); if (!current(turn) || !Number.isFinite(at) || at >= bound.value.expiresAt) { stop(); return { ok: false as const, reason: 'expired' as const }; }
      const route = runtime.route({ ...scope, from: source, to: bound.value.sink, queueCapacity: 1, leaseMs: Math.max(1, Math.floor(Math.min(30000, bound.value.expiresAt - at))) });
      if (!current(turn)) { route.stop('late-ble-command-route'); stop(); return { ok: false as const, reason: 'cancelled' as const }; }
      routes.set(route.id, route); commandRoute = route; operation = 0; const started = route.start();
      if (!started.ok || !current(turn)) { route.stop('denied'); runtime.unregister(source); endpoints.delete(source); command = undefined; return { ok: false as const, reason: 'denied' as const }; }
      return bound;
    },
    set(value: boolean, deadline?: number) {
      const turn = epoch; if (!current(turn) || !command || !commandRoute || commandRoute.status().state !== 'active' || operation >= 31) return { ok: false as const, reason: 'denied' as const };
      const at = now(); if (!current(turn) || !Number.isFinite(at)) return { ok: false as const, reason: 'cancelled' as const };
      const result = runtime.publish(command, value, { timestamp: at, clockDomain: runtime.clockDomain, operationId: String(++operation), deadline: deadline ?? at + 100 }); runtime.flush(); return result;
    },
    tick() { runtime.flush(); }, stop,
    state() { return Object.freeze({ held, delivered, releases, lastObservation: last, provider: provider.snapshot(), output: provider.outputStatus() }); },
    close() {
      if (closing) return closing; let finish!: () => void, reject!: (error: unknown) => void;
      closing = new Promise<void>((done, failed) => { finish = done; reject = failed; }); closed = true; stop();
      void (async () => { try { await provider.close(); if (pending) await pending; runtime.close(); finish(); } catch (error) { runtime.close(); reject(error); } })(); return closing;
    }
  });
}

const softwareProfile: BrowserBleSwitchProfile = Object.freeze({ id: 'software:ble-one-byte-switch/1', revision: 1,
  serviceUUID: '5f5a0101-0000-4000-8000-010100000001', characteristicUUID: '5f5a0101-0000-4000-8000-010100000002', writeFormat: 'boolean-byte/1' });

/** Actual default API availability and forged-handle negatives. Never requestDevice. */
export async function checkBleSwitchOutputWithoutDevice() {
  const owner = new AbortController(); let captureApprovals = 0, outputApprovals = 0;
  const caller = createBrowserBleSwitchOutputCaller({ ownerSignal: owner.signal, reviewedProfile: softwareProfile,
    authorizeCapture() { captureApprovals++; return undefined; }, authorizeOutput() { outputApprovals++; return undefined; }, authorizeRoutes: () => undefined });
  try {
    const initial = caller.state(), availability = caller.provider.availability(), report = caller.provider.inspectOutput({} as BrowserBleSwitchActivation), bound = caller.provider.bindOutput({} as BrowserBleSwitchActivation, { purpose: 'not-issued' });
    await caller.close(); return { kind: 'inert-default-ble-output-negative', availability, initial, report, bound, captureApprovals, outputApprovals,
      nativeChoosers: 0, nativeConnects: 0, nativeWrites: 0, physicalBleQualification: false, final: caller.state() };
  } finally { owner.abort(); await caller.close(); }
}

/** Genuine separately executing Worker target; explicitly software GATT ports.
 * Returned write reply and a separately requested notification remain independent. */
export async function runBleSwitchOutputWorkerFixture() {
  const code = `const clockId='owned-worker-performance:'+crypto.randomUUID();let state=0,sequence=0,hold=false,pending;
onmessage=event=>{const m=event.data;if(!m||m.v!==1)return;
if(m.kind==='release'&&pending){postMessage({v:1,kind:'returned',id:pending});pending=undefined;hold=false;return;}
if(!Number.isSafeInteger(m.id)||m.id<1||m.id>8)return;
if(m.kind==='hold'){hold=true;postMessage({v:1,kind:'control',id:m.id});return;}
if(m.kind==='write'&&(m.byte===0||m.byte===1)){state=m.byte;if(hold){pending=m.id;postMessage({v:1,kind:'held-issued',id:m.id});}else postMessage({v:1,kind:'returned',id:m.id});return;}
if(m.kind==='report')postMessage({v:1,kind:'notification',id:m.id,byte:state,sequence:++sequence,sourceTime:{clockId,at:performance.now()}});};`;
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' })), worker = new Worker(url);
  let request = 0, workerReplies = 0, heldIssued = 0, pending: { id: number; kind: string; resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout>; timedOut: boolean } | undefined;
  let workerClosed = false, nativeWrites = 0, outputAllowed = false, routeAllowed = false, end = performance.now() + 5000;
  const emissions: { byte: number; sequence: number; sourceTime: { clockId: string; at: number } }[] = [];
  function issuedWrites(): number { return nativeWrites; }
  const cleanup = { workerTerminateReturned: false, nativeWorkerExitObserved: false, workerListeners: 2, pendingRequests: 0, timers: 0, actualProviderRaw: -1 };
  function onMessage(event: MessageEvent) {
    const value = event.data; if (!value || value.v !== 1 || !pending || value.id !== pending.id) return;
    if (value.kind === 'held-issued' && pending.kind === 'write') { heldIssued++; return; }
    if (!['returned', 'notification', 'control'].includes(value.kind)) return;
    const exact = pending; pending = undefined; clearTimeout(exact.timer); workerReplies++;
    if (exact.timedOut) exact.reject(Error('Owned Worker actual reply exceeded deadline')); else exact.resolve(value);
  }
  function onError() { if (pending) { const exact = pending; pending = undefined; clearTimeout(exact.timer); exact.reject(Error('Owned Worker failed')); } }
  worker.addEventListener('message', onMessage); worker.addEventListener('error', onError);
  function call(kind: 'write' | 'report' | 'hold', byte?: number): Promise<unknown> {
    if (pending || workerClosed || ++request > 8) return Promise.reject(Error('Owned Worker request capacity'));
    return new Promise((resolve, reject) => {
      // Logical deadline cannot free the actual issued request. Only the real
      // reply/error or owned context teardown settles its native-work boundary.
      const id = request, timer = setTimeout(() => { if (pending?.id === id) pending.timedOut = true; }, 1000);
      pending = { id, kind, resolve, reject, timer, timedOut: false }; worker.postMessage({ v: 1, kind, id, ...(byte === undefined ? {} : { byte }) });
    });
  }
  const owner = new AbortController(); let capture = new AbortController(), output = new AbortController(); const target = new EventTarget(), doc = new EventTarget();
  class Characteristic extends EventTarget implements NativeBleSwitchCharacteristic {
    readonly service: Service; readonly uuid = softwareProfile.characteristicUUID; value?: DataView; notifying = false;
    readonly properties: NativeBleSwitchProperties = Object.freeze({ authenticatedSignedWrites: false, broadcast: false, indicate: false, notify: true, read: false,
      reliableWrite: false, writableAuxiliaries: false, write: true, writeWithoutResponse: false });
    constructor(service: Service) { super(); this.service = service; }
    async startNotifications() { this.notifying = true; return this; }
    async stopNotifications() { this.notifying = false; return this; }
    async writeValueWithResponse(value: BufferSource) {
      if (!ArrayBuffer.isView(value)) throw Error('Owned one-byte argument required');
      const length = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get!;
      if (Reflect.apply(length, value, []) !== 1) throw Error('Owned one-byte argument required');
      const byte = new Uint8Array(value.buffer, value.byteOffset, 1)[0]; if (byte !== 0 && byte !== 1) throw Error('Owned boolean byte required');
      nativeWrites++; const result = await call('write', byte) as { kind: string }; if (result.kind !== 'returned') throw Error('Owned write reply type');
    }
    async report() {
      const result = await call('report') as { kind: string; byte: number; sequence: number; sourceTime: { clockId: string; at: number } };
      if (result.kind !== 'notification' || ![0, 1].includes(result.byte) || !Number.isSafeInteger(result.sequence) || result.sequence < 1 ||
        typeof result.sourceTime?.clockId !== 'string' || !result.sourceTime.clockId.startsWith('owned-worker-performance:') || !Number.isFinite(result.sourceTime.at)) throw Error('Owned notification shape');
      emissions.push({ byte: result.byte, sequence: result.sequence, sourceTime: result.sourceTime }); this.value = new DataView(Uint8Array.of(result.byte).buffer);
      if (this.notifying) this.dispatchEvent(new Event('characteristicvaluechanged'));
    }
  }
  class Service implements NativeBleSwitchService {
    readonly device: Device; readonly uuid = softwareProfile.serviceUUID; readonly isPrimary = true; readonly characteristic: Characteristic;
    constructor(device: Device) { this.device = device; this.characteristic = new Characteristic(this); }
    async getCharacteristic(uuid: string) { if (uuid !== this.characteristic.uuid) throw Error('Owned characteristic UUID'); return this.characteristic; }
  }
  class Server implements NativeBleSwitchServer {
    readonly device: Device; connected = false; disconnects = 0; readonly service: Service;
    constructor(device: Device) { this.device = device; this.service = new Service(device); }
    async connect() { this.connected = true; return this; }
    async getPrimaryService(uuid: string) { if (uuid !== this.service.uuid) throw Error('Owned service UUID'); return this.service; }
    disconnect() { this.disconnects++; this.connected = false; this.device.dispatchEvent(new Event('gattserverdisconnected')); }
  }
  class Device extends EventTarget implements NativeBleSwitchDevice { readonly gatt = new Server(this); }
  const device = new Device(), characteristic = device.gatt.service.characteristic;
  const manager: NativeBleSwitchManager = { async requestDevice(filter) { if (JSON.stringify(filter) !== JSON.stringify({ filters: [{ services: [softwareProfile.serviceUUID] }] })) throw Error('Owned fixed filter'); return device; } };
  const caller = createBrowserBleSwitchOutputCaller({ ownerSignal: owner.signal, reviewedProfile: softwareProfile,
    environment: { bluetooth: manager, target, document: doc, secureContext: () => true, userActivation: () => true, hidden: () => false, focused: () => true, policy: () => 'allowed' },
    authorizeCapture(request) { return { request, signal: capture.signal, expiresAt: end }; },
    authorizeOutput(request) { return outputAllowed ? { request, signal: output.signal, expiresAt: end } : undefined; },
    authorizeRoutes(request) {
      if (request.principalId !== 'ble-output-owner' || request.applicationId !== 'ble-output-example' || request.sessionId !== 'ble-output-session' || request.sourceOperation !== 'subscribe') return;
      if (request.source.capabilityId === 'switch' && request.sink.capabilityId === 'switch' && request.sinkOperation === 'write') return { expiresAt: end, maxAgeMs: 100, maxHz: 20 };
      if (routeAllowed && request.source.capabilityId === 'switch-setting' && request.sink.capabilityId === 'switch-setting' && request.sinkOperation === 'invoke') return { expiresAt: end, maxAgeMs: 100, maxHz: 2 };
    } });
  async function until(condition: () => boolean) { const deadline = Math.min(end, performance.now() + 1000); while (!condition() && performance.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 5)); caller.tick(); } if (!condition()) throw Error('Owned output condition deadline'); }
  let deniedOwner, deniedRoute, retained, apiReturn, reportedTrue, reportedFalse, issued, afterStop, beforeNativeReturn, recoveredGeneration = 0, final;
  try {
    const first = await caller.activate('owned-software-ble-capture'); if (!first.ok) throw Error('Owned initial capture failed');
    deniedOwner = caller.connectOutput('separately-declined-output'); await characteristic.report(); caller.tick(); retained = caller.state();
    if (deniedOwner.ok || retained.provider.activeSources !== 1 || nativeWrites !== 0) throw Error('Output denial must retain notification owner');
    outputAllowed = true; deniedRoute = caller.connectOutput('separately-denied-invoke'); if (deniedRoute.ok || nativeWrites !== 0) throw Error('Runtime invoke denial');
    caller.stop(); await until(() => caller.provider.snapshot().rawPending === 0); capture = new AbortController(); output = new AbortController(); end = performance.now() + 5000; routeAllowed = true;
    const recovered = await caller.activate('fresh-owned-software-capture'); if (!recovered.ok || recovered.value.connectionGeneration <= first.value.connectionGeneration) throw Error('Fresh capture generation'); recoveredGeneration = recovered.value.connectionGeneration;
    if (!caller.connectOutput('fresh-exact-output').ok || !caller.set(true).ok) throw Error('Owned true command');
    await until(() => caller.state().output.records.at(-1)?.outcome === 'api-returned'); apiReturn = caller.state();
    if (apiReturn.delivered !== retained.delivered) throw Error('API return must not fabricate notification');
    await characteristic.report(); caller.tick(); reportedTrue = caller.state(); if (!reportedTrue.held) throw Error('Independent true notification');
    await new Promise(resolve => setTimeout(resolve, 510)); if (!caller.set(false).ok) throw Error('Owned false command'); await until(() => caller.state().output.records.at(-1)?.outcome === 'api-returned');
    await characteristic.report(); caller.tick(); reportedFalse = caller.state(); if (reportedFalse.held) throw Error('Independent false notification');
    await new Promise(resolve => setTimeout(resolve, 510)); await call('hold'); if (!caller.set(true).ok) throw Error('Owned held command'); await until(() => heldIssued === 1); issued = caller.state();
    caller.stop(); afterStop = caller.state(); let closed = false; const closing = caller.close(); void closing.then(() => { closed = true; }); await Promise.resolve(); beforeNativeReturn = { closed, pendingRequests: pending ? 1 : 0, state: caller.state() };
    if (closed || afterStop.provider.rawPending === 0 || afterStop.output.records.at(-1)?.outcome !== 'uncertain' || issuedWrites() !== 3) throw Error('Issued raw settlement fence');
    worker.postMessage({ v: 1, kind: 'release' }); await closing; final = caller.state();
    return { kind: 'owned-native-worker-ble-output-software-profile', physicalBleQualification: false, softwareUuidFixture: true, trustedSoftwareGatt: true,
      deniedOwner, deniedRoute, retained, apiReturn, reportedTrue, reportedFalse, issued, afterStop, beforeNativeReturn, recoveredGeneration, final,
      nativeWrites, workerReplies, heldIssued, producerEmissions: emissions, disconnects: device.gatt.disconnects,
      clockMeaning: 'worker state emission and host notification receipt are distinct; no mapping or hardware capture time',
      cleanup };
  } finally {
    worker.postMessage({ v: 1, kind: 'release' }); owner.abort(); await caller.close();
    if (pending) { clearTimeout(pending.timer); pending.reject(Error('Owned Worker teardown')); pending = undefined; }
    worker.removeEventListener('message', onMessage); worker.removeEventListener('error', onError); worker.terminate(); workerClosed = true; URL.revokeObjectURL(url);
    cleanup.workerTerminateReturned = true; cleanup.workerListeners = 0; cleanup.pendingRequests = pending ? 1 : 0; cleanup.timers = pending ? 1 : 0; cleanup.actualProviderRaw = caller.state().provider.rawPending;
  }
}
