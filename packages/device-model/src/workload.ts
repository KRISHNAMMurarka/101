import { DeviceValidationError, parseDeviceDescriptor, snapshotJson } from './descriptor.ts';
import type { DeviceDescriptor } from './descriptor.ts';
import { parseProcessorManifest } from './processor-manifest.ts';
import type { ProcessorManifest } from './processor-manifest.ts';
import { parseAssetReference } from './resource.ts';
import type { AssetReference } from './resource.ts';

export interface WorkloadRuntime { readonly platform: 'node' | 'browser' | 'native'; readonly minimumVersion: string }
export interface WorkloadBudget { readonly maxComputeMs: number; readonly maxMemoryBytes: number }
export interface WorkloadResource {
  readonly deviceId: string; readonly capability: string;
  readonly operation: 'read' | 'subscribe' | 'write' | 'invoke'; readonly required: boolean;
}
export interface WorkloadRequirements {
  readonly id: string; readonly version: string;
  readonly application: Readonly<{ codeSha256: string; runtime: WorkloadRuntime; budget: WorkloadBudget }>;
  readonly processors: readonly Readonly<{ manifest: Readonly<ProcessorManifest>; runtime: WorkloadRuntime }> [];
  readonly assets: readonly Readonly<AssetReference>[];
  readonly resources: readonly WorkloadResource[];
  readonly privacy: Readonly<{ mode: 'local-only' | 'explicit-sharing'; purpose: string | null;
    destinations: readonly string[]; retention: 'none' }>;
  readonly budget: WorkloadBudget;
  readonly restart: Readonly<{ mode: 'cold' }> | Readonly<{ mode: 'snapshot'; formatVersion: number;
    applicationCodeSha256: string; processorState: 'reset-on-resume'; onIncompatible: 'cold-restart' }>;
}

