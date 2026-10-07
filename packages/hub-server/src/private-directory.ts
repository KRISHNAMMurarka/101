import { parseDeviceDescriptor, snapshotJson, parsePrivateDirectorySnapshot, parsePrivateDirectoryPublication, PRIVATE_DIRECTORY_PROFILE, PRIVATE_DIRECTORY_LIMITS } from '@101/device-model';
import type { DeviceDescriptor, PrivateDirectoryPublication, PrivateDirectoryResource, PrivateDirectorySnapshot } from '@101/device-model';
import { createCoordinatorFetcher } from './https-coordinator.ts';
import type { CoordinatorFetcherOptions } from './https-coordinator.ts';

/** Provisioned host configuration, never an identity claim accepted from HTTP input. */
export interface ProvisionedDirectoryResource {
  readonly principalId: string; readonly deviceId: string; readonly descriptor: DeviceDescriptor; readonly capabilityIds: readonly string[];
}
export interface PrivateDirectoryClientOptions extends CoordinatorFetcherOptions {
  readonly sessionId: string; readonly role: 'host' | 'peer'; readonly token: string; readonly peerId?: string;
}
interface ProjectedResource { readonly principalId: string; readonly deviceId: string; readonly resource: Omit<PrivateDirectoryResource, 'expiresAt'>;
  readonly peerId?: string; readonly generation?: number; }
interface MemberVisibility { readonly resourceIds: readonly string[]; readonly expiresAt: number; readonly generation: number; }
interface PublicationFloor { readonly generation: number; readonly revision: number; }
interface DirectoryState { readonly resources: Map<string, { resource: ProjectedResource; expiresAt: number }>; readonly members: Map<string, MemberVisibility>;
  readonly publications: Map<string, PublicationFloor>; }
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
function project(descriptor: Readonly<DeviceDescriptor>, ids: readonly string[]): Omit<PrivateDirectoryResource, 'expiresAt'> {
  const capabilities = ids.map(id => {
    const capability = descriptor.capabilities.find(value => value.id === id); if (!capability) reject();
    return Object.freeze({ id: capability.id, semantic: capability.semantic, kind: capability.kind, schemaVersion: capability.schemaVersion });
  });
  const resource = Object.freeze({ id: descriptor.id, revision: descriptor.revision, label: descriptor.label, capabilities: Object.freeze(capabilities) });
  parsePrivateDirectorySnapshot({ schemaVersion: 1, profile: PRIVATE_DIRECTORY_PROFILE, scope: { kind: 'directory', id: 'provisioned' }, issuedAt: 0, expiresAt: 1, resources: [{ ...resource, expiresAt: 1 }] });
  return resource;
}

