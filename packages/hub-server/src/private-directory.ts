import { parseDeviceDescriptor, snapshotJson, parsePrivateDirectorySnapshot, PRIVATE_DIRECTORY_PROFILE, PRIVATE_DIRECTORY_LIMITS } from '@101/device-model';
import type { DeviceDescriptor, PrivateDirectoryResource, PrivateDirectorySnapshot } from '@101/device-model';
import { createCoordinatorFetcher } from './https-coordinator.ts';
import type { CoordinatorFetcherOptions } from './https-coordinator.ts';

/** Provisioned host configuration, never an identity claim accepted from HTTP input. */
export interface ProvisionedDirectoryResource {
  readonly principalId: string; readonly deviceId: string; readonly descriptor: DeviceDescriptor; readonly capabilityIds: readonly string[];
}
export interface PrivateDirectoryClientOptions extends CoordinatorFetcherOptions {
  readonly sessionId: string; readonly role: 'host' | 'peer'; readonly token: string; readonly peerId?: string;
}
interface ProjectedResource { readonly principalId: string; readonly deviceId: string; readonly resource: Omit<PrivateDirectoryResource, 'expiresAt'>; }
interface MemberVisibility { readonly resourceIds: readonly string[]; readonly expiresAt: number; readonly generation: number; }
interface DirectoryState { readonly resources: Map<string, { resource: ProjectedResource; expiresAt: number }>; readonly members: Map<string, MemberVisibility>; }
/** Only the coordinator constructs this after native TLS, enrollment, principal, role and bearer checks. */
export interface CoordinatorDirectoryAuthority {
  readonly sessionId: string; readonly principalId: string; readonly deviceId: string; readonly role: 'host' | 'peer';
  readonly peerId?: string; readonly generation: number; readonly expiresAt: number; readonly now: number;
  readonly peers: ReadonlyMap<string, number>; readonly current: () => boolean;
}
export class DirectoryRejection extends Error {
  readonly status: number;
  constructor(status: number) { super('Directory request rejected'); this.status = status; }
}
function reject(status = 400): never { throw new DirectoryRejection(status); }
function ownData(input: unknown, fields: readonly string[], required: readonly string[] = fields): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Object.getOwnPropertySymbols(input).length) reject();
  const output: Record<string, unknown> = Object.create(null);
  for (const [key, property] of Object.entries(Object.getOwnPropertyDescriptors(input))) {
    if (!fields.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value')) reject();
    output[key] = property.value;
  }
  if (required.some(key => !Object.hasOwn(output, key))) reject();
  return output;
}
function identifier(input: unknown): string {
  if (typeof input !== 'string' || input.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input)) reject(); return input;
}
function timestamp(input: unknown): number { if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0) reject(); return input; }
function strings(input: unknown, count: number): readonly string[] {
  const copy = snapshotJson(input);
  if (!Array.isArray(copy) || copy.length > count) reject();
  const values = copy.map(identifier); if (new Set(values).size !== values.length) reject(); return Object.freeze(values);
}

