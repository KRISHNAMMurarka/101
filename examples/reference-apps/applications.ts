import { createDeviceRuntime, parseDeviceDescriptor, PointerSourceDriver, createInputOwnershipController, pointerSourceDescriptor, createBrowserApplicationMedia } from '@101/connect';
import type { DeviceDescriptor, DeviceCapability, ValueSchema, Observation, DeliveryContext, Connection, EndpointHandle, InputOwnershipController, BrowserApplicationMediaBinding } from '@101/connect';

/** These are independent application jobs, not hardware or remote-identity declarations. */
export const REFERENCE_APPLICATIONS = Object.freeze([
  { id: 'pointer', title: 'Application pointer', producer: 'Actual browser pointer and equivalent keyboard controls', job: 'Move and hold a cursor within an owned application surface.' },
  { id: 'sensor-dashboard', title: 'Software sensor dashboard', producer: 'Actual elapsed browser timer observations', job: 'Chart scheduling lateness and choose an alert threshold; no physical sensor.' },
  { id: 'appliance-remote', title: 'Software lamp remote', producer: 'Actual control events and authored software lamp state', job: 'Request lamp state, see handler acknowledgment and separate model observations; no appliance.' },
  { id: 'media-sharing', title: 'Application media sharing', producer: 'Owned canvas and native decoded application video', job: 'Share a changing application drawing with one separately approved local output; no camera.' },
  { id: 'collaborative-controls', title: 'Local collaborative controls', producer: 'Two actual local browser control surfaces', job: 'Hold independent partitions and explicitly review a requested transfer; no remote people or authentication.' },
] as const);
export type ReferenceApplicationId = typeof REFERENCE_APPLICATIONS[number]['id'];
type Profile = 'pointer' | 'sensor' | 'appliance';
type Result = Readonly<{ ok: true }> | Readonly<{ ok: false; reason: string }>;
interface OwnedWork { epoch: number; expiresAt: number; signal: AbortController; handles: Set<EndpointHandle>; routes: Connection[] }
const failure = (reason: string): Result => ({ ok: false, reason });
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const aborted = (signal: AbortSignal) => Reflect.apply(signalAborted, signal, []) as boolean;
const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;

function resources(profile: Profile): DeviceCapability[] {
  const cap = (id: string, value: ValueSchema, reliable = false): DeviceCapability => ({ id, semantic: 'reference:' + id, schemaVersion: 1, kind: reliable ? 'event' : 'sample', value,
    delivery: reliable ? { mode: 'reliable', maxAgeMs: 500 } : { mode: 'latest', maxHz: profile === 'pointer' ? 30 : 5, maxAgeMs: 500 }, permissions: ['subscribe'] });
  if (profile === 'pointer') return [cap('position', { type: 'vector', unit: '1', frame: 'application-normalized', components: ['x', 'y'], min: 0, max: 1 }), cap('contact', { type: 'boolean' }, true)];
  if (profile === 'sensor') return [cap('lateness', { type: 'scalar', unit: 'ms', min: 0, max: 10000 })];
  return [cap('command', { type: 'boolean' }, true), cap('observed', { type: 'boolean' })];
}
function description(id: string, profile: Profile, sink: boolean): DeviceDescriptor {
  return parseDeviceDescriptor({ schemaVersion: 1, id, label: 'Reference application ' + profile, revision: 1,
    adapter: { id: 'reference:' + profile, version: '1.0.0' }, runtime: { platform: 'owned-browser-software' },
    capabilities: resources(profile).map(cap => sink ? { ...cap, kind: cap.id === 'command' ? 'command' : 'property', permissions: [cap.id === 'command' ? 'invoke' : 'write'], ownership: { mode: 'exclusive' } } : cap) });
}

/** Small reference host policy: two local approvals, exact resource routes, fixed
 * 30s authority, bounded queues. Native/UI factories remain cooperative host code.
 * Cancelled async handlers retain their raw reservation until their promise settles. */
