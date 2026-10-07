import { DeviceValidationError, parseDeviceDescriptor, snapshotJson } from './descriptor.ts';
import type { DeviceDescriptor, JsonObject, JsonValue } from './descriptor.ts';
import { parseDiscoveryCandidate } from './discovery.ts';
import type { DiscoveryCandidate, DiscoveryScope } from './discovery.ts';

export const PRIVATE_DIRECTORY_PROFILE = 'provisioned-session-directory/1' as const;
export const PRIVATE_DIRECTORY_LIMITS = Object.freeze({ catalogResources: 32, resourcesPerSession: 16,
  capabilitiesPerResource: 8, membersPerSession: 8, requestBytes: 8192, responseBytes: 65536, ttlMs: 60000 });
export interface PrivateDirectoryCapability {
  readonly id: string; readonly semantic: string; readonly kind: 'sample' | 'event' | 'command' | 'property' | 'job'; readonly schemaVersion: number;
}
export interface PrivateDirectoryResource {
  readonly id: string; readonly revision: number; readonly label: string; readonly expiresAt: number;
  readonly capabilities: readonly PrivateDirectoryCapability[];
}
export interface PrivateDirectorySnapshot {
  readonly schemaVersion: 1; readonly profile: typeof PRIVATE_DIRECTORY_PROFILE;
  readonly scope: Readonly<{ kind: 'directory'; id: string }>; readonly issuedAt: number; readonly expiresAt: number;
  readonly resources: readonly PrivateDirectoryResource[];
}
/** Explicit owner consent for one current enrolled-device descriptor; this carries no runtime authority. */
export interface PrivateDirectoryPublication {
  readonly generation: number; readonly descriptor: Readonly<DeviceDescriptor>; readonly capabilityIds: readonly string[];
  readonly expiresAt: number; readonly consent: true;
}
function fail(): never { throw new DeviceValidationError('private-directory-invalid'); }
function object(value: JsonValue | undefined, fields: readonly string[]): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length ||
    fields.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !fields.includes(key))) fail();
  return value;
}
function text(value: JsonValue | undefined, maximum = 128): string {
  if (typeof value !== 'string' || !value.length || value.length > maximum || value.trim() !== value ||
    Array.from(value).some(character => { const code = character.charCodeAt(0); return code < 32 || code >= 127 && code <= 159; })) fail();
  return value;
}
function identifier(value: JsonValue | undefined): string {
  const result = text(value); if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(result)) fail(); return result;
}
function time(value: JsonValue | undefined): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(); return value;
}
function list(value: JsonValue | undefined, maximum: number): JsonValue[] {
  if (!Array.isArray(value) || value.length > maximum) fail(); return value;
}
/** Closed, immutable request. Native enrollment, current generation and expiry are checked by the coordinator. */
export function parsePrivateDirectoryPublication(input: unknown): PrivateDirectoryPublication {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Object.getOwnPropertySymbols(input).length) fail();
  const fields = ['generation', 'descriptor', 'capabilityIds', 'expiresAt', 'consent'], properties = Object.getOwnPropertyDescriptors(input);
  if (Object.keys(properties).length !== fields.length || fields.some(key => !properties[key]?.enumerable || !Object.hasOwn(properties[key]!, 'value'))) fail();
  // The descriptor owns its deeper schema/metadata bounds; the surrounding request must not narrow them.
  const descriptor = parseDeviceDescriptor(properties.descriptor!.value);
  const value = object(snapshotJson({ generation: properties.generation!.value, capabilityIds: properties.capabilityIds!.value,
    expiresAt: properties.expiresAt!.value, consent: properties.consent!.value }), ['generation', 'capabilityIds', 'expiresAt', 'consent']);
  if (time(value.generation) < 1 || value.consent !== true) fail();
  time(value.expiresAt);
  identifier(descriptor.id); text(descriptor.label);
  const ids = list(value.capabilityIds, PRIVATE_DIRECTORY_LIMITS.capabilitiesPerResource).map(identifier);
  if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !descriptor.capabilities.some(capability => capability.id === id))) fail();
  const publication = Object.freeze({ generation: value.generation as number, descriptor, capabilityIds: Object.freeze(ids), expiresAt: value.expiresAt as number, consent: true as const });
  if (new TextEncoder().encode(JSON.stringify(publication)).byteLength > PRIVATE_DIRECTORY_LIMITS.requestBytes) fail();
  return publication;
}
/** Closed inert metadata. Parsing and directory membership never create resource grants. */
export function parsePrivateDirectorySnapshot(input: unknown): PrivateDirectorySnapshot {
  const value = object(snapshotJson(input), ['schemaVersion', 'profile', 'scope', 'issuedAt', 'expiresAt', 'resources']);
  if (value.schemaVersion !== 1 || value.profile !== PRIVATE_DIRECTORY_PROFILE) fail();
  const scope = object(value.scope, ['kind', 'id']); if (scope.kind !== 'directory') fail(); identifier(scope.id);
  const issued = time(value.issuedAt), expiry = time(value.expiresAt);
  if (issued >= expiry || expiry - issued > PRIVATE_DIRECTORY_LIMITS.ttlMs) fail();
  const resources = list(value.resources, PRIVATE_DIRECTORY_LIMITS.resourcesPerSession), ids = new Set<string>();
  for (const entry of resources) {
    const resource = object(entry, ['id', 'revision', 'label', 'expiresAt', 'capabilities']);
    const id = identifier(resource.id); if (ids.has(id)) fail(); ids.add(id);
    if (time(resource.revision) < 1 || (resource.revision as number) > 4294967295) fail(); text(resource.label);
    const expiresAt = time(resource.expiresAt); if (expiresAt <= issued || expiresAt > expiry) fail();
    const capabilities = list(resource.capabilities, PRIVATE_DIRECTORY_LIMITS.capabilitiesPerResource), names = new Set<string>();
    if (!capabilities.length) fail();
    for (const item of capabilities) {
      const cap = object(item, ['id', 'semantic', 'kind', 'schemaVersion']); const name = identifier(cap.id);
      if (names.has(name)) fail(); names.add(name); const semantic = text(cap.semantic);
      if (!/^[A-Za-z][A-Za-z0-9._-]*:[\s\S]+$/.test(semantic) || !['sample', 'event', 'command', 'property', 'job'].includes(cap.kind as string) ||
        time(cap.schemaVersion) < 1 || (cap.schemaVersion as number) > 4294967295) fail();
    }
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > PRIVATE_DIRECTORY_LIMITS.responseBytes) fail();
  return value as unknown as PrivateDirectorySnapshot;
}
/** Only observation/identity claims. A host must independently verify receipts; these are never live-resource proof. */
export function privateDirectoryCandidates(input: unknown, receiptId: string): readonly DiscoveryCandidate[] {
  const snapshot = parsePrivateDirectorySnapshot(input);
  const scope: DiscoveryScope = snapshot.scope;
  return Object.freeze(snapshot.resources.map(resource => parseDiscoveryCandidate({ schemaVersion: 1, id: resource.id, scope,
    expiresAt: resource.expiresAt, recovery: { action: 'request-access', hint: 'Review this resource and request access.' },
    evidence: [{ stage: 'observed', kind: 'observation' }, { stage: 'identified', kind: 'identity' }].map(stage => ({ ...stage,
      candidateId: resource.id, scope, receiptId, at: snapshot.issuedAt, expiresAt: resource.expiresAt })) })));
}
