import { parseDeviceDescriptor, schemasCompatible } from '@101/device-model';
import type { DeviceCapability } from '@101/device-model';
import type { AuthorizationRequest, Connection, DeviceRuntime, EndpointHandle, ResourceReference, RouteGrant, RouteRequest } from './types.ts';

export const WORKSPACE_ADMINISTRATION_PROFILE = 'local-workspace-administration/1';
export const WORKSPACE_ADMINISTRATION_LIMITS = Object.freeze({ members: 16, administrators: 2, resources: 16, sharing: 16, routes: 16,
  changes: 64, routeAttempts: 64, authorizations: 64, audit: 64, snapshotBytes: 32768, approvalMs: 30000, leaseMs: 1000, maxHz: 30, maxAgeMs: 1000 });
export type WorkspaceRole = 'administrator' | 'participant' | 'observer';
export type WorkspaceAdministrationFailure = 'invalid' | 'denied' | 'stale' | 'busy' | 'capacity' | 'expired' | 'closed' | 'invalid-clock';
export type WorkspaceAdministrationResult<T = undefined> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: WorkspaceAdministrationFailure }>;
export interface WorkspaceSharingRule {
  readonly id: string; readonly principalId: string; readonly applicationId: string; readonly sessionId: string;
  readonly sourceId: string; readonly sinkId: string; readonly sourceOperation: 'read' | 'subscribe'; readonly sinkOperation: 'write' | 'invoke';
  readonly partition?: string; readonly expiresAt: number; readonly maxHz: number; readonly maxAgeMs: number;
}
export type WorkspaceAdministrationChange =
  | Readonly<{ type: 'add-member'; principalId: string; role: WorkspaceRole }>
  | Readonly<{ type: 'set-role'; principalId: string; role: WorkspaceRole }>
  | Readonly<{ type: 'remove-member'; principalId: string }>
  | Readonly<{ type: 'set-sharing'; rule: WorkspaceSharingRule }>
  | Readonly<{ type: 'revoke-sharing'; ruleId: string }>;
export interface WorkspaceAdministrationRequest {
  readonly profile: typeof WORKSPACE_ADMINISTRATION_PROFILE; readonly workspaceId: string; readonly ownerPrincipalId: string;
  readonly actorId: string; readonly action: 'create' | 'change' | 'inspect' | 'audit'; readonly expectedRevision: number;
  readonly change?: WorkspaceAdministrationChange;
}
/** The host authenticates the actor and binds this exact request. Mutable revocation is the real native signal. */
export interface WorkspaceAdministrationApproval { readonly request: WorkspaceAdministrationRequest; readonly expiresAt: number; readonly signal: AbortSignal }
export interface WorkspaceResource {
  readonly id: string; readonly ownerId: string; readonly handle: EndpointHandle; readonly device: unknown; readonly capability: string;
  /** Trusted host output classification; only an observe-owned property can be declared here. */
  readonly observerOutput?: boolean;
}
export interface WorkspaceResourceApprovalRequest {
  readonly workspaceId: string; readonly ownerId: string; readonly side: 'source' | 'sink'; readonly route: Readonly<AuthorizationRequest>;
}
export interface WorkspaceResourceApproval {
  readonly request: WorkspaceResourceApprovalRequest; readonly expiresAt: number; readonly maxHz: number; readonly maxAgeMs: number; readonly signal: AbortSignal;
}
export interface WorkspaceAuditEvent {
  readonly revision: number; readonly at: number; readonly actorId: string; readonly action: 'create' | 'change'; readonly change?: WorkspaceAdministrationChange;
}
export interface WorkspaceAdministrationSnapshot {
  readonly profile: typeof WORKSPACE_ADMINISTRATION_PROFILE; readonly workspaceId: string; readonly ownerPrincipalId: string; readonly revision: number;
  readonly members: readonly Readonly<{ principalId: string; role: WorkspaceRole }>[]; readonly sharing: readonly WorkspaceSharingRule[];
}
export interface WorkspaceAdministrationOptions {
  readonly workspaceId: string; readonly ownerPrincipalId: string; readonly resources: readonly WorkspaceResource[]; readonly now: () => number;
  readonly authorizeAdministration: (request: WorkspaceAdministrationRequest) => WorkspaceAdministrationApproval | undefined;
  readonly authorizeSource: (request: WorkspaceResourceApprovalRequest) => WorkspaceResourceApproval | undefined;
  readonly authorizeSink: (request: WorkspaceResourceApprovalRequest) => WorkspaceResourceApproval | undefined;
}
export interface WorkspaceAdministrationController {
  create(actorId: string): WorkspaceAdministrationResult;
  change(actorId: string, expectedRevision: number, change: WorkspaceAdministrationChange): WorkspaceAdministrationResult;
  inspect(actorId: string): WorkspaceAdministrationResult<WorkspaceAdministrationSnapshot>;
  audit(actorId: string): WorkspaceAdministrationResult<readonly WorkspaceAuditEvent[]>;
  /** Compose only with a trusted host that routes exclusively through this controller. This request has no route handle. */
  authorizeRoute(request: Readonly<AuthorizationRequest>): RouteGrant | undefined;
  route(runtime: Pick<DeviceRuntime, 'route' | 'revoke'>, request: RouteRequest): WorkspaceAdministrationResult<Connection>;
  close(): void;
}
interface Resource { id: string; ownerId: string; handle: EndpointHandle; reference: ResourceReference; capability: DeviceCapability; observerOutput: boolean }
interface State { revision: number; members: readonly Readonly<{ principalId: string; role: WorkspaceRole }>[]; sharing: readonly WorkspaceSharingRule[];
  audit: readonly WorkspaceAuditEvent[] }
