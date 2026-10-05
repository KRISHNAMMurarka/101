import { DeviceValidationError, parseDeviceDescriptor } from './descriptor.ts';
import type { DeviceCapability, SignalValue } from './descriptor.ts';
import { parseSignalValue, schemasCompatible } from './sample.ts';

export const CONNECTOR_PROFILE_LIMITS = Object.freeze({ manifestBytes: 65536, resources: 16, identityFilters: 16,
  frameBytes: 65536, chunkBytes: 65536, framesPerPush: 64, bufferedBytes: 65536,
  outputsPerFrame: 32, pendingCommands: 16, commandBytes: 4096, callbackTimeoutMs: 5000, sourceBytes: 1048576 });
export interface ConnectorIdentityFilter { readonly field: string; readonly equals: string | number | boolean }
export interface ConnectorFraming { readonly kind: 'jsonl'; readonly maxFrameBytes: number; readonly maxChunkBytes: number; readonly maxFramesPerPush: number }
export interface ConnectorCalibration { readonly revision: number; readonly unit: string; readonly maxAbsoluteErrorBound: number }
export interface ConnectorCommandPolicy {
  readonly idempotent: true; readonly deadlineMs: number;
  readonly feedback: readonly ('dispatched' | 'target-acknowledged' | 'observed' | 'unverified')[];
  readonly observedState: string | null; readonly safeState: SignalValue;
}
export interface ConnectorProfileResource {
  readonly capability: Readonly<DeviceCapability>; readonly direction: 'source' | 'sink';
  readonly calibration: ConnectorCalibration | null; readonly command: ConnectorCommandPolicy | null;
}
export interface ConnectorProfileManifest {
  readonly schemaVersion: 1; readonly id: string; readonly version: string;
  readonly decoder: Readonly<{ id: string; version: string; codeSha256: string }>;
  readonly identityFilters: readonly ConnectorIdentityFilter[]; readonly framing: ConnectorFraming;
  readonly resources: readonly ConnectorProfileResource[];
  readonly budgets: Readonly<{ maxBufferedBytes: number; maxOutputsPerFrame: number; maxPendingCommands: number; maxCommandBytes: number; callbackTimeoutMs: number }>;
  readonly license: string;
}
function fail(code: string): never { throw new DeviceValidationError(code); }
function data(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail('profile-object');
  const names = Reflect.ownKeys(input);
  if (names.length !== keys.length || names.some(key => typeof key !== 'string' || !keys.includes(key))) fail('profile-fields');
  const output: Record<string, unknown> = {};
  for (const name of keys) { const field = Object.getOwnPropertyDescriptor(input, name); if (!field || !field.enumerable || !('value' in field)) fail('profile-data'); output[name] = field.value; }
  return output;
}
function text(input: unknown, pattern: RegExp, max = 128): string {
  if (typeof input !== 'string' || input.length > max || !pattern.test(input)) fail('profile-string'); return input as string;
}
function integer(input: unknown, max: number): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1 || input > max) fail('profile-limit'); return input as number;
}
const ID = /^[A-Za-z][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

/** Inert profile declarations. Matching metadata is not authentication, code loading or a grant. */
export function parseConnectorProfileManifest(input: unknown): Readonly<ConnectorProfileManifest> {
  if (typeof input === 'string') {
    if (input.length > CONNECTOR_PROFILE_LIMITS.manifestBytes || new TextEncoder().encode(input).length > CONNECTOR_PROFILE_LIMITS.manifestBytes) fail('profile-bytes');
    try { input = JSON.parse(input); } catch { fail('profile-json'); }
  }
  const source = data(input, ['schemaVersion', 'id', 'version', 'decoder', 'identityFilters', 'framing', 'resources', 'budgets', 'license']);
  if (source.schemaVersion !== 1) fail('profile-version');
  const id = text(source.id, ID), version = text(source.version, VERSION, 64);
  if (!Array.isArray(source.resources) || source.resources.length < 1 || source.resources.length > CONNECTOR_PROFILE_LIMITS.resources) fail('profile-resources');
  // The existing bounded descriptor snapshot validates every nested data property, schema and
  // total byte/depth budget. Metadata carries the inert policies, never executable callbacks.
  if (Object.getPrototypeOf(source.resources) !== Array.prototype || Reflect.ownKeys(source.resources).length !== source.resources.length + 1) fail('profile-resources');
  const parts: Record<string, unknown>[] = [];
  for (let index = 0; index < source.resources.length; index++) {
    const item = Object.getOwnPropertyDescriptor(source.resources, String(index));
    if (!item?.enumerable || !('value' in item)) fail('profile-data');
    parts.push(data(item.value, ['capability', 'direction', 'calibration', 'command']));
  }
  const snapshot = parseDeviceDescriptor({ schemaVersion: 1, id: 'connector-profile-template', label: 'Connector profile', revision: 1,
    adapter: { id, version }, runtime: { platform: 'connector-profile' }, capabilities: parts.map(part => part.capability),
    metadata: { decoder: source.decoder, identityFilters: source.identityFilters, framing: source.framing, budgets: source.budgets, license: source.license,
      resources: parts.map(part => ({ direction: part.direction, calibration: part.calibration, command: part.command })) } });
  const meta = snapshot.metadata!;
  const pin = data(meta.decoder, ['id', 'version', 'codeSha256']);
  const decoder = Object.freeze({ id: text(pin.id, ID), version: text(pin.version, VERSION, 64), codeSha256: text(pin.codeSha256, /^[0-9a-f]{64}$/, 64) });
  if (!Array.isArray(meta.identityFilters) || meta.identityFilters.length < 1 || meta.identityFilters.length > CONNECTOR_PROFILE_LIMITS.identityFilters) fail('profile-identity');
  const seen = new Set<string>();
  const identityFilters = Object.freeze(meta.identityFilters.map(entry => {
    const item = data(entry, ['field', 'equals']), field = text(item.field, /^[A-Za-z][A-Za-z0-9_]*$/, 64);
    if (seen.has(field) || ['constructor', 'prototype', '__proto__'].includes(field)) fail('profile-identity'); seen.add(field);
    const equals = item.equals;
    if (typeof equals !== 'boolean' && (typeof equals !== 'number' || !Number.isFinite(equals)) &&
      (typeof equals !== 'string' || !equals.length || equals.length > 128 || Array.from(equals).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) fail('profile-identity');
    return Object.freeze({ field, equals: equals as string | number | boolean });
  }));
  const framingInput = data(meta.framing, ['kind', 'maxFrameBytes', 'maxChunkBytes', 'maxFramesPerPush']);
  if (framingInput.kind !== 'jsonl') fail('profile-framing');
  const framing = Object.freeze({ kind: 'jsonl' as const,
    maxFrameBytes: integer(framingInput.maxFrameBytes, CONNECTOR_PROFILE_LIMITS.frameBytes),
    maxChunkBytes: integer(framingInput.maxChunkBytes, CONNECTOR_PROFILE_LIMITS.chunkBytes),
    maxFramesPerPush: integer(framingInput.maxFramesPerPush, CONNECTOR_PROFILE_LIMITS.framesPerPush) });
  const budget = data(meta.budgets, ['maxBufferedBytes', 'maxOutputsPerFrame', 'maxPendingCommands', 'maxCommandBytes', 'callbackTimeoutMs']);
  const budgets = Object.freeze({ maxBufferedBytes: integer(budget.maxBufferedBytes, CONNECTOR_PROFILE_LIMITS.bufferedBytes),
    maxOutputsPerFrame: integer(budget.maxOutputsPerFrame, CONNECTOR_PROFILE_LIMITS.outputsPerFrame),
    maxPendingCommands: integer(budget.maxPendingCommands, CONNECTOR_PROFILE_LIMITS.pendingCommands),
    maxCommandBytes: integer(budget.maxCommandBytes, CONNECTOR_PROFILE_LIMITS.commandBytes),
    callbackTimeoutMs: integer(budget.callbackTimeoutMs, CONNECTOR_PROFILE_LIMITS.callbackTimeoutMs) });
  if (budgets.maxBufferedBytes < framing.maxFrameBytes) fail('profile-buffer');
  const policies = meta.resources as unknown as readonly Record<string, unknown>[];
  const resources = snapshot.capabilities.map((capability, index): ConnectorProfileResource => {
    const part = policies[index]!;
    if (part.direction !== 'source' && part.direction !== 'sink') fail('profile-direction');
    let calibration: ConnectorCalibration | null = null, command: ConnectorCommandPolicy | null = null;
    if (part.direction === 'source') {
      if (!['sample', 'event', 'property'].includes(capability.kind) || !capability.permissions.includes('subscribe') ||
        capability.permissions.some(permission => permission !== 'subscribe' && permission !== 'read') || part.command !== null) fail('profile-source');
      if (capability.value.type === 'scalar') {
        const item = data(part.calibration, ['revision', 'unit', 'maxAbsoluteErrorBound']);
        const bound = item.maxAbsoluteErrorBound;
        if (item.unit !== capability.value.unit || typeof bound !== 'number' || !Number.isFinite(bound) || bound < 0 || bound > capability.value.max - capability.value.min) fail('profile-calibration');
        calibration = Object.freeze({ revision: integer(item.revision, 2147483647), unit: capability.value.unit, maxAbsoluteErrorBound: bound });
      } else if (part.calibration !== null) fail('profile-calibration');
    } else {
      if (capability.kind !== 'command' || capability.delivery.mode !== 'reliable' || capability.permissions.join('\0') !== 'invoke' || capability.ownership?.mode !== 'exclusive' || part.calibration !== null) fail('profile-command');
      const item = data(part.command, ['idempotent', 'deadlineMs', 'feedback', 'observedState', 'safeState']);
      if (item.idempotent !== true || !Array.isArray(item.feedback) || item.feedback[0] !== 'dispatched' || item.feedback.length > 4 ||
        new Set(item.feedback).size !== item.feedback.length || item.feedback.some(level => !['dispatched', 'target-acknowledged', 'observed', 'unverified'].includes(String(level)))) fail('profile-feedback');
      const feedback = Object.freeze(item.feedback) as ConnectorCommandPolicy['feedback'];
      if (feedback.includes('observed') ? typeof item.observedState !== 'string' || !feedback.includes('target-acknowledged') : item.observedState !== null) fail('profile-feedback');
      command = Object.freeze({ idempotent: true, deadlineMs: integer(item.deadlineMs, Math.min(5000, capability.delivery.maxAgeMs)), feedback,
        observedState: item.observedState as string | null, safeState: parseSignalValue(item.safeState, capability.value) });
    }
    return Object.freeze({ capability, direction: part.direction, calibration, command });
  });
  for (const resource of resources) if (resource.command && resource.command.observedState !== null) {
    const state = resources.find(item => item.direction === 'source' && item.capability.id === resource.command!.observedState);
    if (!state || !schemasCompatible(state.capability, resource.capability)) fail('profile-feedback-resource');
  }
  return Object.freeze({ schemaVersion: 1, id, version, decoder, identityFilters, framing, resources: Object.freeze(resources), budgets,
    license: text(meta.license, /^[A-Za-z0-9.+-]+$/, 64) });
}
