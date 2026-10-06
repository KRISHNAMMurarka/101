import { createBrowserBleSwitchProvider, createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import type { Authorize, BrowserBleSwitchCaptureGrant, BrowserBleSwitchCaptureRequest, BrowserBleSwitchEnvironment,
  BrowserBleSwitchProfile, NativeBleSwitchCharacteristic, NativeBleSwitchDevice, NativeBleSwitchManager,
  NativeBleSwitchProperties, NativeBleSwitchServer, NativeBleSwitchService, Observation } from '@101/connect';

export interface BrowserBleSwitchPipelineOptions {
  readonly ownerSignal: AbortSignal; readonly reviewedProfile: BrowserBleSwitchProfile;
  readonly authorizeCapture: (request: BrowserBleSwitchCaptureRequest) => BrowserBleSwitchCaptureGrant | undefined | Promise<BrowserBleSwitchCaptureGrant | undefined>;
  readonly authorizeRoutes: Authorize; readonly now?: () => number; readonly environment?: BrowserBleSwitchEnvironment;
}
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const isAborted = (signal: AbortSignal) => Reflect.apply(aborted, signal, []) as boolean;

/** Fixed read-only protocol. Caller approvals for capture and both route operations remain separate. */
export function createBrowserBleSwitchPipeline(options: BrowserBleSwitchPipelineOptions) {
  const now = options.now ?? (() => performance.now()), scope = Object.freeze({ principalId: 'ble-owner', applicationId: 'ble-example', sessionId: 'ble-session' });
  const runtime = createDeviceRuntime({ now, clockDomain: 'ble-javascript-receipt', authorize: options.authorizeRoutes, maxPendingDeliveries: 1 });
  const provider = createBrowserBleSwitchProvider({ runtime, ownerSignal: options.ownerSignal, scope, reviewedProfile: options.reviewedProfile, now,
    authorizeCapture: options.authorizeCapture, ...(options.environment ? { environment: options.environment } : {}) });
  let sink: ReturnType<typeof runtime.registerSink> | undefined, route: ReturnType<typeof runtime.route> | undefined;
  let held = false, delivered = 0, releases = 0, last: Observation | undefined, closed = false, epoch = 0;
  let pending: Promise<Awaited<ReturnType<typeof provider.start>>> | undefined, closing: Promise<void> | undefined;
  const release = () => { held = false; releases++; };
  function stop() {
    epoch++; const old = route, endpoint = sink; route = undefined; sink = undefined;
    provider.stop(); old?.stop('ble-source-retired'); if (endpoint) runtime.unregister(endpoint); release();
  }
  return Object.freeze({ provider,
    activate(purpose: string) {
      if (closed || pending || sink || isAborted(options.ownerSignal)) return Promise.resolve({ ok: false as const, reason: 'busy' as const });
      const turn = ++epoch; let finish!: (value: Awaited<ReturnType<typeof provider.start>>) => void;
      const result = new Promise<Awaited<ReturnType<typeof provider.start>>>(resolve => { finish = resolve; }); pending = result;
      const current = () => !closed && epoch === turn && !isAborted(options.ownerSignal);
      void (async () => {
        try {
          const selected = await provider.choose(); if (!selected.ok) { finish(selected); return; }
          if (!current()) { finish({ ok: false, reason: 'cancelled' }); return; }
          const active = await provider.start(selected.value, { purpose }); if (!active.ok) { finish(active); return; }
          if (!current()) { provider.stop(); finish({ ok: false, reason: 'cancelled' }); return; }
          const device = parseDeviceDescriptor({ ...active.value.device, id: active.value.device.id + ':consumer', capabilities: active.value.device.capabilities.map(capability =>
            ({ ...capability, permissions: ['write'], ownership: { mode: 'observe' } })) });
          const registered = runtime.registerSink({ device, capability: 'switch', apply(observation, context) {
            if (!current() || !context.isCurrent() || isAborted(context.signal) || !current()) return;
            held = (observation.value as { active: boolean }).active; last = observation; delivered++;
          }, release });
          if (!current()) { runtime.unregister(registered); finish({ ok: false, reason: 'cancelled' }); return; } sink = registered;
          const ready = runtime.setReadiness(registered, 'available');
          if (!ready.ok || !current()) { stop(); finish({ ok: false, reason: 'cancelled' }); return; }
          const connection = runtime.route({ ...scope, from: active.value.source, to: registered, leaseMs: 30000, queueCapacity: 8 });
          // The real returned handle is available only after runtime.route callouts finish.
          if (!current()) { connection.stop('late-ble-route'); stop(); finish({ ok: false, reason: 'cancelled' }); return; } route = connection;
          const started = connection.start();
          if (!started.ok || !current()) { stop(); finish({ ok: false, reason: 'denied' }); return; } finish(active);
        } catch { stop(); finish({ ok: false, reason: 'unavailable' }); }
        finally { if (pending === result) pending = undefined; }
      })(); return result;
    },
    tick() { runtime.flush(); },
    state() { return Object.freeze({ held, delivered, releases, ...(last ? { lastObservation: last } : {}), provider: provider.snapshot() }); },
    stop,
    close() {
      if (closing) return closing; let finish!: () => void, fail!: (error: unknown) => void;
      closing = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; }); closed = true; stop();
      void (async () => { try { await provider.close(); if (pending) await pending; runtime.close(); finish(); } catch (error) { runtime.close(); fail(error); } })();
      return closing;
    },
  });
}