interface Managed {
  request: Readonly<RouteRequest>; authorization: Readonly<AuthorizationRequest>; rule: WorkspaceSharingRule; role: WorkspaceRole | 'owner';
  source: Resource; sink: Resource; connection?: Connection; revoke?: (connection: Connection) => void; remove?: () => void;
  retired: boolean; revoked: boolean; removers: Array<() => void>; timer?: ReturnType<typeof setTimeout>;
}
class Failure extends Error { readonly reason: WorkspaceAdministrationFailure; constructor(reason: WorkspaceAdministrationFailure) { super(reason); this.reason = reason; } }
function reject(reason: WorkspaceAdministrationFailure): never { throw new Failure(reason); }
const yes = <T = undefined>(value: T = undefined as T): WorkspaceAdministrationResult<T> => Object.freeze({ ok: true, value });
const no = (reason: WorkspaceAdministrationFailure): WorkspaceAdministrationResult<never> => Object.freeze({ ok: false, reason });
const abortRead = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const addEvent = EventTarget.prototype.addEventListener, removeEvent = EventTarget.prototype.removeEventListener;
const armTimer = setTimeout, disarmTimer = clearTimeout;
function aborted(signal: unknown): boolean { try { return abortRead.call(signal) as boolean; } catch { return true; } }
function signal(input: unknown): AbortSignal { if (aborted(input)) reject('denied'); return input as AbortSignal; }
function fields(input: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) reject('invalid');
  const keys = Reflect.ownKeys(input);
  if (keys.length > required.length + optional.length || keys.some(key => typeof key !== 'string' || !required.includes(key) && !optional.includes(key))) reject('invalid');
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys as string[]) {
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (!property || !property.enumerable || !Object.hasOwn(property, 'value')) reject('invalid');
    result[key] = property.value;
  }
  if (required.some(key => !Object.hasOwn(result, key))) reject('invalid');
  return result;
}
function identity(input: unknown): string {
  if (typeof input !== 'string' || !input.length || input.length > 128 || input.trim() !== input || [...input].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) reject('invalid');
  return input;
}
function number(input: unknown, min: number, max: number): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < min || input > max) reject('invalid'); return input;
}
function integer(input: unknown, min: number, max: number): number { const value = number(input, min, max); if (!Number.isInteger(value)) reject('invalid'); return value; }
function role(input: unknown): WorkspaceRole {
  if (input !== 'administrator' && input !== 'participant' && input !== 'observer') reject('invalid'); return input;
}
function dense(input: unknown, max: number): readonly unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) reject('invalid');
  const length = Object.getOwnPropertyDescriptor(input, 'length')?.value as unknown;
  integer(length, 0, max); const keys = Reflect.ownKeys(input);
  if (keys.length !== (length as number) + 1) reject('invalid');
  const result = [];
  for (let index = 0; index < (length as number); index++) {
    const property = Object.getOwnPropertyDescriptor(input, String(index));
    if (!property || !property.enumerable || !Object.hasOwn(property, 'value')) reject('invalid'); result.push(property.value as unknown);
  }
  return result;
}
function reference(input: unknown): ResourceReference {
  const value = fields(input, ['registrationId', 'deviceId', 'capabilityId', 'descriptorRevision', 'schemaVersion']);
  return Object.freeze({ registrationId: identity(value.registrationId), deviceId: identity(value.deviceId), capabilityId: identity(value.capabilityId),
    descriptorRevision: integer(value.descriptorRevision, 1, Number.MAX_SAFE_INTEGER), schemaVersion: integer(value.schemaVersion, 1, Number.MAX_SAFE_INTEGER) });
}
function sameReference(a: ResourceReference, b: ResourceReference): boolean {
  return a.registrationId === b.registrationId && a.deviceId === b.deviceId && a.capabilityId === b.capabilityId &&
    a.descriptorRevision === b.descriptorRevision && a.schemaVersion === b.schemaVersion;
}
function authorization(input: unknown): Readonly<AuthorizationRequest> {
  const value = fields(input, ['principalId', 'applicationId', 'sessionId', 'source', 'sink', 'sourceOperation', 'sinkOperation'], ['partition']);
  if (value.sourceOperation !== 'read' && value.sourceOperation !== 'subscribe' || value.sinkOperation !== 'write' && value.sinkOperation !== 'invoke') reject('invalid');
  return Object.freeze({ principalId: identity(value.principalId), applicationId: identity(value.applicationId), sessionId: identity(value.sessionId),
    source: reference(value.source), sink: reference(value.sink), sourceOperation: value.sourceOperation, sinkOperation: value.sinkOperation,
    ...(Object.hasOwn(value, 'partition') ? { partition: identity(value.partition) } : {}) });
}
function sameAuthorization(a: AuthorizationRequest, b: AuthorizationRequest): boolean {
  return a.principalId === b.principalId && a.applicationId === b.applicationId && a.sessionId === b.sessionId && a.sourceOperation === b.sourceOperation &&
    a.sinkOperation === b.sinkOperation && a.partition === b.partition && sameReference(a.source, b.source) && sameReference(a.sink, b.sink);
}
function parseRule(input: unknown): WorkspaceSharingRule {
  const value = fields(input, ['id', 'principalId', 'applicationId', 'sessionId', 'sourceId', 'sinkId', 'sourceOperation', 'sinkOperation', 'expiresAt', 'maxHz', 'maxAgeMs'], ['partition']);
  if (value.sourceOperation !== 'read' && value.sourceOperation !== 'subscribe' || value.sinkOperation !== 'write' && value.sinkOperation !== 'invoke') reject('invalid');
  return Object.freeze({ id: identity(value.id), principalId: identity(value.principalId), applicationId: identity(value.applicationId), sessionId: identity(value.sessionId),
    sourceId: identity(value.sourceId), sinkId: identity(value.sinkId), sourceOperation: value.sourceOperation, sinkOperation: value.sinkOperation,
    expiresAt: number(value.expiresAt, 0, Number.MAX_SAFE_INTEGER), maxHz: number(value.maxHz, 1, WORKSPACE_ADMINISTRATION_LIMITS.maxHz),
    maxAgeMs: number(value.maxAgeMs, 1, WORKSPACE_ADMINISTRATION_LIMITS.maxAgeMs), ...(Object.hasOwn(value, 'partition') ? { partition: identity(value.partition) } : {}) });
}
function parseChange(input: unknown): WorkspaceAdministrationChange {
  const head = fields(input, ['type'], ['principalId', 'role', 'rule', 'ruleId']);
  if (head.type === 'add-member' || head.type === 'set-role') {
    const value = fields(input, ['type', 'principalId', 'role']); return Object.freeze({ type: head.type, principalId: identity(value.principalId), role: role(value.role) });
  }
  if (head.type === 'remove-member') { const value = fields(input, ['type', 'principalId']); return Object.freeze({ type: head.type, principalId: identity(value.principalId) }); }
  if (head.type === 'set-sharing') { const value = fields(input, ['type', 'rule']); return Object.freeze({ type: head.type, rule: parseRule(value.rule) }); }
  if (head.type === 'revoke-sharing') { const value = fields(input, ['type', 'ruleId']); return Object.freeze({ type: head.type, ruleId: identity(value.ruleId) }); }
  reject('invalid');
}

