import { createDeviceRuntime, createInputOwnershipController, pointerSourceDescriptor, PointerSourceDriver } from '@101/connect';
import type { DeviceDescriptor, InputOwnershipController, InputOwnershipSnapshot, Observation } from '@101/connect';

export const SHARING_TASK_PROFILE = 'local-application-sharing/1';
export const SHARING_TASK_LIMITS = Object.freeze({ requests: 64, policyChanges: 8, transitions: 64, durations: [30, 60] as const });
export type SharingPolicy = 'partitioned' | 'exclusive';
export interface SharingPreview {
  readonly kind: 'revoke' | 'policy'; readonly policy?: SharingPolicy;
  readonly recipients: readonly Readonly<{ slotId: string; sourceId: string; epoch: number }>[];
}
export type SharingSlot = InputOwnershipSnapshot['slots'][number] & {
  readonly held: boolean; readonly position?: Readonly<{ x: number; y: number }>;
  readonly endsAt?: number; readonly duration?: 30 | 60; readonly requestDuration?: 30 | 60;
}
export interface SharingSnapshot {
  readonly closed: boolean; readonly policy: SharingPolicy; readonly remainingRequests: number;
  readonly remainingPolicyChanges: number; readonly remainingActivationAttempts: number;
  readonly recipients: readonly Readonly<{ id: string; label: string; available: boolean }>[];
  readonly slots: readonly SharingSlot[]; readonly preview?: SharingPreview;
  readonly notice: 'ready' | 'consent-needed' | 'unavailable' | 'controls-in-use' | 'review-changed' | 'revoked' | 'policy-changed' | 'interrupted' | 'closed' | 'limit';
  readonly transitions: readonly string[];
}
interface Consent { sourceId: string; slotId: string; duration: 30 | 60; endsAt?: number }
interface Environment {
  runtime: ReturnType<typeof createDeviceRuntime>; ownership: InputOwnershipController;
  sources: Array<{ id: string; label: string; driver: PointerSourceDriver; createDriver: () => PointerSourceDriver; resources: Array<{ handle: { readonly id: string }; device: DeviceDescriptor; capability: string }> }>;
  values: Map<string, { routeId: string; value: Observation['value'] }>;
  pending: Map<string, Consent>; permits: Map<string, Consent>; previous: Map<string, string>;
  remove: () => void;
}
const sourceIds = ['first', 'second'];
const labels = ['First controls', 'Second controls'];

