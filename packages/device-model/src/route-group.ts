import { DeviceValidationError, parseDeviceDescriptor, snapshotJson } from './descriptor.ts';
import type { DeviceCapability, DeviceDescriptor, SignalValue } from './descriptor.ts';
import { parseSignalValue, schemasCompatible } from './sample.ts';

export interface RouteGroupEndpoint {
  readonly deviceId: string; readonly capability: string;
  readonly operation: 'read' | 'subscribe' | 'write' | 'invoke';
}
export interface RouteGroupMember {
  readonly id: string; readonly required: boolean;
  readonly from: Readonly<RouteGroupEndpoint>; readonly to: Readonly<RouteGroupEndpoint>;
  readonly startAfter: readonly string[];
  readonly consent: Readonly<{ purpose: string; sourceOwner: 'required'; sinkOwner: 'required' }>;
  readonly compensation: Readonly<{ prepared: 'release-grant'; active: 'stop-route'; physicalEffects: 'not-undone' }>;
  readonly safeState: Readonly<{ mode: 'provider-release' }> |
    Readonly<{ mode: 'authorized-command'; value: SignalValue; authority: 'fresh-owner-grant' }>;
}
export interface RouteGroupPlan {
  readonly id: string; readonly members: readonly RouteGroupMember[];
  readonly failure: Readonly<{ required: 'stop-all'; optional: 'continue-degraded' | 'stop-all' }>;
  readonly startupOrder: readonly string[];
  /** Declarations to request from resource owners; never grants. */
  readonly requiredOperations: readonly Readonly<{ member: string; side: 'source' | 'sink';
    deviceId: string; capability: string; operation: RouteGroupEndpoint['operation']; purpose: string }> [];
}

function fail(code: string, path: string): never { throw new DeviceValidationError(code, path); }
function object(input: unknown, path: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('route-group-object', path);
  return input as Record<string, unknown>;
}
function exact(input: Record<string, unknown>, keys: readonly string[], path: string): void {
  if (Object.keys(input).sort().join('\0') !== [...keys].sort().join('\0')) fail('route-group-fields', path);
}
function memberId(input: unknown, path: string): string {
  if (typeof input !== 'string' || input.length > 64 || !/^[a-z][a-z0-9-]*$/.test(input)) fail('route-group-member-id', path);
  return input as string;
}
function text(input: unknown, path: string): string {
  if (typeof input !== 'string' || !input.length || input.length > 160 || input.trim() !== input ||
      Array.from(input).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
    fail('route-group-text', path);
  return input as string;
}
function endpoint(input: unknown, side: 'from' | 'to', path: string,
  devices: ReadonlyMap<string, Readonly<DeviceDescriptor>>): { endpoint: Readonly<RouteGroupEndpoint>; capability: DeviceCapability } {
  const value = object(input, path);
  exact(value, ['deviceId', 'capability', 'operation'], path);
  const deviceId = text(value.deviceId, `${path}.deviceId`);
  const capabilityId = text(value.capability, `${path}.capability`);
  const device = devices.get(deviceId);
  if (!device) fail('route-group-device', `${path}.deviceId`);
  const capability = device.capabilities.find(item => item.id === capabilityId);
  if (!capability) fail('route-group-capability', `${path}.capability`);
  const operation = value.operation;
  if (side === 'from') {
    if (operation !== 'read' && operation !== 'subscribe' || !capability.permissions.includes(operation) ||
        operation === 'read' && (capability.kind !== 'property' || capability.delivery.mode !== 'latest'))
      fail('route-group-source-operation', `${path}.operation`);
  } else {
    const expected = capability.kind === 'command' || capability.kind === 'job' ? 'invoke' : 'write';
    if (operation !== expected || !capability.permissions.includes(expected)) fail('route-group-sink-operation', `${path}.operation`);
  }
  return { endpoint: Object.freeze({ deviceId, capability: capabilityId,
    operation: operation as RouteGroupEndpoint['operation'] }), capability };
}
function parseDevices(input: unknown): ReadonlyMap<string, Readonly<DeviceDescriptor>> {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length < 1 || input.length > 32)
    fail('route-group-devices', '$.devices');
  const devices = new Map<string, Readonly<DeviceDescriptor>>();
  for (let index = 0; index < input.length; index += 1) {
    const property = Object.getOwnPropertyDescriptor(input, String(index));
    if (!property || !Object.hasOwn(property, 'value')) fail('route-group-devices', `$.devices[${index}]`);
    const device = parseDeviceDescriptor(property.value);
    if (devices.has(device.id)) fail('route-group-duplicate-device', `$.devices[${index}]`);
    devices.set(device.id, device);
  }
  return devices;
}
function parseMember(input: unknown, path: string, devices: ReadonlyMap<string, Readonly<DeviceDescriptor>>): RouteGroupMember {
  const value = object(input, path);
  exact(value, ['id', 'required', 'from', 'to', 'startAfter', 'consent', 'compensation', 'safeState'], path);
  const id = memberId(value.id, `${path}.id`);
  if (typeof value.required !== 'boolean') fail('route-group-required', `${path}.required`);
  const from = endpoint(value.from, 'from', `${path}.from`, devices);
  const to = endpoint(value.to, 'to', `${path}.to`, devices);
  if (!schemasCompatible(from.capability, to.capability) ||
      from.capability.delivery.mode !== to.capability.delivery.mode) fail('route-group-incompatible', path);
  if (!Array.isArray(value.startAfter) || value.startAfter.length > 16) fail('route-group-start-after', `${path}.startAfter`);
  const startAfter = value.startAfter.map((item, index) => memberId(item, `${path}.startAfter[${index}]`));
  if (new Set(startAfter).size !== startAfter.length || startAfter.includes(id)) fail('route-group-start-after', `${path}.startAfter`);
  const consent = object(value.consent, `${path}.consent`);
  exact(consent, ['purpose', 'sourceOwner', 'sinkOwner'], `${path}.consent`);
  const purpose = text(consent.purpose, `${path}.consent.purpose`);
  if (consent.sourceOwner !== 'required' || consent.sinkOwner !== 'required') fail('route-group-consent', `${path}.consent`);
  const compensation = object(value.compensation, `${path}.compensation`);
  exact(compensation, ['prepared', 'active', 'physicalEffects'], `${path}.compensation`);
  if (compensation.prepared !== 'release-grant' || compensation.active !== 'stop-route' ||
      compensation.physicalEffects !== 'not-undone') fail('route-group-compensation', `${path}.compensation`);
  const safe = object(value.safeState, `${path}.safeState`);
  let safeState: RouteGroupMember['safeState'];
  if (safe.mode === 'provider-release') {
    exact(safe, ['mode'], `${path}.safeState`);
    safeState = Object.freeze({ mode: 'provider-release' });
  } else if (safe.mode === 'authorized-command') {
    exact(safe, ['mode', 'value', 'authority'], `${path}.safeState`);
    if (safe.authority !== 'fresh-owner-grant') fail('route-group-safe-authority', `${path}.safeState.authority`);
    if (to.capability.kind !== 'command' && to.capability.kind !== 'job')
      fail('route-group-safe-command', `${path}.safeState`);
    safeState = Object.freeze({ mode: 'authorized-command',
      value: parseSignalValue(safe.value, to.capability.value), authority: 'fresh-owner-grant' });
  } else fail('route-group-safe-state', `${path}.safeState.mode`);
  return Object.freeze({ id, required: value.required as boolean, from: from.endpoint, to: to.endpoint,
    startAfter: Object.freeze(startAfter), consent: Object.freeze({ purpose, sourceOwner: 'required', sinkOwner: 'required' }),
    compensation: Object.freeze({ prepared: 'release-grant', active: 'stop-route', physicalEffects: 'not-undone' }), safeState });
}

