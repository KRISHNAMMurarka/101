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
  stop(reason?: string): void;
  status(): Readonly<{ state: 'idle' | 'prepared' | 'active' | 'closed'; omittedOptional: readonly string[] }>;
}

/** Coordinates host-created routes; their concrete endpoint bindings still require host authority. */
export function createRouteGroupController(
  contract: unknown, devices: unknown, connect: (member: Readonly<RouteGroupMember>) => Connection,
): RouteGroupController {
  const plan = planRouteGroup(contract, devices);
  if (typeof connect !== 'function') throw new DeviceValidationError('route-group-connect', '$.connect');
  const byId = new Map<string, Connection>(), identities = new Set<Connection>();
  try {
    for (const member of plan.members) {
      const route = connect(member);
      let idle = false;
      try { idle = route?.status?.().state === 'idle'; } catch { /* Invalid host route. */ }
      if (!route || typeof route.id !== 'string' || identities.has(route) ||
          typeof route.prepare !== 'function' || typeof route.activate !== 'function' ||
          typeof route.stop !== 'function' || typeof route.status !== 'function' ||
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
  let state: 'idle' | 'prepared' | 'active' | 'closed' = 'idle', busy = false;
  const ordered = plan.startupOrder.map(id => ({ member: members.get(id)!, route: byId.get(id)! }));
  const omission = () => Object.freeze(plan.startupOrder.filter(id => omitted.has(id)));
  function stop(reason = 'group-stopped'): void {
    if (state === 'closed') return;
    state = 'closed';
    for (const { route } of [...ordered].reverse()) {
      try { route.stop(reason); } catch { /* Continue releasing the remaining members. */ }
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
      return success(Object.freeze({ active: Object.freeze(plan.startupOrder.filter(id => !omitted.has(id))),
        omittedOptional: omission() }));
    } finally { busy = false; }
  }
  return Object.freeze({ plan, prepare, activate,
    start(): ReturnType<RouteGroupController['start']> {
      const ready = prepare();
      return ready.ok ? activate() : ready;
    },
    stop,
    status() { return Object.freeze({ state, omittedOptional: omission() }); },
  });
}