/** Same-page input ownership; labels identify issued local controls, never remote people. */
export function createSharingTask(options: { now: () => number; onChange?: () => void }) {
  const descriptors = Object.getOwnPropertyDescriptors(options);
  if (!descriptors.now || !('value' in descriptors.now) || typeof descriptors.now.value !== 'function' ||
    descriptors.onChange && (!('value' in descriptors.onChange) || typeof descriptors.onChange.value !== 'function')) throw new TypeError('Invalid sharing callbacks');
  const now = descriptors.now.value as () => number, onChange = descriptors.onChange?.value as (() => void) | undefined;
  let closed = false, busy = false, notifying = false, readingClock = false, lastTime: number | undefined;
  let policy: SharingPolicy = 'partitioned', requests = 0, policyChanges = 0, activationAttempts = 0;
  let notice: SharingSnapshot['notice'] = 'ready', preview: SharingPreview | undefined;
  let generation = 0, environment: Environment | undefined, activatingSlot: string | undefined;
  const available = new Map(sourceIds.map(id => [id, true]));
  const transitions: string[] = [];
  let previewGeneration = 0, previewPending = '';
  function notify() {
    if (notifying) return;
    notifying = true;
    try { onChange?.(); } catch { /* Display callbacks convey no authority. */ } finally { notifying = false; }
  }
  function record(value: string) { transitions.push(value); if (transitions.length > SHARING_TASK_LIMITS.transitions) transitions.shift(); }
  function readTime(): number | undefined {
    if (closed || readingClock) return;
    readingClock = true; let at: number;
    try { at = now(); } catch { close(); return; } finally { readingClock = false; }
    if (closed) return;
    if (!Number.isFinite(at) || at < 0 || at > Number.MAX_SAFE_INTEGER - 60000 || lastTime !== undefined && at < lastTime) { close(); return; }
    lastTime = at; return at;
  }
  function reconcile(env: Environment) {
    const current = env.ownership.snapshot(), next = new Map<string, string>();
    for (const slot of current.slots) {
      if (slot.owner) next.set(slot.id, `${slot.owner.sourceId}:${slot.owner.epoch}`);
      const permit = env.permits.get(slot.id);
      if (activatingSlot !== slot.id && (!slot.owner || slot.owner.sourceId !== permit?.sourceId)) env.permits.delete(slot.id);
    }
    for (const source of env.sources) if (current.slots.some(slot => {
      const before = env.previous.get(slot.id), after = next.get(slot.id);
      return before !== after && (before?.startsWith(`${source.id}:`) || after?.startsWith(`${source.id}:`));
    })) { source.driver.stop(); source.driver = source.createDriver(); }
    env.previous = next;
    const pendingIds = new Set(current.slots.flatMap(slot => slot.request ? [slot.request.id] : []));
    for (const id of env.pending.keys()) if (!pendingIds.has(id)) env.pending.delete(id);
  }
  function createEnvironment(): Environment {
    const ownGeneration = ++generation;
    const values: Environment['values'] = new Map(), pending = new Map<string, Consent>(), permits = new Map<string, Consent>();
    const runtime = createDeviceRuntime({ now: () => readTime() ?? NaN, clockDomain: 'local-sharing', maxRoutes: 4, maxRegistrations: 6,
      authorize(request) {
        if (closed || generation !== ownGeneration || !ownership?.isApproved(request)) return;
        const slotId = request.partition ?? 'exclusive', consent = permits.get(slotId);
        const at = readTime();
        if (at === undefined || closed || generation !== ownGeneration || !ownership.isApproved(request) ||
          !consent || permits.get(slotId) !== consent || !available.get(consent.sourceId) || consent.endsAt === undefined || at >= consent.endsAt ||
          request.principalId !== `local-sharing-${consent.sourceId}`) return;
        return { expiresAt: consent.endsAt, maxAgeMs: 100, maxHz: 60 };
      } });
    const sources = sourceIds.map((id, index) => {
      const device = { ...pointerSourceDescriptor('browser-application'), id: `sharing-input-${id}`, label: labels[index]! };
      const resources = device.capabilities.map(capability => {
        const handle = runtime.registerSource({ device, capability: capability.id }); runtime.setReadiness(handle, available.get(id) ? 'available' : 'unavailable');
        return { handle, device, capability: capability.id };
      });
      let operation = 0;
      const createDriver = () => new PointerSourceDriver({ now: () => readTime() ?? NaN, publish(capabilityId, value, metadata) {
        if (closed || generation !== ownGeneration || !available.get(id)) return false;
        const resource = resources.find(item => item.capability === capabilityId)!;
        const capability = device.capabilities.find(item => item.id === capabilityId)!;
        const result = runtime.publish(resource.handle, value, { timestamp: metadata.capturedAt, clockDomain: runtime.clockDomain,
          ...(capability.delivery.mode === 'reliable' ? { operationId: String(++operation), deadline: metadata.capturedAt + capability.delivery.maxAgeMs } : {}) });
        return result.ok && result.value.accepted > 0 && result.value.rejected === 0;
      } });
      return { id, label: device.label, resources, driver: createDriver(), createDriver };
    });
    const device: DeviceDescriptor = { ...pointerSourceDescriptor('browser-application'), id: 'sharing-play-area', label: 'Shared play area',
      capabilities: pointerSourceDescriptor().capabilities.map(capability => ({ ...capability, kind: 'property', permissions: ['write'],
        ownership: policy === 'partitioned' ? { mode: 'partitioned', partitions: ['left', 'right'] } : { mode: 'exclusive' } })) };
    const resources = device.capabilities.map(capability => {
      const handle = runtime.registerSink({ device, capability: capability.id, apply(observation, context) {
        if (closed || generation !== ownGeneration || context.signal.aborted || !context.isCurrent()) return;
        values.set(`${context.partition ?? 'exclusive'}:${capability.id}`, { routeId: context.routeId, value: observation.value });
      }, release(_reason, context) {
        const key = `${context.partition ?? 'exclusive'}:${capability.id}`;
        if (values.get(key)?.routeId === context.routeId) values.delete(key);
      } }); runtime.setReadiness(handle, 'available'); return { handle, device, capability: capability.id };
    });
    const ownership: InputOwnershipController = createInputOwnershipController({ runtime, applicationId: 'local-sharing', sessionId: `sharing-generation-${ownGeneration}`, now: () => readTime() ?? NaN,
      sources: sources.map(source => ({ ...source, principalId: `local-sharing-${source.id}` })), destination: { label: device.label, resources } });
    const env: Environment = { runtime, ownership, sources, values, pending, permits, previous: new Map(), remove: () => {} };
    env.remove = ownership.subscribe(() => { reconcile(env); notify(); });
    return env;
  }
  function retire(env: Environment) {
    env.permits.clear(); env.pending.clear(); env.remove(); env.ownership.close();
    for (const source of env.sources) source.driver.stop(); env.runtime.close(); env.values.clear();
  }
  function close() {
    if (closed) return; closed = true; generation++; preview = undefined;
    if (environment) retire(environment); notice = 'closed'; record('closed'); notify();
  }
  function snapshot(): SharingSnapshot {
    const env = environment!, owned = env.ownership.snapshot();
    return Object.freeze({ closed, policy, notice, remainingRequests: SHARING_TASK_LIMITS.requests - requests,
      remainingPolicyChanges: SHARING_TASK_LIMITS.policyChanges - policyChanges, remainingActivationAttempts: 64 - activationAttempts,
      recipients: Object.freeze(sourceIds.map((id, index) => Object.freeze({ id, label: labels[index]!, available: available.get(id) === true }))),
      slots: Object.freeze(owned.slots.map(slot => {
        const position = env.values.get(`${slot.id}:position`)?.value, consent = env.permits.get(slot.id) ?? (slot.request && env.pending.get(slot.request.id));
        return Object.freeze({ ...slot, held: env.values.get(`${slot.id}:contact`)?.value === true,
          ...(position && typeof position === 'object' && 'x' in position && 'y' in position && typeof position.x === 'number' && typeof position.y === 'number'
            ? { position: Object.freeze({ x: position.x, y: position.y }) } : {}),
          ...(slot.request && env.pending.get(slot.request.id) ? { requestDuration: env.pending.get(slot.request.id)!.duration } : {}),
          ...(consent ? { duration: consent.duration, ...(consent.endsAt === undefined ? {} : { endsAt: consent.endsAt }) } : {}) });
      })), ...(preview ? { preview } : {}), transitions: Object.freeze([...transitions]) });
  }
  function enter(): boolean { if (closed || busy) return false; busy = true; return true; }
  function mutate(action: (env: Environment) => boolean): boolean {
    if (!enter()) return false;
    try { return action(environment!) && !closed; } finally { busy = false; notify(); }
  }
  function makePreview(kind: SharingPreview['kind'], slotId?: string, target?: SharingPolicy): SharingPreview | undefined {
    if (closed || busy || !environment) return;
    const slots = environment.ownership.snapshot().slots;
    if (kind === 'revoke' && !slots.some(slot => slot.id === slotId && slot.owner) || kind === 'policy' &&
      (target !== 'exclusive' && target !== 'partitioned' || target === policy || policyChanges >= SHARING_TASK_LIMITS.policyChanges)) return;
    preview = Object.freeze({ kind, ...(target ? { policy: target } : {}), recipients: Object.freeze(slots.flatMap(slot =>
      slot.owner && (kind === 'policy' || slot.id === slotId) ? [Object.freeze({ slotId: slot.id, sourceId: slot.owner.sourceId, epoch: slot.owner.epoch })] : [])) });
    previewGeneration = generation; previewPending = JSON.stringify(slots.map(slot => slot.request?.id)); notify(); return closed ? undefined : preview;
  }
  function inputSource(sourceId: string) {
    if (closed || busy || !available.get(sourceId) || !environment?.ownership.snapshot().slots.some(slot => slot.owner?.sourceId === sourceId)) return;
    return environment.sources.find(source => source.id === sourceId);
  }
  environment = createEnvironment();
  if (closed) retire(environment);
  return Object.freeze({ snapshot, close,
    request(sourceId: string, slotId: string, duration: 30 | 60, sourceAllowed: boolean): boolean {
      return mutate(env => {
        const at = readTime(); if (at === undefined) return false;
        if (sourceAllowed !== true) { notice = 'consent-needed'; return false; }
        if (duration !== 30 && duration !== 60 || !sourceIds.includes(sourceId) || !available.get(sourceId)) { notice = 'unavailable'; return false; }
        if (requests >= SHARING_TASK_LIMITS.requests || activationAttempts >= 64) { notice = 'limit'; return false; }
        // Metadata exists before synchronous ownership observers, but authority is not issued.
        if (env.ownership.snapshot().slots.some(slot => slot.id !== slotId && (slot.owner?.sourceId === sourceId || slot.request?.sourceId === sourceId))) { notice = 'controls-in-use'; return false; }
        const result = env.ownership.request(sourceId, slotId); if (!result.ok || closed) return false;
        requests++; env.pending.set(result.value.id, { sourceId, slotId, duration }); notice = 'ready'; record('requested'); return true;
      });
    },
    decide(requestId: string, allow: boolean): boolean {
      return mutate(env => {
        const consent = env.pending.get(requestId), slot = env.ownership.snapshot().slots.find(value => value.request?.id === requestId);
        const at = readTime(); if (at === undefined || !consent || !slot?.request || at >= slot.request.expiresAt || typeof allow !== 'boolean') return false;
        const incumbent = env.permits.get(slot.id), previousOwner = slot.owner;
        if (allow) {
          if (activationAttempts >= 64 || !available.get(consent.sourceId)) { notice = 'unavailable'; return false; }
          activationAttempts++; env.permits.set(slot.id, { ...consent, endsAt: at + consent.duration * 1000 });
        }
        activatingSlot = allow ? slot.id : undefined;
        let result; try { result = env.ownership.decide(requestId, slot.request.expectedOwnerEpoch, allow); } finally { activatingSlot = undefined; }
        if (!result.ok) {
          const current = env.ownership.snapshot().slots.find(value => value.id === slot.id)?.owner;
          if (!closed && incumbent && previousOwner && current?.sourceId === previousOwner.sourceId && current.epoch === previousOwner.epoch) env.permits.set(slot.id, incumbent);
          else env.permits.delete(slot.id);
          notice = result.reason === 'stale' ? 'review-changed' : 'unavailable';
        } else { notice = 'ready'; record(allow ? 'approved' : 'declined'); }
        reconcile(env);
        return result.ok;
      });
    },
    cancel(requestId: string): boolean { return mutate(env => { const result = env.ownership.cancel(requestId); env.pending.delete(requestId); record('cancelled'); return result.ok; }); },
    previewRevoke(slotId: string) { return makePreview('revoke', slotId); },
    previewPolicy(target: SharingPolicy) { return makePreview('policy', undefined, target); },
    cancelPreview() { if (closed || busy) return; preview = undefined; notice = 'ready'; notify(); },
    confirmPreview(value: SharingPreview): boolean {
      return mutate(env => {
        const slots = env.ownership.snapshot().slots;
        if (value !== preview || !preview || previewGeneration !== generation ||
          preview.kind === 'policy' && (JSON.stringify(slots.map(slot => slot.request?.id)) !== previewPending ||
            JSON.stringify(slots.flatMap(slot => slot.owner ? [{ slotId: slot.id, sourceId: slot.owner.sourceId, epoch: slot.owner.epoch }] : [])) !== JSON.stringify(preview.recipients)) ||
          preview.recipients.some(recipient => { const slot = slots.find(item => item.id === recipient.slotId); return slot?.owner?.sourceId !== recipient.sourceId || slot.owner.epoch !== recipient.epoch; })) {
          notice = 'review-changed'; return false;
        }
        for (const recipient of preview.recipients) if (!env.ownership.release(recipient.slotId, recipient.epoch).ok || closed) { notice = 'review-changed'; return false; }
        if (preview.kind === 'policy') {
          const target = preview.policy!; retire(env); if (closed) return false;
          policy = target; policyChanges++; environment = createEnvironment(); notice = 'policy-changed'; record('policy-changed');
        } else { notice = 'revoked'; record('revoked'); }
        preview = undefined; return true;
      });
    },
    setAvailable(sourceId: string, value: boolean) {
      return mutate(env => {
        const source = env.sources.find(item => item.id === sourceId); if (!source || typeof value !== 'boolean') return false;
        available.set(sourceId, value); if (!value) source.driver.release();
        for (const resource of source.resources) env.runtime.setReadiness(resource.handle, value ? 'available' : 'unavailable');
        env.ownership.tick(); reconcile(env); record(value ? 'controls-reconnected' : 'controls-disconnected'); return true;
      });
    },
    tick() {
      mutate(env => { if (readTime() === undefined) return false; env.ownership.tick(); if (closed) return false;
        const owners = new Set(env.ownership.snapshot().slots.flatMap(slot => slot.owner ? [slot.owner.sourceId] : []));
        for (const source of env.sources) if (owners.has(source.id)) source.driver.tick(); env.runtime.flush(); reconcile(env); return true; });
    },
    nudge(sourceId: string, dx: number, dy: number) { return inputSource(sourceId)?.driver.nudge(dx, dy) === true; },
    contact(sourceId: string, value: boolean) { return inputSource(sourceId)?.driver.setContact(value) === true; },
    begin(sourceId: string, pointerId: number, x: number, y: number, width: number, height: number) {
      return inputSource(sourceId)?.driver.begin(pointerId, x, y, width, height) === true;
    },
    move(sourceId: string, pointerId: number, x: number, y: number, width: number, height: number) {
      return inputSource(sourceId)?.driver.move(pointerId, x, y, width, height) === true;
    },
    end(sourceId: string, pointerId: number) { return inputSource(sourceId)?.driver.end(pointerId) === true; },
    releaseInput(sourceId: string) { if (!closed) environment!.sources.find(source => source.id === sourceId)?.driver.release(); },
    interrupt() {
      mutate(env => {
        for (const slot of env.ownership.snapshot().slots) { if (slot.request) env.ownership.cancel(slot.request.id); if (slot.owner) env.ownership.release(slot.id, slot.owner.epoch); }
        env.permits.clear(); env.pending.clear(); for (const source of env.sources) source.driver.release();
        preview = undefined; notice = 'interrupted'; record('interrupted'); return true;
      });
    },
  });
}
export type SharingTask = ReturnType<typeof createSharingTask>;
