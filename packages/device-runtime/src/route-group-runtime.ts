import { DeviceValidationError, planRouteGroup } from '@101/device-model';
import type { RouteGroupMember, RouteGroupPlan } from '@101/device-model';
import { failure, success } from './scheduler.ts';
import type { Result } from './scheduler.ts';
import type { Connection } from './types.ts';

export interface RouteGroupController {
  readonly plan: Readonly<RouteGroupPlan>;
  prepare(): Result<Readonly<{ prepared: readonly string[]; omittedOptional: readonly string[] }>>;
  activate(): Result<Readonly<{ active: readonly string[]; omittedOptional: readonly string[] }>>;
  start(): Result<Readonly<{ active: readonly string[]; omittedOptional: readonly string[] }>>;
  /** Recreate every route with fresh authority after a policy pause; adopt the returned controller. */
  resume(): Result<RouteGroupController>;
  stop(reason?: string): void;
  status(): Readonly<{ state: 'idle' | 'prepared' | 'active' | 'paused' | 'closed'; omittedOptional: readonly string[] }>;
}

/** Coordinates host-created routes; their concrete endpoint bindings still require host authority. */
export function createRouteGroupController(
  contract: unknown, devices: unknown, connect: (member: Readonly<RouteGroupMember>) => Connection,
): RouteGroupController {
  const plan = planRouteGroup(contract, devices);
  const pinnedContract = Object.freeze({ schemaVersion: 1, id: plan.id, members: plan.members,
    failure: plan.failure, recovery: plan.recovery });
  if (typeof connect !== 'function') throw new DeviceValidationError('route-group-connect', '$.connect');
  const byId = new Map<string, Connection>(), identities = new Set<Connection>();
  try {
    for (const member of plan.members) {
      const route = connect(member);
      let idle = false;
      try { idle = route?.status?.().state === 'idle'; } catch { /* Invalid host route. */ }
      if (!route || typeof route.id !== 'string' || identities.has(route) ||
          typeof route.prepare !== 'function' || typeof route.activate !== 'function' ||
          typeof route.stop !== 'function' || typeof route.status !== 'function' || typeof route.onClose !== 'function' ||
          !idle) {
        if (route && typeof route.stop === 'function') {
          try { route.stop('construction-failed'); } catch { /* Continue releasing prior routes. */ }
        }
        throw new DeviceValidationError('route-group-route', `$.members.${member.id}`);
      }
      identities.add(route); byId.set(member.id, route);
    }
  } catch (cause) {
    for (const route of byId.values()) {
      try { route.stop('construction-failed'); } catch { /* Continue releasing prior routes. */ }
    }
    throw cause;
  }
  const members = new Map(plan.members.map(member => [member.id, member]));
  const omitted = new Set<string>();
  let state: 'idle' | 'prepared' | 'active' | 'paused' | 'closed' = 'idle', busy = false;
  const ordered = plan.startupOrder.map(id => ({ member: members.get(id)!, route: byId.get(id)! }));
  const unsubscribe: Array<() => void> = [];
  const omission = () => Object.freeze(plan.startupOrder.filter(id => omitted.has(id)));
  function releaseRoutes(reason: string, next: 'paused' | 'closed'): void {
    if (state === 'closed' || state === 'paused' && next === 'paused') return;
    const wasPaused = state === 'paused';
    state = next;
    if (wasPaused) return;
    for (const remove of unsubscribe.splice(0)) {
      try { remove(); } catch { /* Continue releasing the members. */ }
    }
    for (const { route } of [...ordered].reverse()) {
      try { route.stop(reason); } catch { /* Continue releasing the remaining members. */ }
    }
  }
  function stop(reason = 'group-stopped'): void { releaseRoutes(reason, 'closed'); }
  function pause(reason: string): void { releaseRoutes(reason, 'paused'); }
  function onLost(id: string): void {
    if (state !== 'active' || omitted.has(id)) return;
    const member = members.get(id)!;
    const policy = member.required ? plan.recovery.required : plan.recovery.optional;
    if (policy === 'pause') { pause('member-lost'); return; }
    if (policy === 'stop-all') {
      stop('member-lost');
      return;
    }
    omitted.add(id);
    for (const { member: dependent, route } of ordered) {
      if (omitted.has(dependent.id) || !dependent.startAfter.some(prerequisite => omitted.has(prerequisite))) continue;
      omitted.add(dependent.id);
      try { route.stop('dependency-lost'); } catch { stop('dependency-stop-failed'); return; }
    }
  }
  function abort(reason: string): { ok: false; reason: string } { stop('group-failed'); return failure(reason); }
  function skip(member: RouteGroupMember, route: Connection, reason: string): boolean {
    if (member.required || plan.failure.optional === 'stop-all') return false;
    try { route.stop(reason); } catch { return false; }
    omitted.add(member.id);
    return true;
  }
  function prepare(): ReturnType<RouteGroupController['prepare']> {
    if (busy || state !== 'idle') return failure(busy ? 'reentrant' : 'invalid-state');
    busy = true;
    try {
      for (const { member, route } of ordered) {
        if (member.startAfter.some(id => omitted.has(id))) {
          if (!skip(member, route, 'dependency-omitted')) return abort('dependency-omitted');
          continue;
        }
        let result: Result, prepared = false;
        try { result = route.prepare(); if (result.ok) prepared = route.status().state === 'prepared'; }
        catch { return abort('preparation-failed'); }
        if (state !== 'idle') return failure('closed');
        if (!result.ok) {
          if (!skip(member, route, result.reason)) return abort(result.reason);
        } else if (!prepared) {
          if (!skip(member, route, 'preparation-lost')) return abort('preparation-lost');
        }
      }
      state = 'prepared';
      return success(Object.freeze({ prepared: Object.freeze(plan.startupOrder.filter(id => !omitted.has(id))),
        omittedOptional: omission() }));
    } finally { busy = false; }
  }
  function activate(): ReturnType<RouteGroupController['activate']> {
    if (busy || state !== 'prepared') return failure(busy ? 'reentrant' : 'invalid-state');
    busy = true;
    try {
      for (const { member, route } of ordered) {
        if (omitted.has(member.id)) continue;
        if (member.startAfter.some(id => omitted.has(id))) {
          if (!skip(member, route, 'dependency-omitted')) return abort('dependency-omitted');
          continue;
        }
        let prepared = false;
        try { prepared = route.status().state === 'prepared'; } catch { return abort('preparation-lost'); }
        if (!prepared) {
          if (!skip(member, route, 'preparation-lost')) return abort('preparation-lost');
          continue;
        }
        let result: Result, active = false;
        try { result = route.activate(); if (result.ok) active = route.status().state === 'active'; }
        catch { return abort('activation-failed'); }
        if (state !== 'prepared') return failure('closed');
        if (!result.ok) {
          if (!skip(member, route, result.reason)) return abort(result.reason);
        } else if (!active) {
          if (!skip(member, route, 'activation-lost')) return abort('activation-lost');
        }
      }
      try {
        if (plan.members.some(member => member.required && byId.get(member.id)!.status().state !== 'active'))
          return abort('required-lost');
      } catch { return abort('required-lost'); }
      state = 'active';
      for (const { member, route } of ordered) {
        if (state !== 'active') break;
        if (omitted.has(member.id)) continue;
        try {
          const remove = route.onClose(() => onLost(member.id));
          if (state === 'active' && !omitted.has(member.id)) unsubscribe.push(remove);
          else remove();
        }
        catch { return abort('close-observer-failed'); }
      }
      if (state !== 'active') return failure('member-lost');
      return success(Object.freeze({ active: Object.freeze(plan.startupOrder.filter(id => !omitted.has(id))),
        omittedOptional: omission() }));
    } finally { busy = false; }
  }
  return Object.freeze({ plan, prepare, activate,
    start(): ReturnType<RouteGroupController['start']> {
      const ready = prepare();
      return ready.ok ? activate() : ready;
    },
    resume(): Result<RouteGroupController> {
      if (state !== 'paused') return failure('invalid-state');
      try {
        const replacement = createRouteGroupController(pinnedContract, devices, connect);
        const started = replacement.start();
        if (!started.ok) return failure(started.reason);
        state = 'closed';
        return success(replacement);
      } catch { return failure('recovery-failed'); }
    },
    stop,
    status() { return Object.freeze({ state, omittedOptional: omission() }); },
  });
}