export function createReferenceSession(options: { profile: Profile; ownerSignal: AbortSignal; now: () => number;
  apply(id: string, observation: Observation, context: DeliveryContext): void | Promise<void>; release?(id: string): void }) {
  aborted(options.ownerSignal);
  if (!['pointer', 'sensor', 'appliance'].includes(options.profile) || typeof options.now !== 'function' || typeof options.apply !== 'function') throw new TypeError('Invalid reference session');
  const profile = options.profile, owner = options.ownerSignal, now = options.now;
  let closed = false, tearing = false, epoch = 0, work: OwnedWork | undefined, lastAt = -1, starts = 0, publications = 0, rawPending = 0, sequence = 0;
  let sourceApproved = false, sinkApproved = false, reason = 'idle', timer: ReturnType<typeof setTimeout> | undefined;
  const latest = new Map<string, Observation>(), sources = new Map<string, EndpointHandle>(), tasks = new Set<Promise<void>>();
  const sourceDevice = description('reference-' + profile + ':source', profile, false), sinkDevice = description('reference-' + profile + ':sink', profile, true);
  const applicationId = 'reference-' + profile, sessionId = 'owned-local-session', principalId = 'selected-local-owner';
  function cleanup(old: OwnedWork): void {
    old.signal.abort(); for (const route of old.routes.splice(0)) route.stop('reference-retired');
    for (const handle of [...old.handles]) { old.handles.delete(handle); runtime.unregister(handle); }
  }
  function stop(why = 'stopped'): void {
    epoch++; const old = work; work = undefined; sourceApproved = false; sinkApproved = false; reason = why; latest.clear(); sources.clear();
    if (timer !== undefined) clearTimeout(timer); timer = undefined;
    if (tearing) return; tearing = true; try { if (old) cleanup(old); } finally { tearing = false; }
  }
  function clock(): number { let at: number;
    try { at = now(); } catch { stop('invalid-clock'); return NaN; }
    if (!Number.isFinite(at) || at < 0 || at > Number.MAX_SAFE_INTEGER - 30000 || at < lastAt) { stop('invalid-clock'); return NaN; } lastAt = at; return at;
  }
  function current(old: OwnedWork): boolean {
    if (closed || tearing || work !== old || epoch !== old.epoch || aborted(owner) || old.signal.signal.aborted || !sourceApproved || !sinkApproved) return false;
    const at = clock(); return work === old && epoch === old.epoch && !aborted(owner) && !old.signal.signal.aborted && sourceApproved && sinkApproved && Number.isFinite(at) && at < old.expiresAt;
  }
  const runtime = createDeviceRuntime({ now: clock, clockDomain: 'reference-browser-' + profile, maxRoutes: 2, maxSubscribers: 2, maxRegistrations: 4, maxPendingDeliveries: 1,
    authorize(request) {
      const old = work; if (!old || !current(old) || request.principalId !== principalId || request.applicationId !== applicationId || request.sessionId !== sessionId || request.sourceOperation !== 'subscribe') return;
      const cap = sourceDevice.capabilities.find(cap => cap.id === request.source.capabilityId);
      if (!cap || request.sink.capabilityId !== cap.id || request.source.deviceId !== sourceDevice.id || request.sink.deviceId !== sinkDevice.id || request.source.registrationId !== sources.get(cap.id)?.id ||
          !old.handles.has([...old.handles].find(handle => handle.id === request.sink.registrationId)!) || request.sinkOperation !== (cap.id === 'command' ? 'invoke' : 'write')) return;
      return { expiresAt: old.expiresAt, maxAgeMs: cap.delivery.maxAgeMs, maxHz: cap.delivery.mode === 'latest' ? cap.delivery.maxHz : 5 };
    } });
  function start(): Result {
    if (closed || aborted(owner)) return failure('closed'); if (work || tearing || rawPending) return failure('busy'); if (!sourceApproved || !sinkApproved) return failure('denied'); if (starts >= 16) return failure('quota'); starts++;
    const old: OwnedWork = { epoch: ++epoch, expiresAt: Infinity, signal: new AbortController(), handles: new Set(), routes: [] }; work = old;
    const at = clock(); if (work !== old || epoch !== old.epoch || !Number.isFinite(at)) return failure('cancelled'); old.expiresAt = at + 30000;
    try {
      for (const cap of sourceDevice.capabilities) {
        const source = runtime.registerSource({ device: sourceDevice, capability: cap.id }); old.handles.add(source); sources.set(cap.id, source); if (!current(old)) throw Error('cancelled');
        const sink = runtime.registerSink({ device: sinkDevice, capability: cap.id, apply(observation, context) {
          if (!current(old) || context.signal.aborted || !context.isCurrent()) return;
          latest.set(cap.id, observation); rawPending++;
          let result: void | Promise<void>; try { result = options.apply(cap.id, observation, context); } catch (error) { rawPending--; throw error; }
          if (result && typeof result.then === 'function') {
            const task = Promise.resolve(result).finally(() => { rawPending--; tasks.delete(task); }); tasks.add(task); return task;
          } rawPending--;
        }, release() { latest.delete(cap.id); try { options.release?.(cap.id); } catch { /* Remaining routes still retire. */ } } });
        old.handles.add(sink); if (!current(old)) throw Error('cancelled'); runtime.setReadiness(source, 'available', old.expiresAt); runtime.setReadiness(sink, 'available', old.expiresAt); if (!current(old)) throw Error('cancelled');
        const route = runtime.route({ from: source, to: sink, principalId, applicationId, sessionId, leaseMs: 30000, queueCapacity: 1 }); old.routes.push(route);
        if (!route.start().ok || !current(old)) throw Error('unavailable');
      }
      reason = 'active'; timer = setTimeout(() => { if (work === old) stop('expired'); }, 30000); return { ok: true };
    } catch { if (work === old) stop('unavailable'); cleanup(old); return failure('unavailable'); }
  }
  const ownerAbort = () => stop('owner-revoked'); Reflect.apply(add, owner, ['abort', ownerAbort, { once: true }]);
  return Object.freeze({ start, stop,
    approve(role: 'source' | 'sink', allow: boolean) { if (closed || aborted(owner) || !['source', 'sink'].includes(role) || typeof allow !== 'boolean') return;
      if (!allow && work) { stop('revoked'); return; } if (role === 'source') sourceApproved = allow; else sinkApproved = allow; },
    publish(id: string, value: unknown): Result {
      const old = work, cap = sourceDevice.capabilities.find(cap => cap.id === id), source = sources.get(id); if (!old || !cap || !source || !current(old)) return failure('denied');
      if (++publications > 1200) { stop('quota'); return failure('quota'); } const at = clock(); if (!current(old)) return failure('cancelled');
      return runtime.publish(source, value, { timestamp: at, clockDomain: runtime.clockDomain, sequence: ++sequence,
        provenance: { producer: profile === 'sensor' ? 'owned-browser-timer-observation' : profile === 'appliance' ? 'authored-software-lamp' : 'owned-application-input', physicalDevice: false },
        ...(cap.delivery.mode === 'reliable' ? { operationId: String(sequence), deadline: Math.min(old.expiresAt, at + cap.delivery.maxAgeMs) } : {}) });
    }, tick() { const old = work; if (old && !current(old)) { if (work === old) stop('expired'); return; } if (old) runtime.flush(); },
    snapshot() { return Object.freeze({ active: !!work && current(work), reason, epoch, sourceApproved, sinkApproved, starts, rawPending,
      latest: Object.freeze(Object.fromEntries(latest)), operations: Object.freeze(work?.routes.flatMap(route => route.operations()) ?? []), expiryArmed: timer !== undefined }); },
    async close() { if (!closed) { closed = true; stop('closed'); Reflect.apply(remove, owner, ['abort', ownerAbort]); runtime.close(); } while (tasks.size) await Promise.allSettled([...tasks]); } });
}

