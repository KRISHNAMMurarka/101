import { parseControlMessage } from '@101/protocol';
import type { DeviceCapabilities, LinkMessage, LinkTransport } from '@101/protocol';
import { capabilitySources } from '@101/session';
import { CATALOG_INPUT_LABELS } from '../lib/catalog.ts';
import type { LocalDevice } from '../lib/local-capabilities.ts';

export const DEVICE_INSPECTION_LIMITS = Object.freeze({ devices: 8, eventsPerSecond: 64, freshnessMs: 6000, activityMs: 2000, tickMs: 250 });
export interface InspectedResource { readonly id: string; readonly label: string;
  readonly state: 'unchecked' | 'needs-permission' | 'denied' | 'unsupported' | 'unavailable' | 'observed'; readonly note: string }
export interface InspectedDevice { readonly id: string; readonly label: string; readonly state: 'reported' | 'active' | 'unknown' | 'partial' | 'offline';
  readonly resources: readonly InspectedResource[]; readonly lastSeenAt?: number }
export interface LinkedDeviceSnapshot { readonly sessionId: string; readonly phase: 'idle' | 'looking' | 'listening' | 'stopped' | 'failed' | 'closed';
  readonly reserved: boolean; readonly timerArmed: boolean; readonly devices: readonly InspectedDevice[] }
export interface LinkedDeviceObserver { start(): Promise<boolean>; stop(): Promise<void>; close(): Promise<void>; sweep(): void; snapshot(): LinkedDeviceSnapshot }
const row = (id: string, label: string, state: InspectedResource['state'], note: string): InspectedResource => Object.freeze({ id, label, state, note });