/** Internal session state; no HTTP identity or authority is derived here. It is deliberately not a public barrel export. */
export function createCoordinatorDirectory(input: unknown, enrollments: readonly { principalId: string; deviceId: string }[]) {
  const catalog = new Map<string, ProjectedResource>();
  if (input !== undefined) {
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > PRIVATE_DIRECTORY_LIMITS.catalogResources) reject();
    const properties = Object.getOwnPropertyDescriptors(input);
    if (Object.getOwnPropertySymbols(input).length || Object.keys(properties).length !== input.length + 1) reject();
    for (let index = 0; index < input.length; index++) {
      const property = properties[String(index)]; if (!property || !Object.hasOwn(property, 'value')) reject();
      const entry = ownData(property.value, ['principalId', 'deviceId', 'descriptor', 'capabilityIds']);
      const principalId = identifier(entry.principalId), deviceId = identifier(entry.deviceId);
      if (!enrollments.some(value => value.principalId === principalId && value.deviceId === deviceId)) reject();
      const descriptor = parseDeviceDescriptor(entry.descriptor), ids = strings(entry.capabilityIds, PRIVATE_DIRECTORY_LIMITS.capabilitiesPerResource);
      if (!ids.length || catalog.has(descriptor.id)) reject();
      const capabilities = ids.map(id => {
        const capability = descriptor.capabilities.find(value => value.id === id); if (!capability) reject();
        return Object.freeze({ id: capability.id, semantic: capability.semantic, kind: capability.kind, schemaVersion: capability.schemaVersion });
      });
      const resource = Object.freeze({ id: descriptor.id, revision: descriptor.revision, label: descriptor.label, capabilities: Object.freeze(capabilities) });
      // Apply the same closed public wire parser at provision time, before a listener can exist.
      parsePrivateDirectorySnapshot({ schemaVersion: 1, profile: PRIVATE_DIRECTORY_PROFILE, scope: { kind: 'directory', id: 'provisioned' }, issuedAt: 0, expiresAt: 1, resources: [{ ...resource, expiresAt: 1 }] });
      catalog.set(descriptor.id, Object.freeze({ principalId, deviceId, resource }));
    }
  }
  const sessions = new Map<string, DirectoryState>();
  let lastNow = -1, closed = false, epoch = 0;
  function check(authority: CoordinatorDirectoryAuthority) {
    const now = timestamp(authority.now), capturedEpoch = epoch;
    if (closed || now < lastNow || now >= authority.expiresAt || !authority.current()) {
      if (now < lastNow) { closed = true; sessions.clear(); }
      reject(404);
    }
    if (closed || epoch !== capturedEpoch) reject(404);
    lastNow = now;
  }
  function state(authority: CoordinatorDirectoryAuthority): DirectoryState {
    check(authority);
    let value = sessions.get(authority.sessionId);
    if (!value) { value = { resources: new Map(), members: new Map() }; sessions.set(authority.sessionId, value); }
    for (const [id, entry] of value.resources) if (entry.expiresAt <= authority.now) removeResource(value, id);
    for (const [id, member] of value.members) if (member.expiresAt <= authority.now || authority.peers.get(id) !== member.generation) value.members.delete(id);
    return value;
  }
  function removeResource(value: DirectoryState, id: string) {
    value.resources.delete(id);
    for (const [peerId, member] of value.members) if (member.resourceIds.includes(id)) {
      value.members.set(peerId, { ...member, resourceIds: Object.freeze(member.resourceIds.filter(value => value !== id)) });
    }
  }
  function snapshot(authority: CoordinatorDirectoryAuthority, value: DirectoryState): PrivateDirectorySnapshot {
    const member = authority.role === 'peer' ? value.members.get(authority.peerId ?? '') : undefined;
    const expiry = Math.min(authority.expiresAt, authority.now + PRIVATE_DIRECTORY_LIMITS.ttlMs, member?.expiresAt ?? Infinity);
    const resources: PrivateDirectoryResource[] = [];
    for (const [id, entry] of value.resources) {
      if (entry.expiresAt <= authority.now || authority.role === 'peer' && (!member || member.generation !== authority.generation || !member.resourceIds.includes(id))) continue;
      resources.push({ ...entry.resource.resource, expiresAt: Math.min(entry.expiresAt, expiry) });
    }
    return parsePrivateDirectorySnapshot({ schemaVersion: 1, profile: PRIVATE_DIRECTORY_PROFILE, scope: { kind: 'directory', id: authority.sessionId },
      issuedAt: authority.now, expiresAt: expiry, resources });
  }
  function preflight(authority: CoordinatorDirectoryAuthority, value: DirectoryState) {
    // Reserve complete metadata and worst-case timestamp digits, so later reads always remain representable.
    const resourceRows = [...value.resources.values()].map(entry => ({ ...entry.resource.resource, expiresAt: Number.MAX_SAFE_INTEGER }));
    try { parsePrivateDirectorySnapshot({ schemaVersion: 1, profile: PRIVATE_DIRECTORY_PROFILE, scope: { kind: 'directory', id: authority.sessionId },
      issuedAt: Number.MAX_SAFE_INTEGER - PRIVATE_DIRECTORY_LIMITS.ttlMs, expiresAt: Number.MAX_SAFE_INTEGER, resources: resourceRows }); } catch { reject(413); }
    check(authority);
  }
  function expiry(input: unknown, authority: CoordinatorDirectoryAuthority): number {
    const expiresAt = timestamp(input);
    if (expiresAt <= authority.now || expiresAt > authority.now + PRIVATE_DIRECTORY_LIMITS.ttlMs || expiresAt > authority.expiresAt) reject(); return expiresAt;
  }
  return {
    dispatch(authority: CoordinatorDirectoryAuthority, method: string, suffix: readonly string[], input?: unknown): { status: number; body?: PrivateDirectorySnapshot } {
      const value = state(authority);
      if (method === 'GET' && !suffix.length) { const body = snapshot(authority, value); check(authority); return { status: 200, body }; }
      if (authority.role !== 'host') reject(404);
      if (method === 'POST' && suffix.length === 1 && suffix[0] === 'resources') {
        const body = ownData(input, ['resourceId', 'expiresAt']), id = identifier(body.resourceId);
        const resource = catalog.get(id);
        if (!resource || resource.principalId !== authority.principalId || resource.deviceId !== authority.deviceId) reject(404);
        const expiresAt = expiry(body.expiresAt, authority);
        if (!value.resources.has(id) && value.resources.size >= PRIVATE_DIRECTORY_LIMITS.resourcesPerSession) reject(429);
        const future = { resources: new Map(value.resources), members: value.members };
        future.resources.set(id, { resource, expiresAt }); preflight(authority, future);
        value.resources.set(id, { resource, expiresAt }); return { status: 201 };
      }
      if (suffix.length === 2 && suffix[0] === 'resources' && method === 'DELETE') {
        const id = identifier(suffix[1]); if (!value.resources.has(id)) reject(404);
        check(authority); removeResource(value, id); return { status: 204 };
      }
      if (suffix.length === 2 && suffix[0] === 'members') {
        const peerId = identifier(suffix[1]), generation = authority.peers.get(peerId);
        if (generation === undefined) reject(404);
        if (method === 'DELETE') { check(authority); value.members.delete(peerId); return { status: 204 }; }
        if (method === 'PUT') {
          const body = ownData(input, ['resourceIds', 'expiresAt']), resourceIds = strings(body.resourceIds, PRIVATE_DIRECTORY_LIMITS.resourcesPerSession);
          if (resourceIds.some(id => !value.resources.has(id))) reject(404);
          const expiresAt = expiry(body.expiresAt, authority);
          if (!value.members.has(peerId) && value.members.size >= PRIVATE_DIRECTORY_LIMITS.membersPerSession) reject(429);
          preflight(authority, value);
          value.members.set(peerId, { resourceIds, expiresAt, generation }); return { status: 204 };
        }
      }
      reject(404);
    },
    retireSession(sessionId: string) { epoch++; sessions.delete(sessionId); },
    retirePeer(sessionId: string, peerId: string) { epoch++; sessions.get(sessionId)?.members.delete(peerId); },
    close() { epoch++; closed = true; sessions.clear(); catalog.clear(); },
  };
}