/** Internal session state; no HTTP identity or authority is derived here. It is deliberately not a public barrel export. */
export function createCoordinatorDirectory(input: unknown, enrollments: readonly { principalId: string; deviceId: string }[]) {
  const owners = enrollments.map(value => Object.freeze({ principalId: value.principalId, deviceId: value.deviceId }));
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
      // Apply the same closed public wire parser at provision time, before a listener can exist.
      const resource = project(descriptor, ids);
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
    if (!value) { value = { resources: new Map(), members: new Map(), publications: new Map() }; sessions.set(authority.sessionId, value); }
    for (const [id, entry] of value.resources) if (entry.expiresAt <= authority.now || entry.resource.peerId !== undefined &&
      authority.peers.get(entry.resource.peerId) !== entry.resource.generation) removeResource(value, id);
    for (const [id, member] of value.members) if (member.expiresAt <= authority.now || authority.peers.get(id) !== member.generation) value.members.delete(id);
    for (const [id, publication] of value.publications) if (authority.peers.get(id) !== publication.generation) value.publications.delete(id);
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
  function preflight(authority: CoordinatorDirectoryAuthority, value: Pick<DirectoryState, 'resources'>) {
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
      if (authority.role === 'peer' && suffix[0] === 'publication') {
        const peerId = authority.peerId;
        if (!peerId || authority.peers.get(peerId) !== authority.generation || !owners.some(owner => owner.principalId === authority.principalId && owner.deviceId === authority.deviceId)) reject(404);
        const prior = value.resources.get(authority.deviceId), floor = value.publications.get(peerId);
        if (method === 'DELETE' && suffix.length === 3) {
          if (suffix[1] !== String(authority.generation) || !prior || prior.resource.peerId !== peerId || prior.resource.generation !== authority.generation || suffix[2] !== String(prior.resource.resource.revision)) reject(404);
          check(authority); removeResource(value, authority.deviceId); return { status: 204 };
        }
        if ((method !== 'POST' && method !== 'PUT') || suffix.length !== 1) reject(404);
        const publication = parsePrivateDirectoryPublication(input), descriptor = publication.descriptor;
        if (publication.generation !== authority.generation || descriptor.id !== authority.deviceId || catalog.has(descriptor.id)) reject(404);
        if (floor && descriptor.revision <= floor.revision) reject(409);
        if (prior && (prior.resource.peerId !== peerId || prior.resource.generation !== authority.generation)) reject(404);
        if (method === 'POST' && prior || method === 'PUT' && !prior) reject(409);
        const expiresAt = expiry(publication.expiresAt, authority);
        if (method === 'PUT' && expiresAt !== prior!.expiresAt) reject(409);
        if (!prior && value.resources.size >= PRIVATE_DIRECTORY_LIMITS.resourcesPerSession || !floor && value.publications.size >= PRIVATE_DIRECTORY_LIMITS.membersPerSession) reject(429);
        const resource = Object.freeze({ principalId: authority.principalId, deviceId: authority.deviceId, peerId, generation: authority.generation, resource: project(descriptor, publication.capabilityIds) });
        const future = { resources: new Map(value.resources) };
        future.resources.set(descriptor.id, { resource, expiresAt }); preflight(authority, future);
        // A replacement always retires the host's old visibility selection, even when the selected capability ids match.
        removeResource(value, descriptor.id);
        value.resources.set(descriptor.id, { resource, expiresAt });
        value.publications.set(peerId, { generation: authority.generation, revision: descriptor.revision });
        return { status: method === 'POST' ? 201 : 204 };
      }
      if (authority.role !== 'host') reject(404);
      if (method === 'POST' && suffix.length === 1 && suffix[0] === 'resources') {
        const body = ownData(input, ['resourceId', 'expiresAt']), id = identifier(body.resourceId);
        const resource = catalog.get(id);
        if (!resource || resource.principalId !== authority.principalId || resource.deviceId !== authority.deviceId) reject(404);
        const expiresAt = expiry(body.expiresAt, authority);
        if (!value.resources.has(id) && value.resources.size >= PRIVATE_DIRECTORY_LIMITS.resourcesPerSession) reject(429);
        const future = { resources: new Map(value.resources) };
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
    retirePeer(sessionId: string, peerId: string) {
      epoch++; const value = sessions.get(sessionId); if (!value) return;
      value.members.delete(peerId); value.publications.delete(peerId);
      for (const [id, entry] of value.resources) if (entry.resource.peerId === peerId) removeResource(value, id);
    },
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
  async function send(method: string, suffix: string, body: unknown, signal?: AbortSignal, publication = false) {
    if (closed || signal !== undefined && !(signal instanceof AbortSignal)) throw new Error('Directory caller closed or invalid');
    const copied = body === undefined ? undefined : JSON.stringify(publication ? parsePrivateDirectoryPublication(body) : snapshotJson(body));
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
  const peerOnly = () => { if (role !== 'peer') throw new Error('Directory peer role required'); };
  return {
    async list(signal?: AbortSignal): Promise<PrivateDirectorySnapshot> { return (await send('GET', '', undefined, signal))!; },
    async enroll(resourceId: string, expiresAt: number, signal?: AbortSignal) { hostOnly(); await send('POST', '/resources', { resourceId: identifier(resourceId), expiresAt: timestamp(expiresAt) }, signal); },
    async allow(peer: string, resourceIds: readonly string[], expiresAt: number, signal?: AbortSignal) { hostOnly(); await send('PUT', `/members/${identifier(peer)}`, { resourceIds: strings(resourceIds, PRIVATE_DIRECTORY_LIMITS.resourcesPerSession), expiresAt: timestamp(expiresAt) }, signal); },
    async remove(resourceId: string, signal?: AbortSignal) { hostOnly(); await send('DELETE', `/resources/${identifier(resourceId)}`, undefined, signal); },
    async revoke(peer: string, signal?: AbortSignal) { hostOnly(); await send('DELETE', `/members/${identifier(peer)}`, undefined, signal); },
    async publish(publication: PrivateDirectoryPublication, signal?: AbortSignal) { peerOnly(); await send('POST', '/publication', publication, signal, true); },
    async update(publication: PrivateDirectoryPublication, signal?: AbortSignal) { peerOnly(); await send('PUT', '/publication', publication, signal, true); },
    async unpublish(generation: number, revision: number, signal?: AbortSignal) {
      peerOnly(); if (timestamp(generation) < 1 || timestamp(revision) < 1 || revision > 4294967295) reject();
      await send('DELETE', `/publication/${generation}/${revision}`, undefined, signal);
    },
    close() { closed = true; lifetime.abort(); caller.close(); },
  };
}
