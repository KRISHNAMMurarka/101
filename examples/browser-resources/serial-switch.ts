import { createBrowserSerialSwitchProvider, createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import type { Authorize, BrowserSerialSwitchCaptureGrant, BrowserSerialSwitchCaptureRequest, BrowserSerialSwitchEnvironment,
  BrowserSerialSwitchProfile, NativeSerialSwitchPort, NativeSerialSwitchManager, Observation } from '@101/connect';

export interface BrowserSerialSwitchPipelineOptions {
  readonly ownerSignal: AbortSignal; readonly reviewedProfile: BrowserSerialSwitchProfile;
  readonly authorizeCapture: (request: BrowserSerialSwitchCaptureRequest) => BrowserSerialSwitchCaptureGrant | undefined | Promise<BrowserSerialSwitchCaptureGrant | undefined>;
  readonly authorizeRoutes: Authorize; readonly now?: () => number; readonly environment?: BrowserSerialSwitchEnvironment;
}
/** Read-only selected switch input. Capture consent and both runtime route operations are independent. */
export function createBrowserSerialSwitchPipeline(options: BrowserSerialSwitchPipelineOptions) {
  const now = options.now ?? (() => performance.now()), scope = Object.freeze({ principalId: 'serial-owner', applicationId: 'serial-example', sessionId: 'serial-session' });
  const runtime = createDeviceRuntime({ now, clockDomain: 'serial-javascript-read-receipt', authorize: options.authorizeRoutes, maxPendingDeliveries: 1 });
  const provider = createBrowserSerialSwitchProvider({ runtime, ownerSignal: options.ownerSignal, scope, reviewedProfile: options.reviewedProfile, now,
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

const softwareProfile: BrowserSerialSwitchProfile = Object.freeze({ id: 'software:serial-byte-switch/1', revision: 1,
  usbVendorId: 0x0101, usbProductId: 2 });

/** Native API/readback negatives only. This function never opens a Serial chooser or device. */
export async function checkBrowserSerialSwitchWithoutDevice() {
  const owner = new AbortController(); let approvals = 0;
  const pipeline = createBrowserSerialSwitchPipeline({ ownerSignal: owner.signal, reviewedProfile: softwareProfile,
    authorizeCapture() { approvals++; return undefined; }, authorizeRoutes() { return undefined; } });
  try {
    const initial = pipeline.provider.snapshot(), availability = pipeline.provider.availability();
    const native = { apiPresent: typeof navigator !== 'undefined' && !!(navigator as Navigator & { serial?: unknown }).serial,
      userActivation: typeof navigator !== 'undefined' && navigator.userActivation?.isActive === true,
      secureContext: globalThis.isSecureContext === true, focused: document.hasFocus(), hidden: document.hidden };
    // Default chooser is invoked only when native activation is absent, so no dialog is possible.
    const selection = native.userActivation ? { ok: false as const, reason: 'not-exercised-active-user' } : await pipeline.provider.choose();
    await pipeline.close(); return { kind: 'actual-browser-native-availability-negative', native, availability, initial, selection,
      captureApprovals: approvals, final: pipeline.provider.snapshot(), physicalSerialQualification: false, nativeChooserOpened: false };
  } finally { owner.abort(); await pipeline.close(); }
}

/** A real owned browser Worker produces bytes, through trusted software SERIAL ports and actual SDK routes. */
export async function runBrowserSerialSwitchWorkerFixture() {
  const owner = new AbortController(), capture = new AbortController(), target = new EventTarget(), doc = new EventTarget();
  class SoftwarePort extends EventTarget implements NativeSerialSwitchPort {
    readable: ReadableStream<Uint8Array> | null = null; writable: WritableStream<Uint8Array> | null = null;
    controller?: ReadableStreamDefaultController<Uint8Array>; opens = 0; closes = 0; cancels = 0;
    getInfo() { return { usbVendorId: softwareProfile.usbVendorId, usbProductId: softwareProfile.usbProductId }; }
    async open() { this.opens++; this.readable = new ReadableStream<Uint8Array>({ start: controller => { this.controller = controller; },
      cancel: () => { this.cancels++; } }, { highWaterMark: 1 }); }
    async close() { if (this.readable?.locked) throw new Error('Owned reader still locked'); this.closes++; this.readable = null; }
  }
  const port = new SoftwarePort();
  class SoftwareManager extends EventTarget implements NativeSerialSwitchManager { calls = 0;
    async requestPort() { this.calls++; return port; }
    disconnect() { const event = new Event('disconnect'); Object.defineProperty(event, 'port', { value: port }); this.dispatchEvent(event); } }
  const manager = new SoftwareManager(); let at = 100;
  const pipeline = createBrowserSerialSwitchPipeline({ ownerSignal: owner.signal, reviewedProfile: softwareProfile, now: () => at,
    authorizeCapture(request) { return { request, signal: capture.signal, expiresAt: 1100 }; }, authorizeRoutes(request) {
      if (request.principalId === 'serial-owner' && request.applicationId === 'serial-example' && request.sessionId === 'serial-session' &&
        request.source.capabilityId === 'switch' && request.sink.capabilityId === 'switch' && request.sourceOperation === 'subscribe' && request.sinkOperation === 'write')
        return { expiresAt: 1100, maxAgeMs: 100, maxHz: 20 };
    }, environment: { serial: manager, target, document: doc, secureContext: () => true, userActivation: () => true, hidden: () => false, focused: () => true, policy: () => 'allowed' } });
  const workerSource = `onmessage=e=>{if(e.data===0||e.data===1){const b=Uint8Array.of(e.data);postMessage(b,[b.buffer]);}else throw Error('Unsupported software byte')}`;
  const url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' })); let worker: Worker | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let workerReplies = 0, lateEnqueueRefused = false;
  try {
    worker = new Worker(url); const replies: ((value: Uint8Array) => void)[] = [];
    worker.onmessage = event => { if (!(event.data instanceof Uint8Array) || event.data.length !== 1 || (event.data[0] !== 0 && event.data[0] !== 1) || replies.length !== 1) throw new Error('Unexpected owned Worker output');
      workerReplies++; replies.shift()!(event.data as Uint8Array); };
    const send = async (value: number, retired = false) => { const reply = new Promise<Uint8Array>((resolve, reject) => { replies.push(resolve); timer = setTimeout(() => reject(new Error('Owned Worker deadline')), 1000); });
      worker!.postMessage(value); const bytes = await reply; clearTimeout(timer); timer = undefined;
      if (retired) { try { port.controller!.enqueue(bytes); } catch (error) { if (!(error instanceof TypeError)) throw error; lateEnqueueRefused = true; }
        if (!lateEnqueueRefused) throw new Error('Retired stream accepted late software bytes'); } else port.controller!.enqueue(bytes);
      for (let turn = 0; turn < 12; turn++) await Promise.resolve(); pipeline.tick(); return pipeline.state(); };
    const active = await pipeline.activate('owned-software-worker'); if (!active.ok) throw new Error('Software admission failed');
    const press = await send(1); at += 50; const release = await send(0); at += 50; const pressAgain = await send(1);
    capture.abort(); const revoked = pipeline.state(); at += 50;
    const late = await send(0, true);
    pipeline.stop(); const retried = await pipeline.activate('revoked-approval-refused');
    await pipeline.close();
    // A separate current grant can choose again; the revoked grant here establishes default refusal.
    return { kind: 'owned-native-worker-readable-stream-through-trusted-software-serial-port', physicalSerialQualification: false, syntheticSerialProtocol: true,
      workerReplies, lateEnqueueRefused, softwareClock: true, sourceClock: 'serial-javascript-read-receipt', press, release, pressAgain, revoked, late, retried,
      final: pipeline.provider.snapshot(), nativePort: { chooserCalls: manager.calls, opens: port.opens, closes: port.closes, cancels: port.cancels, readable: port.readable !== null },
      bounds: { callerReliableQueue: 8, callerPendingDeliveries: 1, frameBytes: 1, workerPending: 1 } };
  } finally { if (timer !== undefined) clearTimeout(timer); worker?.terminate(); URL.revokeObjectURL(url); owner.abort(); await pipeline.close(); }
}