const CSS = `*{box-sizing:border-box}body{margin:0;background:#fff;color:#111;font:16px/1.5 system-ui}main{max-width:920px;margin:auto;padding:24px}button,input,select{font:inherit;accent-color:#111}button,input[type=range],select{min-height:44px}button{padding:8px 16px;border:1px solid #111;background:#fff;color:#111;cursor:pointer}button:disabled{color:#666;border-style:dashed;cursor:default}button:hover:not(:disabled){background:#eee}:focus-visible{outline:3px solid #111;outline-offset:3px}label{display:flex;gap:12px;align-items:center;margin:12px 0}input[type=checkbox]{width:24px;height:24px}.row{display:flex;flex-wrap:wrap;gap:12px}.panel{border:1px solid #777;padding:16px;margin-top:16px;min-width:0}canvas{max-width:100%;border:1px solid #777}output{display:block;min-height:24px;overflow-wrap:anywhere}.pad{min-height:160px;border:2px solid #111;padding:16px;touch-action:none}.lamp{width:80px;height:80px;border:2px solid #111;border-radius:50%;background:#fff}.lamp[data-on=true]{background:#111}.participant{flex:1;min-width:220px}h1,h2{line-height:1.25}a{color:inherit}@media(max-width:520px){main{padding:16px}.row>*{flex:1}}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}`;
function node<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, text = ''): HTMLElementTagNameMap[K] { const value = doc.createElement(tag); value.textContent = text; return value; }
interface JobContext { doc: Document; window: Window & typeof globalThis; panel: HTMLElement; signal: AbortSignal; now(): number; current(): boolean; unavailable(): void; expiresAt: number; own(cleanup: () => void | Promise<void>): void }
interface Job { tick(): void; close(): Promise<void>; state(): unknown; ready?: Promise<boolean> }
function subscriptions(context: JobContext) {
  const cleanups: (() => void)[] = [];
  const result = { on(target: EventTarget, name: string, callback: (event: Event) => void) {
    const guarded = (event: Event) => { if (context.current() && !context.signal.aborted) callback(event); };
    const dispose = () => target.removeEventListener(name, guarded); cleanups.push(dispose); try { target.addEventListener(name, guarded); } finally { if (!context.current()) dispose(); }
  }, close() { for (const dispose of cleanups.splice(0)) dispose(); }, count: () => cleanups.length }; context.own(() => result.close()); return result;
}
function approvedSession(context: JobContext, profile: Profile, apply: Parameters<typeof createReferenceSession>[0]['apply'], release?: (id: string) => void) {
  const session = createReferenceSession({ profile, ownerSignal: context.signal, now: context.now, apply, release });
  context.own(() => session.close());
  session.approve('source', true); session.approve('sink', true); if (!context.current() || !session.start().ok) { void session.close(); throw Error('Current source and destination approval required'); } return session;
}
function pointerJob(context: JobContext): Job {
  const { doc, panel } = context, handlers = subscriptions(context), pad = node(doc, 'div', 'Drag here. Arrow keys move the application cursor; hold Space for contact.'), canvas = node(doc, 'canvas');
  pad.className = 'pad'; pad.tabIndex = 0; pad.setAttribute('role', 'group'); pad.setAttribute('aria-label', 'Application pointer pad'); canvas.width = 400; canvas.height = 200; canvas.setAttribute('aria-label', 'Application cursor output'); panel.append(pad, canvas);
  const paint = canvas.getContext('2d'); if (!paint) throw Error('Application surface unavailable'); let position = { x: 0.5, y: 0.5 }, contact = false;
  const draw = () => { paint.clearRect(0, 0, 400, 200); paint.fillStyle = '#111'; paint.beginPath(); paint.arc(position.x * 400, position.y * 200, contact ? 12 : 6, 0, Math.PI * 2); paint.fill(); canvas.dataset.contact = String(contact); canvas.dataset.x = String(position.x); };
  const session = approvedSession(context, 'pointer', (id, observation, current) => { if (!context.current() || current.signal.aborted || !current.isCurrent()) return;
    if (id === 'position') position = observation.value as typeof position; else contact = observation.value === true; draw(); }, () => { contact = false; paint.clearRect(0, 0, 400, 200); canvas.dataset.contact = 'false'; });
  const driver = new PointerSourceDriver({ now: context.now, sampleHz: 30, publish(id, value) { return context.current() && session.publish(id, value).ok; } });
  let pointerId: number | undefined, keyboardContact = false, deliveryTimer: number | undefined, closed = false;
  const stopDelivery = () => { if (deliveryTimer !== undefined) context.window.clearTimeout(deliveryTimer); deliveryTimer = undefined; };
  const stopPointer = () => { const previous = pointerId; pointerId = undefined; keyboardContact = false; driver.stop(); if (previous !== undefined && pad.hasPointerCapture(previous)) pad.releasePointerCapture(previous); };
  context.own(() => { closed = true; stopDelivery(); stopPointer(); canvas.width = 1; canvas.height = 1; });
  handlers.on(pad, 'pointerdown', event => { const e = event as PointerEvent, box = pad.getBoundingClientRect(); if (e.isPrimary && pointerId === undefined) { pointerId = e.pointerId; driver.begin(e.pointerId, e.clientX, e.clientY, box.width, box.height); pad.setPointerCapture(e.pointerId); } });
  handlers.on(pad, 'pointermove', event => { const e = event as PointerEvent, box = pad.getBoundingClientRect(); driver.move(e.pointerId, e.clientX, e.clientY, box.width, box.height); });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handlers.on(pad, type, event => { if ((event as PointerEvent).pointerId !== pointerId) return; pointerId = undefined; driver.end((event as PointerEvent).pointerId); if (keyboardContact) driver.setContact(true); });
  handlers.on(pad, 'keydown', event => { const e = event as KeyboardEvent, deltas: Record<string, [number, number]> = { ArrowLeft: [-0.05, 0], ArrowRight: [0.05, 0], ArrowUp: [0, -0.05], ArrowDown: [0, 0.05] }; if (deltas[e.key]) { e.preventDefault(); driver.nudge(...deltas[e.key]!); } else if (e.code === 'Space') { e.preventDefault(); keyboardContact = true; driver.setContact(true); } });
  const releaseKeyboard = () => { keyboardContact = false; driver.setContact(pointerId !== undefined); };
  handlers.on(pad, 'keyup', event => { if ((event as KeyboardEvent).code === 'Space') releaseKeyboard(); }); handlers.on(pad, 'blur', releaseKeyboard); draw();
  // Reliable contact and pointer samples share the same bounded runtime even
  // when drawing pauses; presentation frames must not be their only progress source.
  function scheduleDelivery() { deliveryTimer = context.window.setTimeout(() => { deliveryTimer = undefined;
    if (closed || !context.current()) { stopPointer(); void session.close(); return; }
    driver.tick(); session.tick();
    if (!closed && context.current()) scheduleDelivery(); else { stopPointer(); void session.close(); }
  }, Math.ceil(1000 / 30)); } scheduleDelivery();
  return { tick() {}, state: () => ({ ...session.snapshot(), contact, position, listeners: handlers.count(), deliveryTimerArmed: deliveryTimer !== undefined }), async close() { closed = true; stopDelivery(); handlers.close(); stopPointer(); await session.close(); canvas.width = 1; canvas.height = 1; } };
}
function sensorJob(context: JobContext): Job {
  const { doc, panel } = context, handlers = subscriptions(context), label = node(doc, 'label', 'Alert when lateness exceeds '), threshold = node(doc, 'input'), output = node(doc, 'output', 'Waiting for an actual timer observation'), canvas = node(doc, 'canvas');
  threshold.type = 'range'; threshold.min = '0'; threshold.max = '100'; threshold.step = '1'; threshold.value = '20'; label.append(threshold); output.setAttribute('aria-live', 'polite'); canvas.width = 400; canvas.height = 160; canvas.setAttribute('aria-label', 'Latest 32 browser timer lateness observations'); panel.append(label, output, canvas);
  const paint = canvas.getContext('2d'); if (!paint) throw Error('Chart unavailable'); const rows: number[] = []; let boundary = 20, samples = 0, timer: number | undefined, stopped = false;
  context.own(() => { stopped = true; if (timer !== undefined) context.window.clearTimeout(timer); timer = undefined; canvas.width = 1; canvas.height = 1; });
  const session = approvedSession(context, 'sensor', (_id, observed, current) => { if (!context.current() || current.signal.aborted || !current.isCurrent()) return; const value = observed.value as number; rows.push(value); if (rows.length > 32) rows.shift(); samples++;
    output.value = value.toFixed(2) + ' ms scheduling lateness — ' + (value > boundary ? 'above threshold' : 'within threshold'); output.dataset.samples = String(samples); paint.clearRect(0, 0, 400, 160); paint.strokeStyle = '#111'; paint.beginPath(); rows.forEach((value, index) => { const x = index / 31 * 400, y = 155 - Math.min(150, value * 2); if (!index) paint.moveTo(x, y); else paint.lineTo(x, y); }); paint.stroke(); }, () => { rows.length = 0; output.value = 'Observation stopped'; });
  handlers.on(threshold, 'input', () => { boundary = threshold.valueAsNumber; });
  function schedule() { const expected = context.now() + 200; timer = context.window.setTimeout(() => { timer = undefined; if (stopped || !context.current() || context.signal.aborted) return;
    const at = context.now(); if (!context.current()) return; session.publish('lateness', Math.min(10000, Math.max(0, at - expected))); session.tick(); if (samples < 150 && context.current()) schedule(); }, 200); } schedule();
  return { tick: () => session.tick(), state: () => ({ ...session.snapshot(), samples, retainedRows: rows.length, timer: timer !== undefined, producer: 'actual-browser-timer-lateness' }), async close() { stopped = true; if (timer !== undefined) context.window.clearTimeout(timer); timer = undefined; handlers.close(); await session.close(); canvas.width = 1; canvas.height = 1; } };
}
function applianceJob(context: JobContext): Job {
  const { doc, panel } = context, handlers = subscriptions(context), button = node(doc, 'button', 'Request lamp on'), lamp = node(doc, 'div'), ack = node(doc, 'output', 'No command acknowledged'), observed = node(doc, 'output', 'No model state observed'); button.type = 'button'; lamp.className = 'lamp'; lamp.setAttribute('aria-label', 'Software lamp preview'); panel.append(button, ack, observed, lamp);
  let modelOn = false, requested = false, observations = 0, commands = 0, stopped = false, timer: number | undefined;
  context.own(() => { stopped = true; if (timer !== undefined) context.window.clearTimeout(timer); timer = undefined; modelOn = false; lamp.dataset.on = 'false'; });
  const session = approvedSession(context, 'appliance', (id, value, current) => { if (!context.current() || current.signal.aborted || !current.isCurrent()) return;
    if (id === 'command') { modelOn = value.value === true; commands++; current.reportEvidence('target-acknowledged'); ack.value = 'Software handler acknowledged request ' + commands; }
    else { observations++; lamp.dataset.on = String(value.value === true); observed.value = 'Separately observed software lamp: ' + (value.value ? 'on' : 'off'); observed.dataset.observations = String(observations); } }, () => { modelOn = false; lamp.dataset.on = 'false'; observed.value = 'Software lamp authority released'; });
  handlers.on(button, 'click', () => { requested = !requested; session.publish('command', requested); session.tick(); button.textContent = requested ? 'Request lamp off' : 'Request lamp on'; });
  function schedule() { timer = context.window.setTimeout(() => { timer = undefined; if (stopped || !context.current()) return; session.publish('observed', modelOn); session.tick(); if (observations < 150) schedule(); }, 200); } schedule();
  return { tick: () => session.tick(), state: () => ({ ...session.snapshot(), modelOn, observations, commands, timer: timer !== undefined, physicalAppliance: false }), async close() { stopped = true; if (timer !== undefined) context.window.clearTimeout(timer); timer = undefined; handlers.close(); await session.close(); modelOn = false; lamp.dataset.on = 'false'; } };
}
function mediaJob(context: JobContext): Job {
  const { doc, panel } = context, handlers = subscriptions(context), sourceCanvas = node(doc, 'canvas'), destination = node(doc, 'div'), change = node(doc, 'button', 'Change drawing'), status = node(doc, 'output', 'Preparing separately approved application media'); sourceCanvas.width = 64; sourceCanvas.height = 48; sourceCanvas.setAttribute('aria-label', 'Owned application drawing'); destination.className = 'panel'; change.type = 'button'; panel.append(sourceCanvas, change, status, destination);
  const paint = sourceCanvas.getContext('2d'); if (!paint) throw Error('Owned drawing unavailable'); let blue = false, timer: number | undefined, draws = 0, closed = false;
  const draw = () => { paint.fillStyle = blue ? '#0000ff' : '#ff0000'; paint.fillRect(0, 0, 64, 48); draws++; }; draw();
  const approve: Parameters<typeof createBrowserApplicationMedia>[0]['authorizeSource'] = request => {
    if (!context.current() || context.signal.aborted || request.applicationId !== 'reference-media-sharing' || request.sessionId !== 'owned-local-session' || request.sourceId !== 'media:reference-drawing' || request.outputId !== 'media:reference-view' || request.sourceOwnerPrincipalId !== 'local-drawing-owner' || request.sinkOwnerPrincipalId !== 'local-view-owner' || request.recipientPrincipalId !== 'local-view-owner' || request.ownerPrincipalId !== (request.role === 'source' ? 'local-drawing-owner' : 'local-view-owner')) return;
    return { request, grant: { expiresAt: context.expiresAt, maxHz: 10, maxAgeMs: 250 } };
  };
  const media = createBrowserApplicationMedia({ applicationId: 'reference-media-sharing', sessionId: 'owned-local-session', clockDomain: 'application-decoded-receipt', now: context.now, authorizeSource: approve, authorizeSink: approve });
  context.own(async () => { closed = true; if (timer !== undefined) context.window.clearTimeout(timer); timer = undefined; media.close(); while (media.status().pending) await new Promise(resolve => context.window.setTimeout(resolve, 10)); sourceCanvas.width = 1; sourceCanvas.height = 1; });
  const source = media.registerSource({ sourceId: 'media:reference-drawing', ownerPrincipalId: 'local-drawing-owner', canvas: sourceCanvas, maxHz: 10 });
  let binding: BrowserApplicationMediaBinding | undefined;
  if (source && context.current()) binding = media.bind({ source, outputId: 'media:reference-view', ownerPrincipalId: 'local-view-owner', container: destination, label: 'Approved local application drawing', signal: context.signal });
  const ready = binding?.ready ?? Promise.resolve(false); void ready.then(value => { if (context.current()) status.value = value ? 'Application drawing shared with this approved local view' : 'Application media unavailable: ' + (binding?.status().reason ?? 'unsupported'); });
  handlers.on(change, 'click', () => { blue = !blue; draw(); });
  function schedule() { timer = context.window.setTimeout(() => { timer = undefined; if (closed || !context.current()) return; draw(); if (draws < 300) schedule(); }, 100); } schedule();
  return { ready, tick() {}, state: () => ({ ...media.status(), binding: binding?.status(), draws, blue, timer: timer !== undefined, physicalCamera: false }), async close() { closed = true; if (timer !== undefined) context.window.clearTimeout(timer); timer = undefined; handlers.close(); binding?.stop(); media.close(); await ready;
    while (media.status().pending) await new Promise(resolve => context.window.setTimeout(resolve, 10)); sourceCanvas.width = 1; sourceCanvas.height = 1; } };
}
function collaborativeJob(context: JobContext): Job {
  const contactHz = 30; let deliveryTimer: number | undefined;
  const stopDelivery = () => { if (deliveryTimer !== undefined) context.window.clearTimeout(deliveryTimer); deliveryTimer = undefined; };
  const { doc, panel } = context, handlers = subscriptions(context), values = new Map<string, { route: string; value: Observation['value'] }>(); let closed = false;
  const runtime = createDeviceRuntime({ now: context.now, clockDomain: 'reference-local-controls', maxPendingDeliveries: 2, authorize(request) {
    if (closed || !context.current() || !controller?.isApproved(request)) return; return { expiresAt: context.expiresAt, maxAgeMs: 100, maxHz: contactHz }; } });
  context.own(() => { closed = true; stopDelivery(); runtime.close(); });
  const output = node(doc, 'output', 'No local partition owner'), canvas = node(doc, 'canvas'); canvas.width = 400; canvas.height = 160; panel.append(output, canvas); const paint = canvas.getContext('2d'); if (!paint) { runtime.close(); throw Error('Collaborative output unavailable'); }
  function draw() { paint!.clearRect(0, 0, 400, 160); for (const [index, id] of ['left', 'right'].entries()) { const position = values.get(id + ':position')?.value as { x: number; y: number } | undefined, held = values.get(id + ':contact')?.value === true;
    if (position) { paint!.fillStyle = '#111'; paint!.beginPath(); paint!.arc(index * 200 + position.x * 190 + 5, position.y * 150 + 5, held ? 12 : 6, 0, Math.PI * 2); paint!.fill(); } canvas.dataset[id + 'Held'] = String(held); } }
  const base = pointerSourceDescriptor('owned-local-browser-controls'), sinkDevice = parseDeviceDescriptor({ ...base, id: 'reference-partition-output', capabilities: base.capabilities.map(cap => ({ ...cap, kind: 'property', permissions: ['write'], ownership: { mode: 'partitioned', partitions: ['left', 'right'] } })) });
  const sinks = sinkDevice.capabilities.map(cap => { const handle = runtime.registerSink({ device: sinkDevice, capability: cap.id, apply(observation, current) {
    if (!context.current() || current.signal.aborted || !current.isCurrent()) return; values.set(current.partition + ':' + cap.id, { route: current.routeId, value: observation.value }); draw(); }, release(_reason, current) {
    const key = current.partition + ':' + cap.id; if (values.get(key)?.route === current.routeId) values.delete(key); draw(); } }); runtime.setReadiness(handle, 'available'); return { handle, device: sinkDevice, capability: cap.id }; });
  const sources = ['alpha', 'beta'].map((id, index) => {
    const device = parseDeviceDescriptor({ ...base, id: 'reference-' + id + '-controls' }), resources = device.capabilities.map(cap => { const handle = runtime.registerSource({ device, capability: cap.id }); runtime.setReadiness(handle, 'available'); return { handle, device, capability: cap.id }; }); let sequence = 0;
    const driver = new PointerSourceDriver({ now: context.now, sampleHz: contactHz, publish(capability, value, metadata) { if (!context.current()) return false; const cap = device.capabilities.find(value => value.id === capability)!, source = resources.find(value => value.capability === capability)!;
      const result = runtime.publish(source.handle, value, { timestamp: metadata.capturedAt, clockDomain: runtime.clockDomain, sequence: ++sequence, ...(cap.delivery.mode === 'reliable' ? { operationId: String(sequence), deadline: metadata.capturedAt + cap.delivery.maxAgeMs } : {}) });
      // A lost reliable edge cannot be recovered by replaying an expired capture.
      // No-route before selection remains inert; active queue refusal retires the job.
      if (cap.delivery.mode === 'reliable' && (result.ok ? result.value.rejected > 0 : result.reason === 'capacity')) context.unavailable();
      return result.ok && context.current(); } });
    const box = node(doc, 'section'), title = node(doc, 'h2', 'Local control ' + (index + 1)), sliderLabel = node(doc, 'label', 'Horizontal position'), slider = node(doc, 'input'), hold = node(doc, 'button', 'Hold contact'), request = node(doc, 'button', 'Request ' + (index ? 'right' : 'left') + ' partition'); box.className = 'participant'; slider.type = 'range'; slider.min = '0'; slider.max = '1'; slider.step = '0.05'; slider.value = '0.5'; sliderLabel.append(slider); hold.type = request.type = 'button'; box.append(title, sliderLabel, hold, request); panel.append(box);
    let previous = 0.5, pointerId: number | undefined, keyboardContact = false;
    handlers.on(slider, 'input', () => { const next = slider.valueAsNumber; driver.nudge(next - previous, 0); previous = next; });
    handlers.on(hold, 'pointerdown', event => { const e = event as PointerEvent; if (pointerId !== undefined || !Number.isSafeInteger(e.pointerId) || e.pointerId < 0) return; pointerId = e.pointerId; driver.setContact(true);
      // Software DOM controls are an explicit test seam; only an actual native
      // press can establish capture in the browser's active pointer inventory.
      if (e.isTrusted) hold.setPointerCapture(e.pointerId); });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handlers.on(hold, type, event => { if ((event as PointerEvent).pointerId !== pointerId) return; pointerId = undefined; driver.setContact(keyboardContact); });
    handlers.on(hold, 'keydown', event => { if ((event as KeyboardEvent).code === 'Space') { event.preventDefault(); keyboardContact = true; driver.setContact(true); } });
    const releaseKeyboard = () => { keyboardContact = false; driver.setContact(pointerId !== undefined); };
    handlers.on(hold, 'keyup', event => { if ((event as KeyboardEvent).code === 'Space') releaseKeyboard(); }); handlers.on(hold, 'blur', releaseKeyboard);
    const release = () => { const previous = pointerId; pointerId = undefined; keyboardContact = false; driver.release(); if (previous !== undefined && hold.hasPointerCapture(previous)) hold.releasePointerCapture(previous); };
    handlers.on(request, 'click', () => { const result = controller!.request(id, index ? 'right' : 'left'); output.value = result.ok ? 'Review the pending request, then approve or decline.' : 'Request could not be made.'; });
    return { id, label: 'Local controls ' + (index + 1), principalId: 'local-control-' + id, resources, driver, release };
  });
  const controller: InputOwnershipController = createInputOwnershipController({ runtime, applicationId: 'reference-collaborative-controls', sessionId: 'owned-local-session', sources, destination: { label: 'Two application partitions', resources: sinks }, now: context.now });
  context.own(() => { sources.forEach(source => { source.release(); source.driver.stop(); }); controller.close(); values.clear(); canvas.width = 1; canvas.height = 1; });
  const approve = node(doc, 'button', 'Approve pending request'), decline = node(doc, 'button', 'Decline pending request'), cancel = node(doc, 'button', 'Cancel pending request'), transfer = node(doc, 'button', 'Request control 2 for left partition'); for (const button of [approve, decline, cancel, transfer]) button.type = 'button'; panel.append(approve, decline, cancel, transfer);
  const pending = () => controller!.snapshot().slots.find(slot => slot.request)?.request;
  handlers.on(approve, 'click', () => { const request = pending(); if (request) controller!.decide(request.id, request.expectedOwnerEpoch, true); });
  handlers.on(decline, 'click', () => { const request = pending(); if (request) controller!.decide(request.id, request.expectedOwnerEpoch, false); });
  handlers.on(cancel, 'click', () => { const request = pending(); if (request) controller!.cancel(request.id); }); handlers.on(transfer, 'click', () => controller!.request('beta', 'left'));
  let previousOwners = new Set<string>();
  const unsubscribe = controller.subscribe(() => { if (!context.current()) return; const snapshot = controller!.snapshot(), currentOwners = new Set(snapshot.slots.flatMap(slot => slot.owner ? [slot.owner.sourceId] : []));
    for (const source of sources) if (previousOwners.has(source.id) !== currentOwners.has(source.id)) source.release(); previousOwners = currentOwners;
    output.value = snapshot.slots.map(slot => slot.id + ': ' + (slot.owner?.sourceId ?? 'unowned') + (slot.request ? ' (request pending)' : '')).join('; '); });
  // Input delivery must keep progressing through bounded fair queue turns even
  // when presentation frames pause. The existing route grants still limit delivery.
  function scheduleDelivery() { deliveryTimer = context.window.setTimeout(() => { deliveryTimer = undefined;
    if (closed || !context.current()) { runtime.close(); return; }
    controller.tick(); sources.forEach(source => source.driver.tick()); runtime.flush();
    if (!closed && context.current()) scheduleDelivery(); else runtime.close();
  // Four routes share two pending slots. Service two queue turns per route
  // period so an older heartbeat cannot consume a release's entire value age.
  }, Math.ceil(1000 / (contactHz * 2))); } scheduleDelivery();
  return { tick() {}, state: () => ({ ownership: controller!.snapshot(), held: Object.fromEntries(['left', 'right'].map(id => [id, values.get(id + ':contact')?.value === true])), listeners: handlers.count(), deliveryTimerArmed: deliveryTimer !== undefined }), async close() { closed = true; stopDelivery(); handlers.close(); unsubscribe(); sources.forEach(source => { source.release(); source.driver.stop(); }); controller!.close(); runtime.close(); values.clear(); draw(); canvas.width = 1; canvas.height = 1; } };
}