/** Ephemeral cooperative host administration. Inert membership/policy never replaces either device owner's consent. */
export function createWorkspaceAdministration(options: WorkspaceAdministrationOptions): WorkspaceAdministrationController {
  const input = fields(options, ['workspaceId', 'ownerPrincipalId', 'resources', 'now', 'authorizeAdministration', 'authorizeSource', 'authorizeSink']);
  const workspaceId = identity(input.workspaceId), ownerPrincipalId = identity(input.ownerPrincipalId);
  if (typeof input.now !== 'function' || typeof input.authorizeAdministration !== 'function' || typeof input.authorizeSource !== 'function' || typeof input.authorizeSink !== 'function') reject('invalid');
  const now = input.now as () => number, approveAdministration = input.authorizeAdministration as WorkspaceAdministrationOptions['authorizeAdministration'],
    approveSource = input.authorizeSource as WorkspaceAdministrationOptions['authorizeSource'], approveSink = input.authorizeSink as WorkspaceAdministrationOptions['authorizeSink'];
  const resources = new Map<string, Resource>(), handles = new Set<EndpointHandle>();
  for (const item of dense(input.resources, WORKSPACE_ADMINISTRATION_LIMITS.resources)) {
    const value = fields(item, ['id', 'ownerId', 'handle', 'device', 'capability'], ['observerOutput']);
    const device = parseDeviceDescriptor(value.device), id = identity(value.id), ownerId = identity(value.ownerId), capabilityId = identity(value.capability);
    const capability = device.capabilities.find(entry => entry.id === capabilityId);
    if (!value.handle || typeof value.handle !== 'object' || !capability || Object.hasOwn(value, 'observerOutput') && typeof value.observerOutput !== 'boolean') reject('invalid');
    const handle = value.handle as EndpointHandle, property = Object.getOwnPropertyDescriptor(handle, 'id');
    if (!property || !Object.hasOwn(property, 'value')) reject('invalid');
    const registrationId = identity(property.value), observerOutput = value.observerOutput === true;
    if (observerOutput && (capability.kind !== 'property' || capability.ownership?.mode !== 'observe' || !capability.permissions.includes('write'))) reject('invalid');
    if (resources.has(id) || handles.has(handle) || [...resources.values()].some(entry => entry.reference.registrationId === registrationId)) reject('invalid');
    handles.add(handle); resources.set(id, { id, ownerId, handle, capability, observerOutput, reference: Object.freeze({ registrationId,
      deviceId: device.id, capabilityId: capability.id, descriptorRevision: device.revision, schemaVersion: capability.schemaVersion }) });
  }
  let state: State = { revision: 0, members: Object.freeze([]), sharing: Object.freeze([]), audit: Object.freeze([]) };
  let closed = false, busy = false, clockReading = false, epoch = 0, lastAt = -Infinity, mutations = 0, routeAttempts = 0, authorizations = 0, authorizationBusy = false;
  const managed = new Set<Managed>();
  function clearAuthority(entry: Managed): void {
    if (entry.timer !== undefined) disarmTimer(entry.timer); entry.timer = undefined;
    for (const remove of entry.removers.splice(0)) try { remove(); } catch { /* Removed authority remains unusable. */ }
  }
  function retire(entry: Managed): void {
    if (!entry.retired) { entry.retired = true; managed.delete(entry); }
    clearAuthority(entry); const remove = entry.remove; entry.remove = undefined; try { remove?.(); } catch { /* Terminal observer. */ }
    if (!entry.connection || entry.revoked) return;
    entry.revoked = true;
    try { entry.revoke?.(entry.connection); } catch { /* Still stop the returned public handle. */ }
    try { entry.connection.stop('workspace-authority-lost'); } catch { /* Trusted runtime failure cannot restore policy. */ }
  }
  function close(): void { if (closed) return; closed = true; epoch++; for (const entry of [...managed]) retire(entry); }
  function time(): number {
    if (closed) reject('closed'); if (clockReading) reject('busy');
    const selected = epoch; clockReading = true; let value: unknown;
    try { value = now(); } catch { close(); reject('invalid-clock'); } finally { clockReading = false; }
    if (closed || selected !== epoch) reject('closed');
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER || value < lastAt) { close(); reject('invalid-clock'); }
    lastAt = value; return value;
  }
  function memberRole(principalId: string): WorkspaceRole | 'owner' | undefined { return principalId === ownerPrincipalId ? 'owner' : state.members.find(entry => entry.principalId === principalId)?.role; }
  function permitted(rule: WorkspaceSharingRule, selectedRole: WorkspaceRole | 'owner' | undefined): boolean {
    const source = resources.get(rule.sourceId), sink = resources.get(rule.sinkId);
    if (!selectedRole || !source || !sink || source === sink || !source.capability.permissions.includes(rule.sourceOperation) || !sink.capability.permissions.includes(rule.sinkOperation) ||
      (rule.sourceOperation === 'read' && (source.capability.kind !== 'property' || source.capability.delivery.mode !== 'latest')) ||
      rule.sinkOperation !== (sink.capability.kind === 'command' || sink.capability.kind === 'job' ? 'invoke' : 'write') ||
      !schemasCompatible(source.capability, sink.capability) || source.capability.delivery.mode !== sink.capability.delivery.mode) return false;
    const ownership = sink.capability.ownership;
    if (ownership?.mode === 'partitioned' ? rule.partition === undefined || !ownership.partitions.includes(rule.partition) : rule.partition !== undefined) return false;
    return selectedRole !== 'observer' || sink.observerOutput && rule.sinkOperation === 'write';
  }
  function current(entry: Managed, at: number): boolean {
    return !closed && !entry.retired && managed.has(entry) && !!entry.rule && !!entry.request && entry.rule.expiresAt > at && state.sharing.includes(entry.rule) &&
      memberRole(entry.request.principalId) === entry.role && permitted(entry.rule, entry.role);
  }
  function sweep(at: number): void { for (const entry of [...managed]) if (!current(entry, at)) retire(entry); }
  function snapshot(selected: State = state): WorkspaceAdministrationSnapshot {
    return Object.freeze({ profile: WORKSPACE_ADMINISTRATION_PROFILE, workspaceId, ownerPrincipalId, revision: selected.revision, members: selected.members, sharing: selected.sharing });
  }
  function budget(selected: State): void {
    if (selected.members.length > WORKSPACE_ADMINISTRATION_LIMITS.members || selected.members.filter(entry => entry.role === 'administrator').length > WORKSPACE_ADMINISTRATION_LIMITS.administrators ||
      selected.sharing.length > WORKSPACE_ADMINISTRATION_LIMITS.sharing || selected.audit.length > WORKSPACE_ADMINISTRATION_LIMITS.audit ||
      new TextEncoder().encode(JSON.stringify({ snapshot: snapshot(selected), audit: selected.audit })).length > WORKSPACE_ADMINISTRATION_LIMITS.snapshotBytes) reject('capacity');
  }
  function actorApproval(request: WorkspaceAdministrationRequest, at: number): WorkspaceAdministrationApproval {
    let result: unknown; try { result = approveAdministration(request); } catch { reject('denied'); }
    let value: Record<string, unknown>; try { value = fields(result, ['request', 'expiresAt', 'signal']); } catch { reject('denied'); }
    if (value.request !== request || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) || value.expiresAt <= at || value.expiresAt > at + WORKSPACE_ADMINISTRATION_LIMITS.approvalMs) reject('denied');
    return { request, expiresAt: value.expiresAt, signal: signal(value.signal) };
  }
  function operation<T>(run: (selectedEpoch: number) => WorkspaceAdministrationResult<T>): WorkspaceAdministrationResult<T> {
    if (closed) return no('closed'); if (busy || clockReading) return no('busy'); busy = true; const selected = epoch;
    try { return run(selected); } catch (error) { return no(error instanceof Failure ? error.reason : 'invalid'); } finally { busy = false; }
  }
  function request(actorId: string, action: WorkspaceAdministrationRequest['action'], expectedRevision: number, change?: WorkspaceAdministrationChange): WorkspaceAdministrationRequest {
    return Object.freeze({ profile: WORKSPACE_ADMINISTRATION_PROFILE, workspaceId, ownerPrincipalId, actorId, action, expectedRevision, ...(change === undefined ? {} : { change }) });
  }
  function admin(actorId: string): boolean { return actorId === ownerPrincipalId || memberRole(actorId) === 'administrator'; }
  function finalActor(selected: number, revision: number, grant: WorkspaceAdministrationApproval): number {
    const at = time(); if (closed || epoch !== selected) reject('closed'); if (state.revision !== revision) reject('stale');
    if (at >= grant.expiresAt || aborted(grant.signal)) reject('denied'); return at;
  }
  function candidate(actorId: string, change: WorkspaceAdministrationChange, at: number): Pick<State, 'members' | 'sharing'> {
    if (!admin(actorId)) reject('denied'); let members = [...state.members], sharing = [...state.sharing];
    if (change.type === 'add-member' || change.type === 'set-role' || change.type === 'remove-member') {
      if (change.principalId === ownerPrincipalId) reject('denied');
      const existing = members.find(entry => entry.principalId === change.principalId);
      if (actorId !== ownerPrincipalId && (existing?.role === 'administrator' || change.type !== 'remove-member' && change.role === 'administrator')) reject('denied');
      if (change.type === 'add-member') { if (existing) reject('stale'); members.push(Object.freeze({ principalId: change.principalId, role: change.role })); }
      else {
        if (!existing) reject('stale'); members = members.filter(entry => entry !== existing);
        if (change.type === 'set-role') members.push(Object.freeze({ principalId: change.principalId, role: change.role }));
        else sharing = sharing.filter(rule => rule.principalId !== change.principalId);
      }
    } else if (change.type === 'set-sharing') {
      const rule = change.rule;
      if (rule.expiresAt <= at || rule.expiresAt > at + WORKSPACE_ADMINISTRATION_LIMITS.approvalMs) reject('expired');
      if (!permitted(rule, memberRole(rule.principalId))) reject('denied');
      sharing = sharing.filter(entry => entry.id !== rule.id);
      if (sharing.some(entry => entry.principalId === rule.principalId && entry.applicationId === rule.applicationId && entry.sessionId === rule.sessionId &&
        entry.sourceId === rule.sourceId && entry.sinkId === rule.sinkId && entry.sourceOperation === rule.sourceOperation && entry.sinkOperation === rule.sinkOperation && entry.partition === rule.partition)) reject('invalid');
      sharing.push(rule);
    } else {
      if (!sharing.some(entry => entry.id === change.ruleId)) reject('stale'); sharing = sharing.filter(entry => entry.id !== change.ruleId);
    }
    return { members: Object.freeze(members.sort((a, b) => a.principalId.localeCompare(b.principalId))), sharing: Object.freeze(sharing.sort((a, b) => a.id.localeCompare(b.id))) };
  }
  function create(actorInput: string): WorkspaceAdministrationResult {
    return operation(selected => {
      const actorId = identity(actorInput); if (actorId !== ownerPrincipalId) reject('denied'); if (state.revision !== 0) reject('stale');
      if (mutations >= WORKSPACE_ADMINISTRATION_LIMITS.changes) reject('capacity'); mutations++;
      const at = time(), grant = actorApproval(request(actorId, 'create', 0), at), finalAt = finalActor(selected, 0, grant);
      const next: State = { revision: 1, members: state.members, sharing: state.sharing,
        audit: Object.freeze([Object.freeze({ revision: 1, at: finalAt, actorId, action: 'create' as const })]) }; budget(next); state = next; return yes();
    });
  }
  function change(actorInput: string, revisionInput: number, changeInput: WorkspaceAdministrationChange): WorkspaceAdministrationResult {
    return operation(selected => {
      const actorId = identity(actorInput), revision = integer(revisionInput, 1, WORKSPACE_ADMINISTRATION_LIMITS.changes), change = parseChange(changeInput);
      if (!state.revision || !admin(actorId)) reject('denied'); if (revision !== state.revision) reject('stale');
      if (mutations >= WORKSPACE_ADMINISTRATION_LIMITS.changes) reject('capacity'); mutations++;
      const at = time(), values = candidate(actorId, change, at);
      const audit = Object.freeze([...state.audit, Object.freeze({ revision: revision + 1, at, actorId, action: 'change' as const, change })]);
      const next: State = { revision: revision + 1, ...values, audit }; budget(next);
      const grant = actorApproval(request(actorId, 'change', revision, change), at), finalAt = finalActor(selected, revision, grant);
      if (change.type === 'set-sharing' && change.rule.expiresAt <= finalAt) reject('expired');
      // No callouts between the final signal fence and the immutable membership/policy/audit commit.
      state = next; sweep(lastAt); return yes();
    });
  }
  function read<T>(actorInput: string, action: 'inspect' | 'audit', pick: () => T): WorkspaceAdministrationResult<T> {
    return operation(selected => {
      const actorId = identity(actorInput); if (!state.revision || !admin(actorId)) reject('denied');
      const revision = state.revision, at = time(), grant = actorApproval(request(actorId, action, revision), at); finalActor(selected, revision, grant); sweep(lastAt);
      if (closed || selected !== epoch || state.revision !== revision || aborted(grant.signal) || lastAt >= grant.expiresAt) reject('closed'); return yes(pick());
    });
  }
  function route(runtime: Pick<DeviceRuntime, 'route' | 'revoke'>, routeInput: RouteRequest): WorkspaceAdministrationResult<Connection> {
    if (closed) return no('closed'); if (clockReading) return no('busy');
    if (managed.size >= WORKSPACE_ADMINISTRATION_LIMITS.routes || routeAttempts >= WORKSPACE_ADMINISTRATION_LIMITS.routeAttempts) return no('capacity');
    // Reserve capacity before parsing plain input or reading/calling a trusted runtime port.
    const entry = { retired: false, revoked: false, removers: [] } as unknown as Managed; managed.add(entry); routeAttempts++;
    try {
      const value = fields(routeInput, ['from', 'to', 'principalId', 'applicationId', 'sessionId'], ['sourceOperation', 'partition', 'leaseMs', 'queueCapacity', 'constraints']);
      const principalId = identity(value.principalId), applicationId = identity(value.applicationId), sessionId = identity(value.sessionId), selectedRole = memberRole(principalId);
      const source = [...resources.values()].find(resource => resource.handle === value.from), sink = [...resources.values()].find(resource => resource.handle === value.to);
      const sourceOperation = value.sourceOperation ?? 'subscribe', sinkOperation = sink?.capability.kind === 'command' || sink?.capability.kind === 'job' ? 'invoke' : 'write';
      const partition = Object.hasOwn(value, 'partition') ? identity(value.partition) : undefined;
      if (sourceOperation !== 'read' && sourceOperation !== 'subscribe') reject('invalid');
      const queueCapacity = integer(value.queueCapacity ?? 1, 1, 1), leaseMs = integer(value.leaseMs ?? 1000, 1, WORKSPACE_ADMINISTRATION_LIMITS.leaseMs);
      if (!state.revision || !selectedRole || !source || !sink) reject('denied');
      const rule = state.sharing.find(rule => rule.principalId === principalId && rule.applicationId === applicationId && rule.sessionId === sessionId &&
        rule.sourceId === source.id && rule.sinkId === sink.id && rule.sourceOperation === sourceOperation && rule.sinkOperation === sinkOperation && rule.partition === partition);
      if (!rule || !permitted(rule, selectedRole)) reject('denied');
      let constraints: RouteGrant | undefined;
      if (Object.hasOwn(value, 'constraints')) { const input = fields(value.constraints, ['expiresAt', 'maxAgeMs'], ['maxHz']);
        constraints = Object.freeze({ expiresAt: number(input.expiresAt, 0, Number.MAX_SAFE_INTEGER), maxAgeMs: number(input.maxAgeMs, 1, 1000),
          ...(Object.hasOwn(input, 'maxHz') ? { maxHz: number(input.maxHz, 1, 30) } : {}) }); }
      entry.source = source; entry.sink = sink; entry.rule = rule; entry.role = selectedRole;
      entry.request = Object.freeze({ from: source.handle, to: sink.handle, principalId, applicationId, sessionId, sourceOperation, queueCapacity, leaseMs,
        ...(partition === undefined ? {} : { partition }), ...(constraints === undefined ? {} : { constraints }) });
      entry.authorization = Object.freeze({ principalId, applicationId, sessionId, source: source.reference, sink: sink.reference, sourceOperation, sinkOperation,
        ...(partition === undefined ? {} : { partition }) });
      const at = time(); sweep(at); if (!current(entry, at)) reject(closed ? 'closed' : 'expired');
      // The public authorization request has no route id. Reserve exactly one live tuple, including entries whose handle has not returned yet.
      if ([...managed].some(other => other !== entry && !other.retired && other.authorization && sameAuthorization(other.authorization, entry.authorization))) reject('busy');
      const routeMethod = runtime.route, revokeMethod = runtime.revoke; if (typeof routeMethod !== 'function' || typeof revokeMethod !== 'function') reject('invalid');
      entry.revoke = connection => revokeMethod.call(runtime, connection);
      if (!current(entry, lastAt)) reject(closed ? 'closed' : 'stale');
      entry.connection = routeMethod.call(runtime, entry.request);
      const after = time(); if (!current(entry, after)) { retire(entry); reject(closed ? 'closed' : 'stale'); }
      const remove = entry.connection.onClose(() => retire(entry));
      if (typeof remove !== 'function') reject('invalid'); entry.remove = remove;
      if (!current(entry, lastAt)) { retire(entry); reject(closed ? 'closed' : 'stale'); }
      entry.timer = armTimer(() => retire(entry), Math.max(1, rule.expiresAt - after));
      return yes(entry.connection);
    } catch (error) { retire(entry); return no(error instanceof Failure ? error.reason : 'invalid'); }
  }
  function resourceApproval(request: WorkspaceResourceApprovalRequest, approve: WorkspaceAdministrationOptions['authorizeSource'], at: number): WorkspaceResourceApproval {
    let result: unknown; try { result = approve(request); } catch { reject('denied'); }
    let value: Record<string, unknown>; try { value = fields(result, ['request', 'expiresAt', 'maxHz', 'maxAgeMs', 'signal']); } catch { reject('denied'); }
    if (value.request !== request || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) || value.expiresAt <= at || value.expiresAt > at + WORKSPACE_ADMINISTRATION_LIMITS.approvalMs ||
      typeof value.maxHz !== 'number' || !Number.isFinite(value.maxHz) || value.maxHz < 1 || value.maxHz > 30 || typeof value.maxAgeMs !== 'number' || !Number.isFinite(value.maxAgeMs) || value.maxAgeMs < 1 || value.maxAgeMs > 1000) reject('denied');
    return { request, expiresAt: value.expiresAt, maxHz: value.maxHz, maxAgeMs: value.maxAgeMs, signal: signal(value.signal) };
  }
  function authorizeRoute(routeInput: Readonly<AuthorizationRequest>): RouteGrant | undefined {
    if (closed || authorizationBusy || clockReading || authorizations >= WORKSPACE_ADMINISTRATION_LIMITS.authorizations) return;
    authorizationBusy = true; authorizations++;
    try {
      const actual = authorization(routeInput), entry = [...managed].find(entry => entry.connection && !entry.retired && sameAuthorization(entry.authorization, actual));
      if (!entry) return; const at = time(); sweep(at); if (!current(entry, at)) return;
      const sourceRequest = Object.freeze({ workspaceId, ownerId: entry.source.ownerId, side: 'source' as const, route: actual });
      const sinkRequest = Object.freeze({ workspaceId, ownerId: entry.sink.ownerId, side: 'sink' as const, route: actual });
      const source = resourceApproval(sourceRequest, approveSource, at);
      if (!current(entry, lastAt) || aborted(source.signal)) return;
      const sink = resourceApproval(sinkRequest, approveSink, at), finalAt = time();
      const expiresAt = Math.min(entry.rule.expiresAt, source.expiresAt, sink.expiresAt);
      if (!current(entry, finalAt) || expiresAt <= finalAt || aborted(source.signal) || aborted(sink.signal)) return;
      clearAuthority(entry);
      for (const grant of [source, sink]) {
        const listener = () => retire(entry); addEvent.call(grant.signal, 'abort', listener, { once: true });
        entry.removers.push(() => removeEvent.call(grant.signal, 'abort', listener));
      }
      entry.timer = armTimer(() => retire(entry), Math.max(1, expiresAt - finalAt));
      if (!current(entry, finalAt) || aborted(source.signal) || aborted(sink.signal)) { retire(entry); return; }
      return Object.freeze({ expiresAt, maxHz: Math.min(entry.rule.maxHz, source.maxHz, sink.maxHz), maxAgeMs: Math.min(entry.rule.maxAgeMs, source.maxAgeMs, sink.maxAgeMs) });
    } catch { return; } finally { authorizationBusy = false; }
  }
  return Object.freeze({ create, change, inspect: (actorId: string) => read(actorId, 'inspect', () => snapshot()),
    audit: (actorId: string) => read(actorId, 'audit', () => state.audit), route, authorizeRoute, close });
}