const softwareProfile: BrowserBleSwitchProfile = Object.freeze({ id: 'software:ble-one-byte-switch/1', revision: 1,
  serviceUUID: '5f5a0101-0000-4000-8000-010100000001', characteristicUUID: '5f5a0101-0000-4000-8000-010100000002' });

/** Actual native API/activation/policy negatives only. No BLE chooser, peripheral or grant is acquired. */
export async function checkBrowserBleSwitchWithoutDevice() {
  const owner = new AbortController(); let approvals = 0;
  const pipeline = createBrowserBleSwitchPipeline({ ownerSignal: owner.signal, reviewedProfile: softwareProfile,
    authorizeCapture() { approvals++; return undefined; }, authorizeRoutes() { return undefined; } });
  try {
    const initial = pipeline.provider.snapshot(), availability = pipeline.provider.availability();
    const native = { apiPresent: typeof navigator !== 'undefined' && !!(navigator as Navigator & { bluetooth?: unknown }).bluetooth,
      userActivation: typeof navigator !== 'undefined' && navigator.userActivation?.isActive === true,
      secureContext: globalThis.isSecureContext === true, focused: document.hasFocus(), hidden: document.hidden };
    const selection = native.userActivation ? { ok: false as const, reason: 'not-exercised-active-user' } : await pipeline.provider.choose();
    await pipeline.close(); return { kind: 'actual-browser-native-availability-negative', native, availability, initial, selection,
      captureApprovals: approvals, final: pipeline.provider.snapshot(), physicalBleQualification: false, nativeChooserOpened: false };
  } finally { owner.abort(); await pipeline.close(); }
}

