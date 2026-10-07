import { createBrowserSerialSwitchProvider, createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import type { Authorize, BrowserSerialSwitchActivation, BrowserSerialSwitchCaptureGrant, BrowserSerialSwitchCaptureRequest,
  BrowserSerialSwitchEnvironment, BrowserSerialSwitchOptions, BrowserSerialSwitchOutputGrant, BrowserSerialSwitchOutputRequest,
  BrowserSerialSwitchProfile, BrowserSerialSwitchOutputActivation, Connection, DeviceDescriptor, EndpointHandle, NativeSerialSwitchPort, NativeSerialSwitchManager, Observation } from '@101/connect';

const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const isAborted = (value: AbortSignal): boolean => Reflect.apply(aborted, value, []) as boolean;
export interface BrowserSerialSwitchOutputCallerOptions {
  readonly ownerSignal: AbortSignal; readonly reviewedProfile: BrowserSerialSwitchProfile; readonly now?: () => number;
  readonly authorizeCapture: (request: BrowserSerialSwitchCaptureRequest) => BrowserSerialSwitchCaptureGrant | undefined;
  readonly authorizeOutput: (request: BrowserSerialSwitchOutputRequest) => BrowserSerialSwitchOutputGrant | undefined;
  readonly authorizeRoutes: Authorize; readonly environment?: BrowserSerialSwitchEnvironment;
}

/** One selected Serial owner. API return is independent from separately routed
 * notification state. Stop removes local authority and never writes a reset. */
export function createBrowserSerialSwitchOutputCaller(options: BrowserSerialSwitchOutputCallerOptions) {
  const now = options.now ?? (() => performance.now()), scope = Object.freeze({ principalId: 'serial-output-owner', applicationId: 'serial-output-example', sessionId: 'serial-output-session' });
  const runtime = createDeviceRuntime({ now, clockDomain: 'serial-output-host-receipt', authorize(request) {
    const turn = epoch;
    if (!current(turn) || request.principalId !== scope.principalId || request.applicationId !== scope.applicationId || request.sessionId !== scope.sessionId || request.sourceOperation !== 'subscribe') return;
    const pair = request.sinkOperation === 'write' && same(request.source, active?.source, active?.device, 'switch') && same(request.sink, notificationSink, notificationDevice, 'switch') ||
      request.sinkOperation === 'invoke' && same(request.source, command, commandDevice, 'switch-setting') && same(request.sink, outputActivation?.sink, outputActivation?.device, 'switch-setting');
    if (!pair) return; const approved = options.authorizeRoutes(request); return current(turn) ? approved : undefined;
  }, maxRegistrations: 4, maxRoutes: 2, maxPendingDeliveries: 2 });
  const routes = new Map<string, Connection>(), endpoints = new Set<ReturnType<typeof runtime.registerSource>>();
  let active: BrowserSerialSwitchActivation | undefined, command: ReturnType<typeof runtime.registerSource> | undefined, commandRoute: Connection | undefined;
  let notificationSink: EndpointHandle | undefined, notificationDevice: DeviceDescriptor | undefined, commandDevice: DeviceDescriptor | undefined, outputActivation: BrowserSerialSwitchOutputActivation | undefined;
  function same(reference: Parameters<Authorize>[0]['source'], handle: EndpointHandle | undefined, device: DeviceDescriptor | undefined, capability: string): boolean {
    const row = device?.capabilities.find(value => value.id === capability);
    return !!handle && !!device && !!row && reference.registrationId === handle.id && reference.deviceId === device.id && reference.capabilityId === capability && reference.descriptorRevision === device.revision && reference.schemaVersion === row.schemaVersion;
  }
  let held = false, delivered = 0, releases = 0, last: Observation | undefined, epoch = 0, closed = false, operation = 0;
  let pending: Promise<Awaited<ReturnType<ReturnType<typeof createBrowserSerialSwitchProvider>['start']>>> | undefined, closing: Promise<void> | undefined;
  const outputDeliveryLimits: NonNullable<BrowserSerialSwitchOptions['outputDeliveryLimits']> = context => {
    const connection = routes.get(context.routeId), limits = connection?.limits();
    if (!connection || connection !== commandRoute || connection.status().state !== 'active' || !limits || !context.operationId) return;
    const record = connection.operations().find(row => row.id === context.operationId && row.handlerResult === 'running'); if (!record) return;
    return Object.freeze({ context, expiresAt: Math.min(limits.expiresAt, record.deadline), maxAgeMs: Math.min(limits.maxAgeMs, 100), maxHz: Math.min(limits.maxHz, 2) });
  };
  const provider = createBrowserSerialSwitchProvider({ runtime, ownerSignal: options.ownerSignal, scope, now, reviewedProfile: options.reviewedProfile,
    authorizeCapture: options.authorizeCapture, authorizeOutput: options.authorizeOutput, outputDeliveryLimits, ...(options.environment ? { environment: options.environment } : {}) });
  function current(turn: number) { return !closed && epoch === turn && !isAborted(options.ownerSignal); }
  function stop() {
    epoch++; active = undefined; command = undefined; commandRoute = undefined; notificationSink = undefined; notificationDevice = undefined; commandDevice = undefined; outputActivation = undefined; operation = 0;
    const connections = [...routes.values()], handles = [...endpoints]; routes.clear(); endpoints.clear();
    provider.stop(); for (const route of connections) route.stop('serial-output-caller-stop'); for (const handle of handles) runtime.unregister(handle);
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
          if (!current(turn)) { runtime.unregister(sink); finish({ ok: false, reason: 'cancelled' }); return; } endpoints.add(sink); notificationSink = sink; notificationDevice = device;
          if (!runtime.setReadiness(sink, 'available').ok || !current(turn)) { stop(); finish({ ok: false, reason: 'cancelled' }); return; }
          const route = runtime.route({ ...scope, from: activated.value.source, to: sink, leaseMs: 30000, queueCapacity: 8 });
          if (!current(turn)) { route.stop('late-serial-notification-route'); stop(); finish({ ok: false, reason: 'cancelled' }); return; } routes.set(route.id, route);
          if (!route.start().ok || !current(turn)) { stop(); finish({ ok: false, reason: 'denied' }); return; } finish(activated);
        } catch { stop(); finish({ ok: false, reason: 'unavailable' }); }
        finally { if (pending === result) pending = undefined; }
      })(); return result;
    },
    connectOutput(purpose: string) {
      const turn = epoch; if (!active || !current(turn) || command || commandRoute) return { ok: false as const, reason: 'busy' as const };
      try {
        const bound = provider.bindOutput(active, { purpose }); if (!bound.ok) return bound;
        if (!current(turn)) return { ok: false as const, reason: 'cancelled' as const };
        const device = parseDeviceDescriptor({ ...bound.value.device, id: bound.value.device.id + ':commands', capabilities: bound.value.device.capabilities.map(row => ({ ...row, kind: 'event' as const, permissions: ['subscribe'] })) });
        const source = runtime.registerSource({ device, capability: 'switch-setting' });
        if (!current(turn)) { runtime.unregister(source); return { ok: false as const, reason: 'cancelled' as const }; } endpoints.add(source); command = source; commandDevice = device; outputActivation = bound.value;
        if (!runtime.setReadiness(source, 'available').ok || !current(turn)) { stop(); return { ok: false as const, reason: 'cancelled' as const }; }
        const at = now(); if (!current(turn) || !Number.isFinite(at) || at >= bound.value.expiresAt) { stop(); return { ok: false as const, reason: 'expired' as const }; }
        const route = runtime.route({ ...scope, from: source, to: bound.value.sink, queueCapacity: 1, leaseMs: Math.max(1, Math.floor(Math.min(30000, bound.value.expiresAt - at))) });
        if (!current(turn)) { route.stop('late-serial-command-route'); stop(); return { ok: false as const, reason: 'cancelled' as const }; }
        routes.set(route.id, route); commandRoute = route; operation = 0; const started = route.start();
        if (!started.ok || !current(turn)) { route.stop('denied'); runtime.unregister(source); endpoints.delete(source); command = undefined; return { ok: false as const, reason: 'denied' as const }; }
        return bound;
      } catch { stop(); return { ok: false as const, reason: 'unavailable' as const }; }
    },
    set(value: boolean, deadline?: number) {
      const turn = epoch; if (!current(turn) || !command || !commandRoute || commandRoute.status().state !== 'active' || operation >= 31) return { ok: false as const, reason: 'denied' as const };
      try {
        const at = now(); if (!current(turn) || !Number.isFinite(at)) return { ok: false as const, reason: 'cancelled' as const };
        const result = runtime.publish(command, value, { timestamp: at, clockDomain: runtime.clockDomain, operationId: String(++operation), deadline: deadline ?? at + 100 }); runtime.flush(); return result;
      } catch { stop(); return { ok: false as const, reason: 'unavailable' as const }; }
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


const softwareProfile: BrowserSerialSwitchProfile = Object.freeze({ id: 'software:serial-one-byte-setting/1', revision: 1,
  usbVendorId: 0x0101, usbProductId: 2, writeFormat: 'boolean-byte/1' });

/** Default native availability and forged handles only; never opens a chooser. */
export async function checkSerialSwitchOutputWithoutDevice() {
  const owner = new AbortController(); let captureApprovals = 0, outputApprovals = 0;
  const caller = createBrowserSerialSwitchOutputCaller({ ownerSignal: owner.signal, reviewedProfile: softwareProfile,
    authorizeCapture() { captureApprovals++; return undefined; }, authorizeOutput() { outputApprovals++; return undefined; }, authorizeRoutes: () => undefined });
  try {
    const initial = caller.state(), availability = caller.provider.availability(), report = caller.provider.inspectOutput({} as BrowserSerialSwitchActivation), bound = caller.provider.bindOutput({} as BrowserSerialSwitchActivation, { purpose: 'not-issued' });
    await caller.close(); return { kind: 'inert-default-serial-output-negative', availability, initial, report, bound, captureApprovals, outputApprovals,
      nativeChoosers: 0, nativeOpens: 0, nativeWrites: 0, physicalSerialQualification: false, final: caller.state() };
  } finally { owner.abort(); await caller.close(); }
}

/** Real Worker and native Streams through explicitly trusted software Serial ports.
 * Write API return and independently requested state reports are distinct. */
export async function runSerialSwitchOutputWorkerFixture() {
  const code = `const clockId='owned-worker-performance:'+crypto.randomUUID();let state=0,sequence=0,hold=false,pending;
onmessage=e=>{const m=e.data;if(!m||m.v!==1)return;
if(m.kind==='release'&&pending){postMessage({v:1,kind:'returned',id:pending});pending=undefined;hold=false;return;}
if(!Number.isSafeInteger(m.id)||m.id<1||m.id>12)return;
if(m.kind==='hold'){hold=true;postMessage({v:1,kind:'control',id:m.id});return;}
if(m.kind==='write'&&(m.byte===0||m.byte===1)){state=m.byte;if(hold){pending=m.id;postMessage({v:1,kind:'held-issued',id:m.id});}else postMessage({v:1,kind:'returned',id:m.id});return;}
if(m.kind==='report')postMessage({v:1,kind:'notification',id:m.id,byte:state,sequence:++sequence,sourceTime:{clockId,at:performance.now()}});};`;
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' })), worker = new Worker(url);
  let request = 0, replies = 0, heldIssued = 0, nativeWrites = 0, outputAllowed = false, routeAllowed = false, end = performance.now() + 5000;
  let pending: { id: number; kind: string; resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout>; timedOut: boolean } | undefined;
  const writes = () => nativeWrites;
  const emissions: { byte: number; sequence: number; sourceTime: { clockId: string; at: number } }[] = [];
  const cleanup = { workerTerminateReturned: false, nativeWorkerExitObserved: false, workerListeners: 2, pendingRequests: 0, timers: 0, actualProviderRaw: -1 };
  function onMessage(event: MessageEvent) {
    const value = event.data; if (!value || value.v !== 1 || !pending || value.id !== pending.id) return;
    if (value.kind === 'held-issued' && pending.kind === 'write') { heldIssued++; return; }
    if (!['returned', 'notification', 'control'].includes(value.kind)) return;
    const exact = pending; pending = undefined; clearTimeout(exact.timer); replies++;
    if (exact.timedOut) exact.reject(Error('Owned Worker actual reply exceeded deadline')); else exact.resolve(value);
  }
  function onError() { if (pending) { const exact = pending; pending = undefined; clearTimeout(exact.timer); exact.reject(Error('Owned Worker failed')); } }
  worker.addEventListener('message', onMessage); worker.addEventListener('error', onError);
  function call(kind: 'write' | 'report' | 'hold', byte?: number): Promise<unknown> {
    if (pending || ++request > 12) return Promise.reject(Error('Owned Worker request capacity'));
    return new Promise((resolve, reject) => {
      const id = request, timer = setTimeout(() => { if (pending?.id === id) pending.timedOut = true; }, 1000);
      // Logical timeout cannot retire the actual issued reply reservation.
      pending = { id, kind, resolve, reject, timer, timedOut: false }; worker.postMessage({ v: 1, kind, id, ...(byte === undefined ? {} : { byte }) });
    });
  }
  const owner = new AbortController(); let capture = new AbortController(), output = new AbortController(); const target = new EventTarget(), doc = new EventTarget();
  class SoftwarePort extends EventTarget implements NativeSerialSwitchPort {
    readable: ReadableStream<Uint8Array> | null = null; writable: WritableStream<Uint8Array> | null = null;
    controller?: ReadableStreamDefaultController<Uint8Array>; opens = 0; closes = 0; cancels = 0;
    getInfo() { return { usbVendorId: softwareProfile.usbVendorId, usbProductId: softwareProfile.usbProductId }; }
    async open(options: Parameters<NativeSerialSwitchPort['open']>[0]) {
      if (JSON.stringify(options) !== JSON.stringify({ baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', bufferSize: 256, flowControl: 'none' })) throw Error('Owned fixed open options');
      this.opens++; this.readable = new ReadableStream<Uint8Array>({ start: controller => { this.controller = controller; }, cancel: () => { this.cancels++; } }, { highWaterMark: 1 });
      this.writable = new WritableStream<Uint8Array>({ async write(value) {
        const length = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'length')!.get!;
        if (Reflect.apply(length, value, []) !== 1 || (value[0] !== 0 && value[0] !== 1)) throw Error('Owned one-byte boolean required');
        nativeWrites++; const result = await call('write', value[0]) as { kind: string }; if (result.kind !== 'returned') throw Error('Owned write reply type');
      } }, { highWaterMark: 1 });
    }
    async close() { if (this.readable?.locked || this.writable?.locked) throw Error('Owned lock still held'); this.closes++; this.readable = null; this.writable = null; }
    async report() {
      const result = await call('report') as { kind: string; byte: number; sequence: number; sourceTime: { clockId: string; at: number } };
      if (result.kind !== 'notification' || ![0, 1].includes(result.byte) || !Number.isSafeInteger(result.sequence) || result.sequence < 1 ||
        typeof result.sourceTime?.clockId !== 'string' || !result.sourceTime.clockId.startsWith('owned-worker-performance:') || !Number.isFinite(result.sourceTime.at)) throw Error('Owned notification shape');
      emissions.push({ byte: result.byte, sequence: result.sequence, sourceTime: result.sourceTime }); this.controller!.enqueue(Uint8Array.of(result.byte));
    }
  }
  const port = new SoftwarePort();
  class Manager extends EventTarget implements NativeSerialSwitchManager { requests = 0;
    async requestPort(filter: Parameters<NativeSerialSwitchManager['requestPort']>[0]) { if (JSON.stringify(filter) !== JSON.stringify({ filters: [{ usbVendorId: softwareProfile.usbVendorId, usbProductId: softwareProfile.usbProductId }] })) throw Error('Owned fixed filter'); this.requests++; return port; }
  }
  const manager = new Manager();
  const caller = createBrowserSerialSwitchOutputCaller({ ownerSignal: owner.signal, reviewedProfile: softwareProfile,
    environment: { serial: manager, target, document: doc, secureContext: () => true, userActivation: () => true, hidden: () => false, focused: () => true, policy: () => 'allowed' },
    authorizeCapture(request) { return { request, signal: capture.signal, expiresAt: end }; },
    authorizeOutput(request) { return outputAllowed ? { request, signal: output.signal, expiresAt: end } : undefined; },
    authorizeRoutes(request) {
      if (request.principalId !== 'serial-output-owner' || request.applicationId !== 'serial-output-example' || request.sessionId !== 'serial-output-session' || request.sourceOperation !== 'subscribe') return;
      if (request.source.capabilityId === 'switch' && request.sink.capabilityId === 'switch' && request.sinkOperation === 'write') return { expiresAt: end, maxAgeMs: 100, maxHz: 20 };
      if (routeAllowed && request.source.capabilityId === 'switch-setting' && request.sink.capabilityId === 'switch-setting' && request.sinkOperation === 'invoke') return { expiresAt: end, maxAgeMs: 100, maxHz: 2 };
    } });
  async function until(condition: () => boolean) { const deadline = Math.min(end, performance.now() + 1000); while (!condition() && performance.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 5)); caller.tick(); } if (!condition()) throw Error('Owned output condition deadline'); }
  async function report() { await port.report(); await until(() => caller.state().delivered >= emissions.length); }
  async function pace() { for (let turn = 0; turn < 2; turn++) { await new Promise(resolve => setTimeout(resolve, 255)); await report(); } }
  let deniedOwner, deniedRoute, retained, apiReturn, reportedTrue, reportedFalse, issued, afterStop, beforeNativeReturn, recoveredGeneration = 0, final;
  try {
    const first = await caller.activate('owned-software-serial-capture'); if (!first.ok) throw Error('Owned initial capture failed');
    deniedOwner = caller.connectOutput('separately-declined-output'); await report(); retained = caller.state();
    if (deniedOwner.ok || retained.provider.activeSources !== 1 || writes() !== 0) throw Error('Output denial must retain reader');
    outputAllowed = true; deniedRoute = caller.connectOutput('separately-denied-invoke'); if (deniedRoute.ok || writes() !== 0) throw Error('Runtime invoke denial');
    caller.stop(); await until(() => caller.provider.snapshot().nativePending === 0); capture = new AbortController(); output = new AbortController(); end = performance.now() + 5000; routeAllowed = true;
    const recovered = await caller.activate('fresh-owned-software-capture'); if (!recovered.ok || recovered.value.connectionGeneration <= first.value.connectionGeneration) throw Error('Fresh capture generation'); recoveredGeneration = recovered.value.connectionGeneration;
    if (!caller.connectOutput('fresh-exact-output').ok || !caller.set(true).ok) throw Error('Owned true command');
    await until(() => caller.state().output.records.at(-1)?.outcome === 'api-returned'); apiReturn = caller.state(); if (apiReturn.delivered !== retained.delivered) throw Error('API return must not fabricate input');
    await report(); reportedTrue = caller.state(); if (!reportedTrue.held) throw Error('Independent true report'); await pace();
    if (!caller.set(false).ok) throw Error('Owned false command'); await until(() => caller.state().output.records.at(-1)?.outcome === 'api-returned'); await report(); reportedFalse = caller.state(); if (reportedFalse.held) throw Error('Independent false report'); await pace();
    await call('hold'); if (!caller.set(true).ok) throw Error('Owned held command'); await until(() => heldIssued === 1); issued = caller.state(); caller.stop(); afterStop = caller.state();
    let closed = false; const closing = caller.close(); void closing.then(() => { closed = true; }); await Promise.resolve(); beforeNativeReturn = { closed, pendingRequests: pending ? 1 : 0, state: caller.state() };
    if (closed || afterStop.provider.nativePending === 0 || afterStop.output.records.at(-1)?.outcome !== 'uncertain' || writes() !== 3) throw Error('Issued settlement fence');
    worker.postMessage({ v: 1, kind: 'release' }); await closing; final = caller.state();
    return { kind: 'owned-native-worker-streams-serial-output-software-profile', physicalSerialQualification: false, syntheticSerialProtocol: true, trustedSoftwareSerial: true,
      deniedOwner, deniedRoute, retained, apiReturn, reportedTrue, reportedFalse, issued, afterStop, beforeNativeReturn, recoveredGeneration, final,
      nativeWrites: writes(), workerReplies: replies, heldIssued, producerEmissions: emissions, port: { opens: port.opens, closes: port.closes, cancels: port.cancels, requests: manager.requests, readable: port.readable !== null, writable: port.writable !== null },
      clockMeaning: 'Worker state emission and host native stream read receipt are distinct; no UART capture mapping', cleanup };
  } finally {
    worker.postMessage({ v: 1, kind: 'release' }); owner.abort(); await caller.close();
    if (pending) { clearTimeout(pending.timer); pending.reject(Error('Owned Worker teardown')); pending = undefined; }
    worker.removeEventListener('message', onMessage); worker.removeEventListener('error', onError); worker.terminate(); URL.revokeObjectURL(url);
    cleanup.workerTerminateReturned = true; cleanup.workerListeners = 0; cleanup.pendingRequests = pending ? 1 : 0; cleanup.timers = pending ? 1 : 0; cleanup.actualProviderRaw = caller.state().provider.nativePending;
  }
}