/** Validate an inert multi-route contract; startup, grants and physical effects belong to the host. */
export function planRouteGroup(input: unknown, deviceInputs: unknown): Readonly<RouteGroupPlan> {
  const value = object(snapshotJson(input), '$');
  exact(value, ['schemaVersion', 'id', 'members', 'failure'], '$');
  if (value.schemaVersion !== 1) fail('route-group-version', '$.schemaVersion');
  const id = text(value.id, '$.id');
  if (!/^[A-Za-z][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) fail('route-group-id', '$.id');
  if (!Array.isArray(value.members) || value.members.length < 1 || value.members.length > 16)
    fail('route-group-members', '$.members');
  const devices = parseDevices(deviceInputs);
  const members = Object.freeze(value.members.map((item, index) => parseMember(item, `$.members[${index}]`, devices)));
  const byId = new Map(members.map(member => [member.id, member]));
  if (byId.size !== members.length) fail('route-group-duplicate-member', '$.members');
  if (!members.some(member => member.required)) fail('route-group-no-required', '$.members');
  const failure = object(value.failure, '$.failure');
  exact(failure, ['required', 'optional'], '$.failure');
  if (failure.required !== 'stop-all' || failure.optional !== 'continue-degraded' && failure.optional !== 'stop-all')
    fail('route-group-failure', '$.failure');
  const successors = new Map(members.map(member => [member.id, [] as string[]]));
  const degree = new Map(members.map(member => [member.id, member.startAfter.length]));
  for (const member of members) for (const prerequisite of member.startAfter) {
    if (!byId.has(prerequisite)) fail('route-group-unknown-member', `$.members.${member.id}.startAfter`);
    successors.get(prerequisite)!.push(member.id);
  }
  const queue = members.filter(member => degree.get(member.id) === 0).map(member => member.id);
  const startupOrder: string[] = [];
  for (let at = 0; at < queue.length; at += 1) {
    const current = queue[at]!;
    startupOrder.push(current);
    for (const next of successors.get(current)!) {
      const remaining = degree.get(next)! - 1;
      degree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  if (startupOrder.length !== members.length) fail('route-group-cycle', '$.members');
  if (failure.optional === 'continue-degraded') for (const member of members.filter(item => item.required)) {
    const visited = new Set<string>(), pending = [...member.startAfter];
    for (let at = 0; at < pending.length; at += 1) {
      const prerequisite = pending[at]!;
      if (visited.has(prerequisite)) continue;
      visited.add(prerequisite);
      const dependency = byId.get(prerequisite)!;
      if (!dependency.required) fail('route-group-required-depends-on-optional', `$.members.${member.id}.startAfter`);
      pending.push(...dependency.startAfter);
    }
  }
  const routes = new Set<string>();
  for (const member of members) {
    const key = [member.from.deviceId, member.from.capability, member.to.deviceId, member.to.capability].join('\0');
    if (routes.has(key)) fail('route-group-duplicate-route', `$.members.${member.id}`);
    routes.add(key);
  }
  const requiredOperations = Object.freeze(members.flatMap(member => [
    Object.freeze({ member: member.id, side: 'source' as const, deviceId: member.from.deviceId,
      capability: member.from.capability, operation: member.from.operation, purpose: member.consent.purpose }),
    Object.freeze({ member: member.id, side: 'sink' as const, deviceId: member.to.deviceId,
      capability: member.to.capability, operation: member.to.operation, purpose: member.consent.purpose }),
  ]));
  return Object.freeze({ id, members, failure: Object.freeze({ required: 'stop-all', optional: failure.optional as 'continue-degraded' | 'stop-all' }),
    startupOrder: Object.freeze(startupOrder), requiredOperations });
}