function fail(code: string, path: string): never { throw new DeviceValidationError(code, path); }
function object(input: unknown, path: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('workload-object', path);
  return input as Record<string, unknown>;
}
function exact(input: Record<string, unknown>, keys: readonly string[], path: string): void {
  if (Object.keys(input).sort().join('\0') !== [...keys].sort().join('\0')) fail('workload-fields', path);
}
function namespaced(input: unknown, path: string): string {
  if (typeof input !== 'string' || input.length > 128 ||
      !/^[A-Za-z][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input)) fail('workload-id', path);
  return input as string;
}
function bounded(input: unknown, path: string, max = 160): string {
  if (typeof input !== 'string' || !input.length || input.length > max || input.trim() !== input ||
      Array.from(input).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
    fail('workload-text', path);
  return input as string;
}
function version(input: unknown, path: string): string {
  if (typeof input !== 'string' || input.length > 64 ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(input))
    fail('workload-version', path);
  return input as string;
}
function sha256(input: unknown, path: string): string {
  if (typeof input !== 'string' || !/^[0-9a-f]{64}$/.test(input)) fail('workload-pin', path);
  return input as string;
}
function positive(input: unknown, path: string, max: number): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1 || input > max)
    fail('workload-budget', path);
  return input as number;
}
function list(input: unknown, path: string, max: number, min = 0): unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype ||
      input.length < min || input.length > max) fail('workload-list', path);
  return Array.from({ length: input.length }, (_, index) => {
    const property = Object.getOwnPropertyDescriptor(input, String(index));
    if (!property || !Object.hasOwn(property, 'value')) fail('workload-list', `${path}[${index}]`);
    return property.value;
  });
}
function runtime(input: unknown, path: string): WorkloadRuntime {
  const value = object(input, path); exact(value, ['platform', 'minimumVersion'], path);
  if (value.platform !== 'node' && value.platform !== 'browser' && value.platform !== 'native')
    fail('workload-runtime', `${path}.platform`);
  return Object.freeze({ platform: value.platform, minimumVersion: version(value.minimumVersion, `${path}.minimumVersion`) });
}
function budget(input: unknown, path: string): WorkloadBudget {
  const value = object(input, path); exact(value, ['maxComputeMs', 'maxMemoryBytes'], path);
  return Object.freeze({ maxComputeMs: positive(value.maxComputeMs, `${path}.maxComputeMs`, 1000),
    maxMemoryBytes: positive(value.maxMemoryBytes, `${path}.maxMemoryBytes`, 256 * 1024 * 1024) });
}
function context(input: unknown): { devices: Map<string, Readonly<DeviceDescriptor>>;
  processors: Map<string, Readonly<ProcessorManifest>> } {
  const value = object(input, '$.context'); exact(value, ['devices', 'processors'], '$.context');
  const deviceProperty = Object.getOwnPropertyDescriptor(value, 'devices');
  const processorProperty = Object.getOwnPropertyDescriptor(value, 'processors');
  if (!deviceProperty || !Object.hasOwn(deviceProperty, 'value') ||
      !processorProperty || !Object.hasOwn(processorProperty, 'value')) fail('workload-context', '$.context');
  const devices = new Map<string, Readonly<DeviceDescriptor>>();
  for (const [index, item] of list(deviceProperty.value, '$.context.devices', 64).entries()) {
    const parsed = parseDeviceDescriptor(item);
    if (devices.has(parsed.id)) fail('workload-duplicate-device', `$.context.devices[${index}]`);
    devices.set(parsed.id, parsed);
  }
  const processors = new Map<string, Readonly<ProcessorManifest>>();
  for (const [index, item] of list(processorProperty.value, '$.context.processors', 16).entries()) {
    const parsed = parseProcessorManifest(item);
    if (processors.has(parsed.id)) fail('workload-duplicate-processor', `$.context.processors[${index}]`);
    processors.set(parsed.id, parsed);
  }
  return { devices, processors };
}
function resource(input: unknown, path: string, devices: Map<string, Readonly<DeviceDescriptor>>): WorkloadResource {
  const value = object(input, path); exact(value, ['deviceId', 'capability', 'operation', 'required'], path);
  const deviceId = bounded(value.deviceId, `${path}.deviceId`, 128);
  const capabilityId = bounded(value.capability, `${path}.capability`, 128);
  const device = devices.get(deviceId);
  if (!device) fail('workload-device', `${path}.deviceId`);
  const capability = device.capabilities.find(item => item.id === capabilityId);
  if (!capability) fail('workload-capability', `${path}.capability`);
  const operation = value.operation;
  if (operation !== 'read' && operation !== 'subscribe' && operation !== 'write' && operation !== 'invoke' ||
      !capability.permissions.includes(operation) ||
      operation === 'read' && (capability.kind !== 'property' || capability.delivery.mode !== 'latest') ||
      operation === 'subscribe' && capability.kind !== 'sample' && capability.kind !== 'event' && capability.kind !== 'property' ||
      operation === 'write' && capability.kind !== 'property' ||
      operation === 'invoke' && capability.kind !== 'command' && capability.kind !== 'job')
    fail('workload-operation', `${path}.operation`);
  if (typeof value.required !== 'boolean') fail('workload-required', `${path}.required`);
  return Object.freeze({ deviceId, capability: capabilityId,
    operation: operation as WorkloadResource['operation'], required: value.required });
}

