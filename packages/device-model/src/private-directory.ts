import { DeviceValidationError, snapshotJson } from './descriptor.ts';
import type { JsonObject, JsonValue } from './descriptor.ts';
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
