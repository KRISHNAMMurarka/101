import assert from 'node:assert/strict';
import test from 'node:test';
import type { BrowserChooserEnvironment, BrowserChooserAdapterBinding, BrowserChooserDeclaration, BrowserChooserSelection } from './browser-chooser.ts';
// A missing public feature is an assertion RED, not an accepted skipped test.
const api = await import('./browser-chooser.ts').catch((error: unknown) => {
  if ((error as { code?: string }).code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {} as typeof import('./browser-chooser.ts');
});
function create(options: Parameters<typeof api.createBrowserChooserController>[0]) {
  assert.equal(typeof api.createBrowserChooserController, 'function', 'public chooser controller exists');
  return api.createBrowserChooserController(options);
}
function declaration(id = 'hid', kind: BrowserChooserDeclaration['kind'] = 'hid'): BrowserChooserDeclaration {
  return { id, kind, device: { schemaVersion: 1, id: 'declared-' + id, label: 'Inert declared resource', revision: 1,
    adapter: { id: 'example:chooser', version: '1.0.0' }, runtime: { platform: 'declared-only' },
    capabilities: [{ id: 'reading', semantic: 'example:reading', schemaVersion: 1, kind: 'sample', value: { type: 'scalar', unit: '1', min: 0, max: 100 },
      delivery: { mode: 'latest', maxHz: 20, maxAgeMs: 1000 }, permissions: ['subscribe'] }] }, capabilities: ['reading'],
    selection: kind === 'hid' ? { filters: [{ vendorId: 0x1234, productId: 1 }] } : kind === 'bluetooth' ? { filters: [{ services: [0x180d] }], optionalServices: [0x180d] } :
      kind === 'serial' ? { filters: [{ usbVendorId: 0x1234, usbProductId: 1 }] } : { deviceId: 'explicit-existing-device' } } as BrowserChooserDeclaration;
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(input: { select?: () => Promise<unknown[]>; adapter?: BrowserChooserAdapterBinding; declarations?: BrowserChooserDeclaration[];
  timeoutMs?: number; leaseMs?: number } = {}) {
  let at = 0, allowed = true, calls = 0, clockHook: (() => void) | undefined, activation = () => true;
  const manager = new EventTarget(), device = Object.assign(new EventTarget(), { vendorId: 0x1234, productId: 1, opened: false });
  const requested: unknown[] = [];
  const environment: BrowserChooserEnvironment = { secureContext: () => true, userActivation: () => activation(),
    hid: { requestDevice(options) { calls++; requested.push(options); return input.select ? input.select() : Promise.resolve([device]); },
      addEventListener: manager.addEventListener.bind(manager), removeEventListener: manager.removeEventListener.bind(manager) } };
  const options = { declarations: input.declarations ?? [declaration()], adapters: input.adapter ? [input.adapter] : [],
    scope: { principalId: 'owner', applicationId: 'chooser-example', sessionId: 'test' }, environment,
    now: () => { clockHook?.(); return at; }, requestMs: input.timeoutMs ?? 500, selectionMs: input.leaseMs ?? 1000,
    authorizeCapture(request: Parameters<Parameters<typeof create>[0]['authorizeCapture']>[0]) { return allowed ? { request, expiresAt: Math.min(request.expiresAt, at + 100) } : undefined; } };
  const controller = create(options);
  return { controller, options, environment, manager, device, requested, calls: () => calls, allow(value: boolean) { allowed = value; },
    setActivation(value: () => boolean) { activation = value; }, setTime(value: number) { at = value; }, hook(value?: () => void) { clockHook = value; } };
}
function adapter(start?: BrowserChooserAdapterBinding['capture']) {
  let opens = 0, stops = 0, loss: (() => void) | undefined, detach = 0;
  const binding: BrowserChooserAdapterBinding = { id: 'hid', capture: start ?? (() => {
    opens++; return { stop() { stops++; }, onLoss(callback) { loss = callback; return () => { loss = undefined; detach++; }; } };
  }) };
  return { binding, opens: () => opens, stops: () => stops, detach: () => detach, lose: () => loss?.() };
}
async function choose(h: ReturnType<typeof fixture>): Promise<BrowserChooserSelection> { const result = await h.controller.choose('hid'); assert.ok(result.ok); return result.value; }

test('construction is inert and public options come only from immutable selected declarations', () => {
  const h = fixture(); try {
    assert.equal(h.calls(), 0); assert.equal(h.controller.snapshot().state, 'idle');
    const option = h.controller.snapshot().options[0]!;
    assert.equal(option.id, 'hid'); assert.equal(option.capabilities[0]?.id, 'reading'); assert.equal(option.capabilities[0]?.semantic, 'example:reading');
    assert.equal(Object.isFrozen(option), true); assert.equal(Object.isFrozen(option.selection), true);
    assert.equal(h.controller.snapshot().nativePending, 0);
  } finally { h.controller.close(); }
});
test('native HID selection passes exact declared filters and opens no capture or operation grant', async () => {
  const a = adapter(), h = fixture({ adapter: a.binding });
  try { const choice = await choose(h); assert.equal(h.calls(), 1); assert.deepEqual(h.requested[0], { filters: [{ vendorId: 0x1234, productId: 1 }] });
    assert.equal(a.opens(), 0); assert.equal(h.controller.isCurrent(choice), true); assert.equal(h.controller.snapshot().state, 'selected'); }
  finally { h.controller.close(); }
});
test('capture is separately approved and copied or foreign selections cannot start', async () => {
  const a = adapter(), h = fixture({ adapter: a.binding }), other = fixture();
  try {
    const choice = await choose(h), foreign = await choose(other);
    assert.equal((await h.controller.start({ ...choice })).ok, false); assert.equal((await h.controller.start(foreign)).ok, false); assert.equal(a.opens(), 0);
    h.allow(false); assert.equal((await h.controller.start(choice)).ok, false); assert.equal(a.opens(), 0); assert.equal(h.controller.isCurrent(choice), true);
    h.allow(true); assert.equal((await h.controller.start(choice)).ok, true); assert.equal(a.opens(), 1); assert.equal(h.controller.snapshot().state, 'capturing');
    h.controller.stop(); assert.equal(h.controller.isCurrent(choice), false); assert.equal(a.stops(), 1); assert.equal(a.detach(), 1);
  } finally { h.controller.close(); other.controller.close(); }
});
test('unknown, absent native API and unbound camera/audio remain honest and recoverable', async () => {
  const h = fixture({ declarations: [declaration(), declaration('camera', 'camera'), declaration('audio', 'audio'), declaration('ble', 'bluetooth'), declaration('serial', 'serial')] });
  try {
    assert.deepEqual(await h.controller.choose('unknown'), { ok: false, reason: 'invalid' });
    for (const id of ['camera', 'audio']) assert.deepEqual(await h.controller.choose(id), { ok: false, reason: 'adapter-unbound' });
    for (const id of ['ble', 'serial']) assert.deepEqual(await h.controller.choose(id), { ok: false, reason: 'unsupported' });
    assert.equal((await h.controller.choose('hid')).ok, true); assert.equal(h.calls(), 1);
  } finally { h.controller.close(); }
});
test('empty choice, native cancellation and denial produce fixed messages then allow explicit retry', async () => {
  const values = [Promise.resolve([]), Promise.reject(new DOMException('secret-device-id', 'NotFoundError')),
    Promise.reject(new DOMException('secret-permission', 'NotAllowedError')), Promise.resolve([{}])]; values.forEach(value => value.catch(() => {}));
  const h = fixture({ select: () => values.shift()! });
  try {
    assert.equal((await h.controller.choose('hid')).reason, 'cancelled'); assert.equal((await h.controller.choose('hid')).reason, 'cancelled');
    assert.equal((await h.controller.choose('hid')).reason, 'denied'); assert.equal(JSON.stringify(h.controller.snapshot()).includes('secret'), false);
    assert.equal((await h.controller.choose('hid')).ok, true);
  } finally { h.controller.close(); }
});
test('inert failed or cancelled replacement retains current choice and owned capture', async () => {
  const a = adapter(), task = deferred<unknown[]>(); let count = 0;
  const h = fixture({ adapter: a.binding, select: () => ++count === 1 ? Promise.resolve([{}]) : task.promise });
  try {
    const choice = await choose(h); assert.ok((await h.controller.start(choice)).ok);
    const pending = h.controller.choose('hid'); h.controller.cancel(); task.resolve([]); assert.equal((await pending).ok, false);
    assert.equal(h.controller.isCurrent(choice), true); assert.equal(h.controller.snapshot().state, 'capturing'); assert.equal(a.stops(), 0);
  } finally { h.controller.close(); }
});
test('unsettled native chooser slots survive cancellation, timeout and close; late owned choices retire', async () => {
  const tasks = [deferred<unknown[]>(), deferred<unknown[]>()]; let count = 0;
  const h = fixture({ select: () => tasks[count++]!.promise, timeoutMs: 10 });
  try {
    const one = h.controller.choose('hid'); h.controller.cancel(); assert.equal((await one).ok, false);
    const two = h.controller.choose('hid'); h.setTime(11); h.controller.sweep(); assert.equal((await two).ok, false);
    assert.equal(h.controller.snapshot().nativePending, 2); assert.deepEqual(await h.controller.choose('hid'), { ok: false, reason: 'busy' });
    h.controller.close(); tasks[0]!.resolve([{}]); tasks[1]!.resolve([{}]); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(h.controller.snapshot().nativePending, 0); assert.equal(h.controller.snapshot().state, 'closed');
  } finally { h.controller.close(); }
});
test('late adapter capture after stop is cleaned and cannot attach loss subscription or revive selection', async () => {
  const task = deferred<ReturnType<BrowserChooserAdapterBinding['capture']>>(); let stops = 0, lossSubscriptions = 0;
  const h = fixture({ adapter: { id: 'hid', capture: () => task.promise as never } });
  try {
    const choice = await choose(h), opening = h.controller.start(choice); h.controller.stop(); assert.equal((await opening).ok, false);
    assert.equal(h.controller.snapshot().nativePending, 1);
    task.resolve({ stop() { stops++; }, onLoss() { lossSubscriptions++; return () => {}; } }); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(stops, 1); assert.equal(lossSubscriptions, 0); assert.equal(h.controller.snapshot().nativePending, 0); assert.equal(h.controller.isCurrent(choice), false);
  } finally { h.controller.close(); }
});
test('synchronous adapter loss and subscription callback teardown retire late unsubscribe handles', async () => {
  let stops = 0, removed = 0;
  const h = fixture({ adapter: { id: 'hid', capture: () => ({ stop() { stops++; }, onLoss(callback) { callback(); return () => { removed++; }; } }) } });
  try {
    const choice = await choose(h); assert.equal((await h.controller.start(choice)).ok, false);
    assert.equal(stops, 1); assert.equal(removed, 1); assert.equal(h.controller.isCurrent(choice), false);
  } finally { h.controller.close(); }
});
test('capture grant expires quietly and native disappearance clears current selection', async () => {
  const a = adapter(), h = fixture({ adapter: a.binding });
  try {
    const choice = await choose(h); assert.ok((await h.controller.start(choice)).ok); h.setTime(101);
    await new Promise(resolve => setTimeout(resolve, 120)); assert.equal(a.stops(), 1); assert.equal(h.controller.isCurrent(choice), false);
    assert.equal(h.controller.snapshot().outcome, 'expired');
    h.setTime(102); const next = await choose(h); h.manager.dispatchEvent(Object.assign(new Event('disconnect'), { device: h.device }));
    assert.equal(h.controller.isCurrent(next), false); assert.equal(h.controller.snapshot().outcome, 'lost');
  } finally { h.controller.close(); }
});
test('native preflight and capture authorizer reentrancy prevent late dispatch', async () => {
  const a = adapter(), h = fixture({ adapter: a.binding });
  try {
    h.setActivation(() => { h.controller.stop(); return true; });
    assert.equal((await h.controller.choose('hid')).ok, false); assert.equal(h.calls(), 0);
    h.setActivation(() => true); const choice = await choose(h);
    const other = create({ ...h.options, authorizeCapture() { other.stop(); return undefined; } });
    try { const selected = await other.choose('hid'); assert.ok(selected.ok); assert.equal((await other.start(selected.value)).ok, false); assert.equal(a.opens(), 0); }
    finally { other.close(); }
    h.hook(() => { h.hook(); h.controller.close(); }); assert.equal((await h.controller.start(choice)).ok, false); assert.equal(a.opens(), 0);
  } finally { h.controller.close(); }
});
test('unsafe/foreign clocks, excessive declarations and getter data fail closed without requesting', async () => {
  const h = fixture();
  try {
    h.setTime(10); const choice = await choose(h); h.setTime(9); assert.equal(h.controller.isCurrent(choice), false); assert.equal(h.controller.snapshot().state, 'closed');
    assert.throws(() => create({ ...h.options, declarations: Array(9).fill(declaration()) }));
    let gets = 0; const bad = { ...declaration(), selection: Object.defineProperty({}, 'filters', { enumerable: true, get() { gets++; return []; } }) };
    assert.throws(() => create({ ...h.options, declarations: [bad as BrowserChooserDeclaration] })); assert.equal(gets, 0);
    assert.throws(() => create({ ...h.options, declarations: [{ ...declaration(), capabilities: ['made-up'] }] }));
  } finally { h.controller.close(); }
});
test('lifetime attempt quota does not reset on cancellation or retry', async () => {
  const h = fixture({ select: () => Promise.resolve([]) });
  try {
    for (let index = 0; index < 64; index++) { assert.equal((await h.controller.choose('hid')).ok, false); h.controller.stop(); }
    assert.deepEqual(await h.controller.choose('hid'), { ok: false, reason: 'capacity' }); assert.equal(h.calls(), 64);
  } finally { h.controller.close(); }
});

test('preflight and authorization elapsed deadlines do not dispatch native work', async () => {
  const a = adapter(), h = fixture({ adapter: a.binding, timeoutMs: 10 });
  try {
    h.setActivation(() => { h.setTime(11); return true; });
    assert.equal((await h.controller.choose('hid')).ok, false); assert.equal(h.calls(), 0);
    h.setActivation(() => true); h.setTime(12);
    let at = 0, opens = 0;
    const other = create({ ...h.options, now: () => at, authorizeCapture(request) { at = 11; return { request, expiresAt: 100 }; },
      adapters: [{ id: 'hid', capture() { opens++; return { stop() {} }; } }] });
    try { const choice = await other.choose('hid'); assert.ok(choice.ok); assert.equal((await other.start(choice.value)).ok, false); assert.equal(opens, 0); }
    finally { other.close(); }
  } finally { h.controller.close(); }
});
test('throwing unsubscribe cannot prevent owned stop and release; cleanup blocks synchronous replacement', async () => {
  let released = 0, stopped = 0; const replacements: unknown[] = [];
  const h = fixture({ adapter: { id: 'hid', choose: () => ({ value: {}, release() { released++; },
    onLoss() { return () => { replacements.push(h.controller.choose('hid')); throw Error('private'); }; } }),
    capture: () => ({ stop() { stopped++; } }) } });
  try { const choice = await choose(h); assert.ok((await h.controller.start(choice)).ok); assert.doesNotThrow(() => h.controller.stop());
    assert.equal(stopped, 1); assert.equal(released, 1); assert.equal((await replacements[0] as {ok:boolean}).ok, false); }
  finally { h.controller.close(); }
});

test('cancellation during loss subscription cannot retain an unapproved late capture', async () => {
  let stopped = 0;
  const h = fixture({ adapter: { id: 'hid', capture: () => ({ stop() { stopped++; },
    onLoss() { h.controller.cancel(); return () => {}; } }) } });
  try { const choice = await choose(h); assert.equal((await h.controller.start(choice)).ok, false);
    assert.equal(stopped, 1); assert.equal(h.controller.snapshot().state, 'idle'); assert.equal(h.controller.isCurrent(choice), false); }
  finally { h.controller.close(); }
});
test('stop prevents an abort listener from starting a replacement chooser', async () => {
  const task = deferred<import('./browser-chooser.ts').BrowserChooserNativeSelection>(); let calls = 0;
  const replacements: Promise<unknown>[] = [];
  const h = fixture({ adapter: { id: 'hid', choose(_request, context) { calls++;
    context.signal.addEventListener('abort', () => { replacements.push(h.controller.choose('hid')); }, { once: true });
    return task.promise; }, capture: () => ({ stop() {} }) } });
  try { const opening = h.controller.choose('hid'); h.controller.stop(); assert.equal((await opening).ok, false);
    assert.equal(calls, 1); assert.equal(h.controller.snapshot().choicePending, false); assert.equal((await replacements[0] as {ok:boolean}).ok, false);
    task.resolve({ value: {}, release() {} }); await new Promise(resolve => setTimeout(resolve, 0)); }
  finally { h.controller.close(); }
});

test('hidden document retires ownership and prevents abort-driven replacement', async () => {
  const doc = Object.assign(new EventTarget(), { hidden: false }); let stopped = 0, released = 0;
  const source = fixture(), replacements: Promise<unknown>[] = [];
  const h = create({ ...source.options, environment: { ...source.environment, document: doc },
    adapters: [{ id: 'hid', choose: () => ({ value: {}, release() { released++; } }), capture(_value, context) {
      context.signal.addEventListener('abort', () => { replacements.push(h.choose('hid')); }, { once: true });
      return { stop() { stopped++; } };
    } }] });
  try {
    const choice = await h.choose('hid'); assert.ok(choice.ok); assert.ok((await h.start(choice.value)).ok);
    doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange'));
    assert.equal(stopped, 1); assert.equal(released, 1); assert.equal(h.isCurrent(choice.value), false); assert.equal(h.snapshot().outcome, 'hidden');
    assert.equal(h.snapshot().timerArmed, false); assert.equal((await replacements[0] as {ok:boolean}).ok, false);
    doc.hidden = false; const next = await h.choose('hid'); assert.ok(next.ok);
  } finally { h.close(); source.controller.close(); }
});
test('unfinished owned cleanup retains backpressure until real completion', async () => {
  const release = deferred<void>(); let stopped = 0;
  const h = fixture({ adapter: { id: 'hid', choose: () => ({ value: {}, release: () => release.promise }), capture: () => ({ stop() { stopped++; } }) } });
  try {
    const choice = await choose(h); assert.ok((await h.controller.start(choice)).ok); h.controller.stop();
    assert.equal(stopped, 1); assert.equal(h.controller.snapshot().cleanupPending, 1); assert.equal((await h.controller.choose('hid')).reason, 'busy');
    release.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(h.controller.snapshot().cleanupPending, 0);
    assert.ok((await h.controller.choose('hid')).ok);
  } finally { h.controller.close(); }
});
test('selected BLE and serial options remain closed and never open their borrowed native choice', async () => {
  const source = fixture(), serial = new EventTarget(); let connects = 0, opens = 0;
  const ble = Object.assign(new EventTarget(), { gatt: { connect() { connects++; } } }), port = { open() { opens++; } };
  const requests: unknown[] = [];
  const h = create({ ...source.options, declarations: [declaration('ble', 'bluetooth'), declaration('serial', 'serial')],
    environment: { ...source.environment,
      bluetooth: { requestDevice(options) { requests.push(options); return Promise.resolve(ble); } },
      serial: { requestPort(options) { requests.push(options); return Promise.resolve(port); },
        addEventListener: serial.addEventListener.bind(serial), removeEventListener: serial.removeEventListener.bind(serial) } } });
  try {
    const one = await h.choose('ble'); assert.ok(one.ok); assert.equal((await h.start(one.value)).reason, 'adapter-unbound');
    assert.deepEqual(requests[0], { filters: [{ services: [0x180d] }], optionalServices: [0x180d] });
    ble.dispatchEvent(new Event('gattserverdisconnected')); assert.equal(h.isCurrent(one.value), false);
    const two = await h.choose('serial'); assert.ok(two.ok); assert.deepEqual(requests[1], { filters: [{ usbVendorId: 0x1234, usbProductId: 1 }] });
    serial.dispatchEvent(Object.assign(new Event('disconnect'), { port })); assert.equal(h.isCurrent(two.value), false);
    assert.equal(connects, 0); assert.equal(opens, 0);
    assert.throws(() => create({ ...source.options, declarations: [{ ...declaration('bad', 'bluetooth'), selection: { acceptAllDevices: true } } as never] }));
  } finally { h.close(); source.controller.close(); }
});

test('failed owned loss subscription releases activation and timer', async () => {
  let stopped = 0;
  const h = fixture({ adapter: { id: 'hid', capture: () => ({ stop() { stopped++; }, onLoss() { throw Error('private-native-error'); } }) } });
  try { const choice = await choose(h); assert.equal((await h.controller.start(choice)).ok, false);
    assert.equal(stopped, 1); assert.equal(h.controller.snapshot().current, undefined); assert.equal(h.controller.snapshot().timerArmed, false); }
  finally { h.controller.close(); }
});
test('capture grants require the exact current request and closed non-accessor expiry', async () => {
  const a = adapter(), source = fixture(); let mode = 'copy', gets = 0;
  const h = create({ ...source.options, adapters: [a.binding], authorizeCapture(request) {
    if (mode === 'copy') return { request: { ...request }, expiresAt: 100 };
    if (mode === 'wide') return { request, expiresAt: request.expiresAt + 1 };
    if (mode === 'getter') return Object.defineProperty({ request }, 'expiresAt', { enumerable: true, get() { gets++; return 100; } }) as never;
    return { request, expiresAt: 100 };
  } });
  try { const choice = await h.choose('hid'); assert.ok(choice.ok);
    for (mode of ['copy', 'wide', 'getter']) { assert.equal((await h.start(choice.value)).ok, false); assert.equal(a.opens(), 0); assert.equal(h.isCurrent(choice.value), true); }
    assert.equal(gets, 0); mode = 'valid'; assert.ok((await h.start(choice.value)).ok); assert.equal(a.opens(), 1);
  } finally { h.close(); source.controller.close(); }
});

test('final clock callback cancellation fences newly attached choice and capture', async () => {
  let released = 0, stopped = 0;
  const h = fixture({ adapter: { id: 'hid', choose: () => ({ value: {}, release() { released++; }, onLoss() {
    h.hook(() => { h.hook(); h.controller.cancel(); }); return () => {};
  } }), capture: () => ({ stop() {} }) } });
  try { assert.equal((await h.controller.choose('hid')).ok, false); assert.equal(released, 1); assert.equal(h.controller.snapshot().current, undefined); }
  finally { h.controller.close(); }
  const other = fixture({ adapter: { id: 'hid', capture: () => ({ stop() { stopped++; }, onLoss() {
    other.hook(() => { other.hook(); other.controller.cancel(); }); return () => {};
  } }) } });
  try { const choice = await choose(other); assert.equal((await other.controller.start(choice)).ok, false); assert.equal(stopped, 1); assert.equal(other.controller.snapshot().current, undefined); }
  finally { other.controller.close(); }
});

test('elapsed attachment callback reports expiry and retires its owned capture', async () => {
  let stopped = 0;
  const h = fixture({ adapter: { id: 'hid', capture: () => ({ stop() { stopped++; }, onLoss() { h.setTime(101); return () => {}; } }) } });
  try { const choice = await choose(h); assert.equal((await h.controller.start(choice)).reason, 'expired'); assert.equal(stopped, 1); assert.equal(h.controller.snapshot().outcome, 'expired'); }
  finally { h.controller.close(); }
});