/** Mount one standalone app. No execution, acquisition or grants occur until both
 * local owners approve and Start is activated. All effects are application-owned. */
export function mountReferenceApplication(container: HTMLElement, id: ReferenceApplicationId) {
  const manifest = REFERENCE_APPLICATIONS.find(app => app.id === id), doc = container.ownerDocument, window = doc.defaultView as (Window & typeof globalThis) | null;
  if (!manifest || !window) throw new TypeError('Unknown reference application');
  const root = node(doc, 'main'), css = node(doc, 'style', CSS), title = node(doc, 'h1', manifest.title), description = node(doc, 'p', manifest.job), boundary = node(doc, 'p', manifest.producer), sourceLabel = node(doc, 'label', 'Approve this selected source'), sinkLabel = node(doc, 'label', 'Approve this application destination'), source = node(doc, 'input'), sink = node(doc, 'input');
  source.type = sink.type = 'checkbox'; sourceLabel.append(source); sinkLabel.append(sink); const row = node(doc, 'div'), start = node(doc, 'button', 'Start'), decline = node(doc, 'button', 'Decline'), stop = node(doc, 'button', 'Stop'), state = node(doc, 'output', 'Stopped. Review both approvals to begin.'), panel = node(doc, 'section'); row.className = 'row'; panel.className = 'panel'; state.setAttribute('role', 'status'); state.setAttribute('aria-live', 'polite'); start.type = decline.type = stop.type = 'button'; row.append(start, decline, stop); root.append(css, title, description, boundary, sourceLabel, sinkLabel, row, state, panel); container.append(root);
  const factories: Record<ReferenceApplicationId, (context: JobContext) => Job> = { pointer: pointerJob, 'sensor-dashboard': sensorJob, 'appliance-remote': applianceJob, 'media-sharing': mediaJob, 'collaborative-controls': collaborativeJob };
  interface Stage { owner: AbortController; job?: Job; settled: Promise<void>; finish(): void; cleanups: (() => void | Promise<void>)[] }
  const handlers: (() => void)[] = []; let closed = false, revision = 0, attempts = 0, job: Job | undefined, previousJob: Job | undefined, stage: Stage | undefined, owner: AbortController | undefined, retiring: Promise<void> | undefined, frame: number | undefined, timer: number | undefined, lastFrame = -Infinity;
  function listen(target: EventTarget, type: string, callback: () => void) { target.addEventListener(type, callback); handlers.push(() => target.removeEventListener(type, callback)); }
  function paint() { start.disabled = closed || !!stage || !!retiring || !source.checked || !sink.checked || attempts >= 16; stop.disabled = closed || !stage; }
  function retire(reason: string): Promise<void> {
    revision++; const old = stage; stage = undefined; owner = undefined; job = undefined;
    if (old) { const done = Promise.resolve().then(async () => { await old.settled; if (old.job) { previousJob = old.job; await old.job.close(); } else for (const cleanup of old.cleanups.reverse()) await cleanup(); }); retiring = done;
      void done.then(() => { if (retiring === done) retiring = undefined; if (!closed) { panel.replaceChildren(); paint(); } }, () => { state.value = 'Cleanup remains unavailable. Reload this owned app before retry.'; }); old.owner.abort(); }
    if (frame !== undefined) window!.cancelAnimationFrame(frame); frame = undefined; if (timer !== undefined) window!.clearTimeout(timer); timer = undefined; source.checked = sink.checked = false; state.value = reason;
    if (!closed) source.focus(); paint(); return retiring ?? Promise.resolve();
  }
  function startJob() {
    if (closed || stage || retiring || !source.checked || !sink.checked || attempts >= 16 || doc.hidden || !doc.hasFocus()) return; attempts++; const turn = ++revision, signal = new AbortController(); owner = signal; const expiresAt = window!.performance.now() + 30000;
    let finish!: () => void; const ownedStage: Stage = { owner: signal, settled: new Promise(resolve => { finish = resolve; }), finish: () => finish(), cleanups: [] }; stage = ownedStage;
    const current = () => !closed && stage === ownedStage && revision === turn && owner === signal && !signal.signal.aborted && source.checked && sink.checked && !doc.hidden && window!.performance.now() < expiresAt;
    panel.replaceChildren(); const context: JobContext = { doc, window: window!, panel, signal: signal.signal, now: () => window!.performance.now(), current, expiresAt,
      unavailable() { if (current()) void retire('Input could not be delivered. Review both approvals to retry.'); }, own(cleanup) { ownedStage.cleanups.push(cleanup); } };
    try { const created = factories[id](context); ownedStage.job = created; if (!current()) { if (stage === ownedStage) void retire('Cancelled during preparation'); return; } job = created;
      state.value = 'Active for this selected local session. Stop releases authority.'; timer = window!.setTimeout(() => { if (revision === turn) void retire('Session expired. Approve both owners again to retry.'); }, 30000);
      if (created.ready) void created.ready.then(ready => { if (!current()) return; if (ready) state.value = 'Application media active.'; else void retire('This browser cannot currently provide this selected application media. Approve both owners again to retry.'); });
      const tick = (at: number) => { frame = undefined; if (!current()) { if (revision === turn) void retire('Source unavailable. Approve both owners again to retry.'); return; }
        if (at - lastFrame >= 1000 / 30) { lastFrame = at; created.tick(); } if (current()) frame = window!.requestAnimationFrame(tick); };
      frame = window!.requestAnimationFrame(tick); panel.querySelector<HTMLElement>('[tabindex="0"],button,input,select')?.focus(); paint();
    } catch { if (stage === ownedStage) void retire('This selected resource is unavailable. Approve again to retry.'); } finally { ownedStage.finish(); paint(); }
  }
  listen(start, 'click', startJob); listen(decline, 'click', () => { void retire('Declined. Nothing is shared; review both approvals to retry.'); }); listen(stop, 'click', () => { void retire('Stopped. Application authority and held input released.'); });
  for (const checkbox of [source, sink]) listen(checkbox, 'change', () => { if (job && (!source.checked || !sink.checked)) void retire('Revoked. Review both approvals to retry.'); paint(); });
  listen(window, 'blur', () => { if (job) void retire('Focus lost. Review both approvals to retry.'); }); listen(window, 'pagehide', () => { void retire('Page left. Owned application resources released.'); }); listen(doc, 'visibilitychange', () => { if (doc.hidden && job) void retire('Hidden. Review both approvals to retry.'); }); paint();
  return Object.freeze({ state: () => ({ id, active: !!job, retiring: !!retiring, attempts, framePending: frame !== undefined, expiryArmed: timer !== undefined, listeners: handlers.length, sourceApproved: source.checked, sinkApproved: sink.checked, job: job?.state(), lastJob: previousJob?.state() }),
    async close() { if (closed) { await retiring; return; } closed = true; await retire('Closed'); for (const dispose of handlers.splice(0)) dispose(); root.remove(); } });
}
