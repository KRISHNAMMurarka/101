import { createBrowserHidSwitchProvider, createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import type { Authorize, BrowserHidSwitchCaptureGrant, BrowserHidSwitchCaptureRequest, BrowserHidSwitchEnvironment,
  BrowserHidSwitchProfile, NativeHidSwitchDevice, NativeHidSwitchManager, Observation } from '@101/connect';

export interface BrowserHidSwitchPipelineOptions {
  readonly ownerSignal: AbortSignal; readonly reviewedProfile: BrowserHidSwitchProfile;
  readonly authorizeCapture: (request: BrowserHidSwitchCaptureRequest) => BrowserHidSwitchCaptureGrant | undefined | Promise<BrowserHidSwitchCaptureGrant | undefined>;
  readonly authorizeRoutes: Authorize; readonly now?: () => number; readonly environment?: BrowserHidSwitchEnvironment;
}
/** Read-only selected switch input. Capture consent and both runtime route operations are independent. */
export function createBrowserHidSwitchPipeline(options: BrowserHidSwitchPipelineOptions) {
  const now = options.now ?? (() => performance.now()), scope = Object.freeze({ principalId: 'hid-owner', applicationId: 'hid-example', sessionId: 'hid-session' });
  const runtime = createDeviceRuntime({ now, clockDomain: 'hid-javascript-receipt', authorize: options.authorizeRoutes, maxPendingDeliveries: 1 });
  const provider = createBrowserHidSwitchProvider({ runtime, ownerSignal: options.ownerSignal, scope, reviewedProfile: options.reviewedProfile, now,
    authorizeCapture: options.authorizeCapture, ...(options.environment ? { environment: options.environment } : {}) });
  let sink: ReturnType<typeof runtime.registerSink> | undefined, route: ReturnType<typeof runtime.route> | undefined;
  let held = false, delivered = 0, releases = 0, last: Observation | undefined, closed = false, epoch = 0, pending: Promise<unknown> | undefined, closing: Promise<void> | undefined;
  const release = () => { held = false; releases++; };
  function stop() { epoch++; provider.stop(); const old = route; route = undefined; old?.stop('switch-source-retired');
    const endpoint = sink; sink = undefined; if (endpoint) runtime.unregister(endpoint); release(); }
  return Object.freeze({ provider,
    activate(purpose: string) {
      if (closed || pending || sink) return Promise.resolve({ ok: false as const, reason: 'busy' as const });
      const turn = ++epoch;
      // Publish the reservation before any provider/host callback can reenter.
      let finish!: (value: Awaited<ReturnType<typeof provider.start>>) => void;
      const result = new Promise<Awaited<ReturnType<typeof provider.start>>>(resolve => { finish = resolve; }); pending = result;
      void (async () => {
        try {
          const selected = await provider.choose(); if (!selected.ok) { finish(selected); return; }
          if (closed || epoch !== turn) { finish({ ok: false, reason: 'cancelled' }); return; }
          const active = await provider.start(selected.value, { purpose }); if (!active.ok) { finish(active); return; }
          if (closed || epoch !== turn) { provider.stop(); finish({ ok: false, reason: 'cancelled' }); return; }
          const device = parseDeviceDescriptor({ ...active.value.device, id: active.value.device.id + ':consumer', capabilities: active.value.device.capabilities.map(c =>
            ({ ...c, permissions: ['write'], ownership: { mode: 'observe' } })) });
          const registered = runtime.registerSink({ device, capability: 'switch', apply(observation, context) {
            if (closed || context.signal.aborted || !context.isCurrent()) return; held = (observation.value as { active: boolean }).active; last = observation; delivered++;
          }, release });
          if (closed || epoch !== turn) { runtime.unregister(registered); finish({ ok: false, reason: 'cancelled' }); return; } sink = registered;
          runtime.setReadiness(sink, 'available'); route = runtime.route({ ...scope, from: active.value.source, to: sink, leaseMs: 30000, queueCapacity: 8 });
          const started = route.start(); if (closed || epoch !== turn || !started.ok) { stop(); finish({ ok: false, reason: 'denied' }); return; } finish(active);
        } catch { stop(); finish({ ok: false, reason: 'unavailable' }); }
        finally { if (pending === result) pending = undefined; }
      })(); return result;
    },
    tick() { runtime.flush(); },
    state() { return Object.freeze({ held, delivered, releases, ...(last ? { lastObservation: last } : {}), provider: provider.snapshot() }); },
    stop,
    close() { if (closing) return closing; let finish!: () => void; closing = new Promise<void>(resolve => { finish = resolve; });
      closed = true; stop(); void (async () => { await provider.close(); if (pending) await pending; runtime.close(); finish(); })(); return closing; },
  });
}

const softwareProfile: BrowserHidSwitchProfile = Object.freeze({ id: 'software:one-byte-switch/1', revision: 1,
  vendorId: 0x0101, productId: 1, usagePage: 0xff00, usage: 1, reportId: 1 });

/** Native API/readback negatives only. This function never opens a HID chooser or device. */
export async function checkBrowserHidSwitchWithoutDevice() {
  const owner = new AbortController(); let approvals = 0;
  const pipeline = createBrowserHidSwitchPipeline({ ownerSignal: owner.signal, reviewedProfile: softwareProfile,
    authorizeCapture() { approvals++; return undefined; }, authorizeRoutes() { return undefined; } });
  try {
    const initial = pipeline.provider.snapshot(), availability = pipeline.provider.availability();
    const native = { apiPresent: typeof navigator !== 'undefined' && !!(navigator as Navigator & { hid?: unknown }).hid,
      userActivation: typeof navigator !== 'undefined' && navigator.userActivation?.isActive === true,
      secureContext: globalThis.isSecureContext === true, focused: document.hasFocus(), hidden: document.hidden };
    // Default chooser is invoked only when native activation is absent, so no dialog is possible.
    const selection = native.userActivation ? { ok: false as const, reason: 'not-exercised-active-user' } : await pipeline.provider.choose();
    await pipeline.close(); return { kind: 'actual-browser-native-availability-negative', native, availability, initial, selection,
      captureApprovals: approvals, final: pipeline.provider.snapshot(), physicalHidQualification: false, nativeChooserOpened: false };
  } finally { owner.abort(); await pipeline.close(); }
}

/** A real owned browser Worker produces bytes, through trusted software HID ports and actual SDK routes. */
export async function runBrowserHidSwitchWorkerFixture() {
  const owner = new AbortController(), capture = new AbortController(), target = new EventTarget(), doc = new EventTarget();
  class SoftwareDevice extends EventTarget implements NativeHidSwitchDevice {
    readonly vendorId = softwareProfile.vendorId; readonly productId = softwareProfile.productId; opened = false; opens = 0; closes = 0;
    readonly collections = [{ usagePage: 0xff00, usage: 1, children: [], inputReports: [{ reportId: 1, items: [{ reportSize: 8, reportCount: 1,
      logicalMinimum: 0, logicalMaximum: 1, isAbsolute: true, isArray: false, isBufferedBytes: false, isConstant: false, isLinear: true,
      hasNull: false, wrap: false, unitExponent: 0, unitSystem: 'none', usages: [0xff000001] }] }], outputReports: [], featureReports: [] }];
    async open() { this.opens++; this.opened = true; } async close() { this.closes++; this.opened = false; }
    report(value: number) { const event = new Event('inputreport'); Object.defineProperties(event, { device: { value: this }, reportId: { value: 1 },
      data: { value: new DataView(Uint8Array.of(value).buffer) } }); this.dispatchEvent(event); }
  }
  const device = new SoftwareDevice();
  class SoftwareManager extends EventTarget implements NativeHidSwitchManager { calls = 0;
    async requestDevice() { this.calls++; return [device]; }
    disconnect() { const event = new Event('disconnect'); Object.defineProperty(event, 'device', { value: device }); this.dispatchEvent(event); } }
  const manager = new SoftwareManager(); let at = 100;
  const pipeline = createBrowserHidSwitchPipeline({ ownerSignal: owner.signal, reviewedProfile: softwareProfile, now: () => at,
    authorizeCapture(request) { return { request, signal: capture.signal, expiresAt: 1100 }; }, authorizeRoutes(request) {
      if (request.principalId === 'hid-owner' && request.applicationId === 'hid-example' && request.sessionId === 'hid-session' &&
        request.source.capabilityId === 'switch' && request.sink.capabilityId === 'switch' && request.sourceOperation === 'subscribe' && request.sinkOperation === 'write')
        return { expiresAt: 1100, maxAgeMs: 100, maxHz: 20 };
    }, environment: { hid: manager, target, document: doc, secureContext: () => true, userActivation: () => true, hidden: () => false, focused: () => true, policy: () => 'allowed' } });
  const workerSource = `onmessage=e=>{if(e.data===0||e.data===1)postMessage(e.data);else throw Error('Unsupported software byte')}`;
  const url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' })); let worker: Worker | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let workerReplies = 0;
  try {
    worker = new Worker(url); const replies: ((value: number) => void)[] = [];
    worker.onmessage = event => { if ((event.data !== 0 && event.data !== 1) || replies.length !== 1) throw new Error('Unexpected owned Worker output');
      workerReplies++; replies.shift()!(event.data as number); };
    const send = async (value: number) => { const reply = new Promise<number>((resolve, reject) => { replies.push(resolve); timer = setTimeout(() => reject(new Error('Owned Worker deadline')), 1000); });
      worker!.postMessage(value); const byte = await reply; clearTimeout(timer); timer = undefined; device.report(byte); pipeline.tick(); return pipeline.state(); };
    const active = await pipeline.activate('owned-software-worker'); if (!active.ok) throw new Error('Software admission failed');
    const press = await send(1); at += 50; const release = await send(0); at += 50; const pressAgain = await send(1);
    capture.abort(); const revoked = pipeline.state(); at += 50; const late = await send(0);
    pipeline.stop(); const retried = await pipeline.activate('revoked-approval-refused');
    await pipeline.close();
    // A separate current grant can choose again; the revoked grant here establishes default refusal.
    return { kind: 'owned-native-worker-through-trusted-software-hid-port', physicalHidQualification: false, syntheticReportLayout: true,
      workerReplies, softwareClock: true, sourceClock: 'hid-javascript-receipt', press, release, pressAgain, revoked, late, retried,
      final: pipeline.provider.snapshot(), nativePort: { chooserCalls: manager.calls, opens: device.opens, closes: device.closes, opened: device.opened },
      bounds: { callerReliableQueue: 8, callerPendingDeliveries: 1, reportBytes: 1, workerPending: 1 } };
  } finally { if (timer !== undefined) clearTimeout(timer); worker?.terminate(); URL.revokeObjectURL(url); owner.abort(); await pipeline.close(); }
}