/** Real browser Worker bytes and native EventTarget/DataView, through trusted software GATT ports. */
export async function runBrowserBleSwitchWorkerFixture() {
  const owner = new AbortController(); let capture = new AbortController(), at = 100;
  const target = new EventTarget(), doc = new EventTarget();
  class Characteristic extends EventTarget implements NativeBleSwitchCharacteristic {
    readonly service: Service; readonly uuid = softwareProfile.characteristicUUID; value?: DataView;
    readonly properties: NativeBleSwitchProperties = Object.freeze({ authenticatedSignedWrites: false, broadcast: false, indicate: false,
      notify: true, read: false, reliableWrite: false, writableAuxiliaries: false, write: false, writeWithoutResponse: false });
    starts = 0; stops = 0; notifying = false;
    constructor(service: Service) { super(); this.service = service; }
    async startNotifications() { this.starts++; this.notifying = true; return this; }
    async stopNotifications() { this.stops++; this.notifying = false; return this; }
    report(byte: number) { this.value = new DataView(Uint8Array.of(byte).buffer); this.dispatchEvent(new Event('characteristicvaluechanged')); }
  }
  class Service implements NativeBleSwitchService {
    readonly device: Device; readonly uuid = softwareProfile.serviceUUID; readonly isPrimary = true; readonly characteristic: Characteristic;
    constructor(device: Device) { this.device = device; this.characteristic = new Characteristic(this); }
    async getCharacteristic(uuid: string) { if (uuid !== this.characteristic.uuid) throw new Error('Unreviewed software characteristic'); return this.characteristic; }
  }
  class Server implements NativeBleSwitchServer {
    readonly device: Device; readonly service: Service; connected = false; connects = 0; disconnects = 0;
    constructor(device: Device) { this.device = device; this.service = new Service(device); }
    async connect() { this.connects++; this.connected = true; return this; }
    async disconnect() { this.disconnects++; this.connected = false; this.device.dispatchEvent(new Event('gattserverdisconnected')); }
    async getPrimaryService(uuid: string) { if (uuid !== this.service.uuid) throw new Error('Unreviewed software service'); return this.service; }
  }
  class Device extends EventTarget implements NativeBleSwitchDevice { readonly gatt: Server; constructor() { super(); this.gatt = new Server(this); } }
  const device = new Device();
  class Manager implements NativeBleSwitchManager {
    calls = 0;
    async requestDevice(options: Parameters<NativeBleSwitchManager['requestDevice']>[0]) {
      if (options.filters.length !== 1 || options.filters[0]?.services.length !== 1 || options.filters[0].services[0] !== softwareProfile.serviceUUID)
        throw new Error('Unreviewed software selection'); this.calls++; return device;
    }
  }
  const manager = new Manager(), pipeline = createBrowserBleSwitchPipeline({ ownerSignal: owner.signal, reviewedProfile: softwareProfile, now: () => at,
    authorizeCapture(request) { return { request, signal: capture.signal, expiresAt: 1100 }; }, authorizeRoutes(request) {
      if (request.principalId === 'ble-owner' && request.applicationId === 'ble-example' && request.sessionId === 'ble-session' &&
        request.source.capabilityId === 'switch' && request.sink.capabilityId === 'switch' && request.sourceOperation === 'subscribe' && request.sinkOperation === 'write')
        return { expiresAt: 1100, maxAgeMs: 100, maxHz: 20 };
    }, environment: { bluetooth: manager, target, document: doc, secureContext: () => true, userActivation: () => true,
      hidden: () => false, focused: () => true, policy: () => 'allowed' } });
  const url = URL.createObjectURL(new Blob(["onmessage=e=>{if(e.data===0||e.data===1)postMessage(e.data);else throw Error('Unreviewed byte')}"] , { type: 'text/javascript' }));
  let worker: Worker | undefined, timer: ReturnType<typeof setTimeout> | undefined, workerReplies = 0;
  const cleanup = { workerTerminated: false, urlRevoked: false, timerCleared: false, callbacksCleared: false, pendingReplies: 0 };
  let resolveReply: ((byte: number) => void) | undefined, rejectReply: ((error: Error) => void) | undefined;
  async function settled() {
    for (let turn = 0; turn < 32 && pipeline.provider.snapshot().rawPending; turn++) await Promise.resolve();
    if (pipeline.provider.snapshot().rawPending) throw new Error('Owned software cleanup did not settle');
  }
  try {
    worker = new Worker(url);
    worker.onmessage = event => {
      if ((event.data !== 0 && event.data !== 1) || !resolveReply) { rejectReply?.(new Error('Unexpected owned Worker byte')); return; }
      workerReplies++; const resolve = resolveReply; resolveReply = undefined; rejectReply = undefined; resolve(event.data as number);
    };
    worker.onerror = () => { rejectReply?.(new Error('Owned Worker failed')); };
    const send = async (byte: number) => {
      if (resolveReply || workerReplies >= 5) throw new Error('Owned Worker quota');
      const response = new Promise<number>((resolve, reject) => { resolveReply = resolve; rejectReply = reject;
        timer = setTimeout(() => { rejectReply?.(new Error('Owned Worker deadline')); }, 1000); });
      worker!.postMessage(byte); const result = await response; clearTimeout(timer); timer = undefined;
      device.gatt.service.characteristic.report(result); pipeline.tick(); return pipeline.state();
    };
    const active = await pipeline.activate('owned-software-worker'); if (!active.ok) throw new Error('Software BLE admission failed');
    const press = await send(1); at += 50; const release = await send(0); at += 50; const pressAgain = await send(1);
    capture.abort(); const revoked = pipeline.state(); at += 50; const late = await send(0);
    pipeline.stop(); await settled(); const retried = await pipeline.activate('revoked-approval-refused');
    await settled(); capture = new AbortController(); const recovery = await pipeline.activate('fresh-explicit-approval');
    if (!recovery.ok) throw new Error('Fresh software BLE approval failed'); at += 50; const recovered = await send(1);
    await pipeline.close();
    return { kind: 'owned-native-worker-through-trusted-software-gatt-port', physicalBleQualification: false, softwareUuidFixture: true,
      workerReplies, cleanup, softwareClock: true, sourceClock: 'ble-javascript-receipt', press, release, pressAgain, revoked, late, retried, recovered,
      generations: { first: active.value.connectionGeneration, recovered: recovery.value.connectionGeneration }, final: pipeline.provider.snapshot(),
      softwarePort: { requestDeviceCalls: manager.calls, connects: device.gatt.connects, disconnects: device.gatt.disconnects,
        connected: device.gatt.connected, starts: device.gatt.service.characteristic.starts, stops: device.gatt.service.characteristic.stops,
        notifying: device.gatt.service.characteristic.notifying },
      bounds: { callerReliableQueue: 8, callerPendingDeliveries: 1, notificationBytes: 1, workerPending: 1, workerReplies: 5 } };
  } finally {
    if (timer !== undefined) clearTimeout(timer); timer = undefined; cleanup.timerCleared = true;
    if (worker) { worker.onmessage = null; worker.onerror = null; cleanup.callbacksCleared = true; worker.terminate(); cleanup.workerTerminated = true; }
    cleanup.pendingReplies = resolveReply ? 1 : 0; URL.revokeObjectURL(url); cleanup.urlRevoked = true; owner.abort(); await pipeline.close();
  }
}