/** API/provider presence is setup information, never an observation or permission. */
export function inspectLocalDevice(local: LocalDevice, access: { cameraApi: boolean; cameraPermission: PermissionState | 'unknown' }): InspectedDevice {
  const resources: InspectedResource[] = [];
  for (const source of local.sources) if (!['camera-hand', 'camera-pose', 'phone-motion'].includes(source)) resources.push(row(source, CATALOG_INPUT_LABELS[source], 'unchecked', 'Choose this input in an application to use it.'));
  resources.push(access.cameraPermission === 'denied' ? row('camera', 'Camera input', 'denied', 'Camera access is blocked here. Review this site’s browser permissions or choose another input.') :
    !access.cameraApi ? row('camera', 'Camera input', 'unsupported', 'Camera input is unavailable in this browser. Use another browser or choose another input.') :
      !local.capabilities.camera ? row('camera', 'Camera input', 'unavailable', 'No camera was found. Connect a camera and refresh inputs, or use another input.') :
        row('camera', 'Camera input', access.cameraPermission === 'granted' ? 'unchecked' : 'needs-permission', 'Camera input is set up inside an application. Inspection does not start the camera.'));
  resources.push(local.capabilities.gyroscope ? row('phone-motion', 'Motion input', 'needs-permission', 'Motion needs setup and any required permission on this device before use.') :
    row('phone-motion', 'Motion input', 'unsupported', 'Rotation input was not found. Use touch, a keyboard or another controller.'));
  if (!local.capabilities.gamepad) resources.push(row('gamepad', 'Gamepad', 'unavailable', 'Connect a gamepad, press a button on it, then refresh inputs.'));
  return Object.freeze({ id: 'local-device', label: `This ${local.shape}`, state: resources.some(value => value.state !== 'unchecked') ? 'partial' : 'reported', resources: Object.freeze(resources) });
}
interface Device { id: string; label: string; capabilities: DeviceCapabilities; seen: number; live: boolean; activity?: number; sequence: number }
function inspect(device: Device, now: number): InspectedDevice {
  const resources = capabilitySources(device.capabilities).map(source => row(source, CATALOG_INPUT_LABELS[source], source === 'phone-motion' ? 'needs-permission' : 'unchecked',
    source === 'phone-motion' ? 'Motion needs setup and any required permission on that device.' : 'Reported by this controller. Choose an application before using it.'));
  if (device.capabilities.camera) resources.push(row('camera', 'Camera input', 'unsupported', 'This controller does not send camera input to this screen. Use this screen’s camera setup in an application.'));
  if (device.capabilities.accelerometer && !device.capabilities.gyroscope) resources.push(row('rotation', 'Motion input', 'unsupported', 'A movement sensor alone does not provide the rotation input used by 101 controls.'));
  const active = device.live && device.activity !== undefined && now < device.activity + DEVICE_INSPECTION_LIMITS.activityMs;
  if (active) resources.push(row('received-input', 'Control input', 'observed', 'A valid input report arrived recently. This does not grant an application permission.'));
  if (!resources.length) resources.push(row('unknown-input', 'Inputs not identified', 'unsupported', 'This device has not reported inputs that this screen can use. Update or reopen 101 Link, or choose another device.'));
  if (!device.live) return Object.freeze({ id: device.id, label: device.label, state: 'offline', lastSeenAt: device.seen,
    resources: Object.freeze(resources.map(value => row(value.id, value.label, 'unavailable', 'This device is no longer responding. Reopen its connection link and find devices again.'))) });
  return Object.freeze({ id: device.id, label: device.label, state: active ? 'active' : !capabilitySources(device.capabilities).length ? 'unknown' :
    resources.some(value => value.state === 'unsupported' || value.state === 'needs-permission') ? 'partial' : 'reported', lastSeenAt: device.seen, resources: Object.freeze(resources) });
}
function data(input: unknown, fields: readonly string[], required = fields): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error('Invalid input report');
  const keys = Reflect.ownKeys(input); if (keys.length > fields.length) throw new Error('Invalid input report'); const value: Record<string, unknown> = {};
  for (const key of keys) { const property = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !fields.includes(key) || !property?.enumerable || !Object.hasOwn(property, 'value')) throw new Error('Invalid input report'); value[key] = property.value; }
  if (required.some(key => !Object.hasOwn(value, key))) throw new Error('Invalid input report'); return value;
}
function boundedRecord(input: unknown, limit: number): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid input report');
  const keys = Reflect.ownKeys(input); if (keys.length > limit || keys.some(key => typeof key !== 'string' || key.length > 128)) throw new Error('Invalid input report');
  return data(input, keys as string[]);
}
function finite(input: unknown): input is number { return typeof input === 'number' && Number.isFinite(input); }
function validFrame(input: unknown): { deviceId: string; sequence: number } | undefined {
  try {
    const value = data(input, ['deviceId', 'playerId', 'sequence', 'timestamp', 'receivedAt', 'source', 'actions', 'axes', 'vectors', 'poses'], ['deviceId', 'playerId', 'sequence', 'timestamp', 'source', 'actions']);
    if (typeof value.deviceId !== 'string' || value.deviceId.length > 128 || typeof value.playerId !== 'string' || value.playerId.length > 128 ||
      !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0 || !finite(value.timestamp) || value.timestamp < 0 || !['touch', 'phone-motion', 'gamepad', 'custom'].includes(value.source as string)) return;
    const actions = boundedRecord(value.actions, 64);
    if (Object.keys(actions).length > 64 || Object.entries(actions).some(([key, item]) => key.length > 128 || typeof item !== 'boolean' && (!finite(item) || Math.abs(item) > 1))) return;
    if (value.axes !== undefined) { const axes = boundedRecord(value.axes, 32); if (Object.keys(axes).length > 32 || Object.values(axes).some(item => !finite(item) || Math.abs(item) > 1)) return; }
    if (value.vectors !== undefined) { const vectors = boundedRecord(value.vectors, 8); if (Object.keys(vectors).length > 8) return;
      for (const input of Object.values(vectors)) { const vector = data(input, ['x', 'y', 'z'], ['x', 'y']); if (Object.values(vector).some(item => !finite(item) || Math.abs(item) > 1)) return; } }
    // This passive selected controller profile does not inspect pose/media payloads.
    if (value.poses !== undefined) return;
    return { deviceId: value.deviceId, sequence: value.sequence as number };
  } catch { return; }
}
interface Attempt { readonly epoch: number; remove?: () => void; open?: Promise<void>; release?: Promise<void>; retired: boolean; lease: boolean }

/** Passive observations through one selected room transport. Never emits input,
 * role assignment, consent or a resource command, and never stores live values. */