/** Parses inert requirements against reviewed descriptors/manifests; it does not place or authorize work. */
export function parseWorkloadRequirements(input: unknown, contextInput: unknown): Readonly<WorkloadRequirements> {
  const value = object(snapshotJson(input), '$');
  exact(value, ['schemaVersion', 'id', 'version', 'application', 'processors', 'assets', 'resources',
    'privacy', 'budget', 'restart'], '$');
  if (value.schemaVersion !== 1) fail('workload-schema-version', '$.schemaVersion');
  const id = namespaced(value.id, '$.id'), appVersion = version(value.version, '$.version');
  const reviewed = context(contextInput);
  const applicationInput = object(value.application, '$.application');
  exact(applicationInput, ['codeSha256', 'runtime', 'budget'], '$.application');
  const application = Object.freeze({ codeSha256: sha256(applicationInput.codeSha256, '$.application.codeSha256'),
    runtime: runtime(applicationInput.runtime, '$.application.runtime'),
    budget: budget(applicationInput.budget, '$.application.budget') });
  const processors = Object.freeze(list(value.processors, '$.processors', 16).map((input, index) => {
    const path = `$.processors[${index}]`, item = object(input, path);
    exact(item, ['id', 'version', 'codeSha256', 'runtime'], path);
    const processorId = namespaced(item.id, `${path}.id`);
    const manifest = reviewed.processors.get(processorId);
    if (!manifest || manifest.version !== version(item.version, `${path}.version`) ||
        manifest.codeSha256 !== sha256(item.codeSha256, `${path}.codeSha256`)) fail('workload-processor-pin', path);
    return Object.freeze({ manifest, runtime: runtime(item.runtime, `${path}.runtime`) });
  }));
  if (new Set(processors.map(item => item.manifest.id)).size !== processors.length)
    fail('workload-duplicate-processor', '$.processors');
  const assets = Object.freeze(list(value.assets, '$.assets', 32).map((item) =>
    parseAssetReference(item)));
  const assetsById = new Map(assets.map(item => [item.id, item]));
  if (assetsById.size !== assets.length) fail('workload-duplicate-asset', '$.assets');
  for (const processor of processors) for (const required of processor.manifest.assets) {
    const available = assetsById.get(required.reference.id);
    if (!available || available.sha256 !== required.reference.sha256 ||
        available.byteLength !== required.reference.byteLength || available.kind !== required.reference.kind ||
        available.mediaType !== required.reference.mediaType) fail('workload-missing-asset', '$.assets');
  }
  const resources = Object.freeze(list(value.resources, '$.resources', 64, 1).map((item, index) =>
    resource(item, `$.resources[${index}]`, reviewed.devices)));
  if (!resources.some(item => item.required)) fail('workload-no-required-resource', '$.resources');
  if (new Set(resources.map(item => `${item.deviceId}\0${item.capability}`)).size !== resources.length)
    fail('workload-duplicate-resource', '$.resources');
  const privacyInput = object(value.privacy, '$.privacy');
  exact(privacyInput, ['mode', 'purpose', 'destinations', 'retention'], '$.privacy');
  if (privacyInput.retention !== 'none') fail('workload-retention', '$.privacy.retention');
  const destinations = Object.freeze(list(privacyInput.destinations, '$.privacy.destinations', 16).map((item, index) =>
    namespaced(item, `$.privacy.destinations[${index}]`)));
  if (new Set(destinations).size !== destinations.length) fail('workload-duplicate-destination', '$.privacy.destinations');
  let privacy: WorkloadRequirements['privacy'];
  if (privacyInput.mode === 'local-only') {
    if (privacyInput.purpose !== null || destinations.length ||
        processors.some(item => item.manifest.budgets.privacy !== 'local-only'))
      fail('workload-privacy', '$.privacy');
    privacy = Object.freeze({ mode: 'local-only', purpose: null, destinations, retention: 'none' });
  } else if (privacyInput.mode === 'explicit-sharing') {
    if (!destinations.length || processors.some(item => item.manifest.budgets.privacy === 'local-only'))
      fail('workload-privacy', '$.privacy.destinations');
    privacy = Object.freeze({ mode: 'explicit-sharing', purpose: bounded(privacyInput.purpose, '$.privacy.purpose'),
      destinations, retention: 'none' });
  } else fail('workload-privacy', '$.privacy.mode');
  const totalBudget = budget(value.budget, '$.budget');
  const compute = application.budget.maxComputeMs + processors.reduce((sum, item) => sum + item.manifest.budgets.maxComputeMs, 0);
  const memory = application.budget.maxMemoryBytes + processors.reduce((sum, item) => sum + item.manifest.budgets.maxMemoryBytes, 0);
  if (compute > totalBudget.maxComputeMs || memory > totalBudget.maxMemoryBytes)
    fail('workload-underbudget', '$.budget');
  const restartInput = object(value.restart, '$.restart');
  let restart: WorkloadRequirements['restart'];
  if (restartInput.mode === 'cold') {
    exact(restartInput, ['mode'], '$.restart');
    restart = Object.freeze({ mode: 'cold' });
  } else if (restartInput.mode === 'snapshot') {
    exact(restartInput, ['mode', 'formatVersion', 'applicationCodeSha256', 'processorState', 'onIncompatible'], '$.restart');
    const formatVersion = positive(restartInput.formatVersion, '$.restart.formatVersion', 2147483647);
    if (sha256(restartInput.applicationCodeSha256, '$.restart.applicationCodeSha256') !== application.codeSha256 ||
        restartInput.processorState !== 'reset-on-resume' || restartInput.onIncompatible !== 'cold-restart')
      fail('workload-snapshot-compatibility', '$.restart');
    restart = Object.freeze({ mode: 'snapshot', formatVersion,
      applicationCodeSha256: application.codeSha256, processorState: 'reset-on-resume', onIncompatible: 'cold-restart' });
  } else fail('workload-restart', '$.restart.mode');
  return Object.freeze({ id, version: appVersion, application, processors, assets, resources, privacy,
    budget: totalBudget, restart });
}