/** Explicit native HTTPS caller. Holds no cache or restored authority; close destroys its owned TLS requests/agent. */
export function createPrivateDirectoryClient(options: PrivateDirectoryClientOptions) {
  const value = ownData(options, ['endpoint', 'origin', 'caCertificatePem', 'certificatePem', 'privateKeyPem', 'sessionId', 'role', 'token', 'peerId'],
    ['endpoint', 'origin', 'caCertificatePem', 'certificatePem', 'privateKeyPem', 'sessionId', 'role', 'token']);
  const sessionId = identifier(value.sessionId), peerId = value.peerId === undefined ? undefined : identifier(value.peerId);
  const role = value.role;
  if (role !== 'host' && role !== 'peer' || role === 'host' && peerId !== undefined || role === 'peer' && peerId === undefined ||
    typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(value.token)) reject();
  const caller = createCoordinatorFetcher({ endpoint: value.endpoint as string, origin: value.origin as string, caCertificatePem: value.caCertificatePem as string,
    certificatePem: value.certificatePem as string, privateKeyPem: value.privateKeyPem as string });
  const path = `/v1/sessions/${sessionId}/${role === 'host' ? 'host' : `peers/${peerId}`}/directory`;
  const lifetime = new AbortController();
  let closed = false;
  async function send(method: string, suffix: string, body: unknown, signal?: AbortSignal) {
    if (closed || signal !== undefined && !(signal instanceof AbortSignal)) throw new Error('Directory caller closed or invalid');
    const copied = body === undefined ? undefined : JSON.stringify(snapshotJson(body));
    if (copied !== undefined && Buffer.byteLength(copied) > PRIVATE_DIRECTORY_LIMITS.requestBytes) throw new Error('Directory request too large');
    const currentSignal = signal === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, signal]);
    if (closed || currentSignal.aborted) throw new Error('Directory caller closed or aborted');
    const response = await caller.fetch((value.endpoint as string) + path + suffix, { method, headers: { Authorization: `Bearer ${value.token}`,
      ...(copied === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(copied === undefined ? {} : { body: copied }), signal: currentSignal });
    if (closed || currentSignal.aborted || !response.ok) throw new Error('Directory request rejected');
    if (method !== 'GET') return;
    const bytes = await response.arrayBuffer();
    if (closed || currentSignal.aborted || bytes.byteLength > PRIVATE_DIRECTORY_LIMITS.responseBytes) throw new Error('Directory response rejected');
    const snapshot = parsePrivateDirectorySnapshot(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    const now = Date.now();
    if (closed || currentSignal.aborted || snapshot.scope.id !== sessionId || !Number.isSafeInteger(now) || now < snapshot.issuedAt || now >= snapshot.expiresAt) throw new Error('Directory response stale or out of scope');
    return snapshot;
  }
  const hostOnly = () => { if (role !== 'host') throw new Error('Directory host role required'); };
  return {
    async list(signal?: AbortSignal): Promise<PrivateDirectorySnapshot> { return (await send('GET', '', undefined, signal))!; },
    async enroll(resourceId: string, expiresAt: number, signal?: AbortSignal) { hostOnly(); await send('POST', '/resources', { resourceId: identifier(resourceId), expiresAt: timestamp(expiresAt) }, signal); },
    async allow(peer: string, resourceIds: readonly string[], expiresAt: number, signal?: AbortSignal) { hostOnly(); await send('PUT', `/members/${identifier(peer)}`, { resourceIds: strings(resourceIds, PRIVATE_DIRECTORY_LIMITS.resourcesPerSession), expiresAt: timestamp(expiresAt) }, signal); },
    async remove(resourceId: string, signal?: AbortSignal) { hostOnly(); await send('DELETE', `/resources/${identifier(resourceId)}`, undefined, signal); },
    async revoke(peer: string, signal?: AbortSignal) { hostOnly(); await send('DELETE', `/members/${identifier(peer)}`, undefined, signal); },
    close() { closed = true; lifetime.abort(); caller.close(); },
  };
}