export function createLinkedDeviceObserver(options: { sessionId: string; transport: LinkTransport; now: () => number; onChange: (snapshot: LinkedDeviceSnapshot) => void }): LinkedDeviceObserver {
  if (!/^[A-Za-z0-9-]{4,128}$/.test(options.sessionId)) throw new TypeError('Invalid device room');
  const { sessionId, transport, now, onChange } = options, devices = new Map<string, Device>();
  let phase: LinkedDeviceSnapshot['phase'] = 'idle', closed = false, epoch = 0, active: Attempt | undefined, reservation: Attempt | undefined;
  let last = 0, eventsAt = 0, events = 0, reading = false, timer: ReturnType<typeof setTimeout> | undefined;
  const current = (record: Attempt) => !closed && active === record && record.epoch === epoch && !record.retired;
  function snapshot(): LinkedDeviceSnapshot { return Object.freeze({ sessionId, phase, reserved: !!reservation, timerArmed: timer !== undefined,
    devices: Object.freeze([...devices.values()].map(device => inspect(device, last))) }); }
  function report() { try { onChange(snapshot()); } catch { /* View callbacks never gain device authority. */ } }
  function disarm() { if (timer !== undefined) clearTimeout(timer); timer = undefined; }
  function time() {
    if (reading) { void retire('failed'); throw new Error('Device clock unavailable'); } reading = true;
    try { const at = now(); if (!finite(at) || at < last || at > Number.MAX_SAFE_INTEGER - DEVICE_INSPECTION_LIMITS.freshnessMs) throw new Error('Device clock unavailable'); last = at; return at; }
    catch { void retire('failed'); throw new Error('Device clock unavailable'); } finally { reading = false; }
  }
  function release(record: Attempt): Promise<void> {
    if (record.release) return record.release;
    record.release = (record.open ?? Promise.resolve()).catch(() => undefined).then(async () => {
      if (record.lease) { record.lease = false; await transport.disconnect().catch(() => undefined); }
      if (reservation === record) reservation = undefined; report();
    }); return record.release;
  }
  function retire(next: LinkedDeviceSnapshot['phase']): Promise<void> {
    const record = active; active = undefined; epoch++; disarm();
    if (record) { record.retired = true; record.remove?.(); record.remove = undefined; }
    for (const device of devices.values()) { device.live = false; device.activity = undefined; }
    phase = closed ? 'closed' : next; report(); return record ? release(record) : reservation ? release(reservation) : Promise.resolve();
  }
  function arm(record: Attempt) {
    if (!current(record) || timer !== undefined) return;
    const owned = setTimeout(() => { if (timer !== owned) return; timer = undefined; sweep(); }, DEVICE_INSPECTION_LIMITS.tickMs);
    if (!current(record)) clearTimeout(owned); else timer = owned;
  }
  function sweep() {
    const record = active; if (!record || !current(record)) return;
    try { const at = time(); if (!current(record)) return; let changed = false;
      for (const device of devices.values()) { if (device.live && at >= device.seen + DEVICE_INSPECTION_LIMITS.freshnessMs) { device.live = false; device.activity = undefined; changed = true; }
        if (device.activity !== undefined && at >= device.activity + DEVICE_INSPECTION_LIMITS.activityMs) { device.activity = undefined; changed = true; } }
      if (changed) report(); arm(record);
    } catch { void retire('failed'); }
  }
  function receive(record: Attempt, message: LinkMessage) {
    if (!current(record)) return;
    try { const at = time(); if (!current(record)) return;
      if (at - eventsAt >= 1000) { eventsAt = at; events = 0; } if (++events > DEVICE_INSPECTION_LIMITS.eventsPerSecond) { void retire('failed'); return; }
      if (message.channel === 'control') {
        const payload = parseControlMessage(message.payload);
        if (payload.type === 'hello') {
          let device = devices.get(payload.deviceId);
          if (!device && devices.size >= DEVICE_INSPECTION_LIMITS.devices) { const offline = [...devices.values()].find(value => !value.live); if (!offline) return; devices.delete(offline.id); }
          const sequence = device?.live ? device.sequence : -1;
          device = { id: payload.deviceId, label: payload.device, capabilities: Object.freeze({ ...payload.capabilities }), seen: at, live: true, sequence, activity: device?.activity };
          devices.set(device.id, device); report(); return;
        }
        if (payload.type === 'ping' && payload.deviceId) { const device = devices.get(payload.deviceId); if (device?.live) { device.seen = at; report(); } }
      } else if (message.channel === 'realtime') {
        const frame = validFrame(message.payload), device = frame && devices.get(frame.deviceId);
        if (!frame || !device?.live || at >= device.seen + DEVICE_INSPECTION_LIMITS.freshnessMs || frame.sequence <= device.sequence) return;
        device.sequence = frame.sequence; device.activity = at; device.seen = at; report();
      }
    } catch { /* Unsupported/malformed data stays unchecked; no raw error reaches a player. */ }
  }
  return Object.freeze({
    async start() {
      if (closed || reservation || active) return false;
      const record: Attempt = { epoch: ++epoch, retired: false, lease: false }; active = record; phase = 'looking'; report();
      try {
        if (!current(record)) return false; time(); if (!current(record)) return false; eventsAt = last; events = 0;
        record.remove = transport.onMessage(message => receive(record, message)); if (!current(record)) { record.remove(); return false; }
        // Install the actual-settlement fence before connect can invoke host code.
        let finish!: () => void, fail!: (cause: unknown) => void;
        record.open = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; }); reservation = record; record.lease = true;
        try { Promise.resolve(transport.connect()).then(finish, fail); } catch (cause) { fail(cause); }
        await record.open;
        if (!current(record)) { await release(record); return false; }
        phase = 'listening'; arm(record); report(); return current(record);
      } catch { if (current(record)) await retire('failed'); else await release(record); return false; }
    },
    stop: () => retire('stopped'), close() { closed = true; return retire('closed'); }, sweep, snapshot,
  });
}
