import { DeviceValidationError, parseValueSchema, snapshotJson } from './descriptor.ts';
import type { ValueSchema } from './descriptor.ts';
import { parseAssetReference } from './resource.ts';
import type { AssetReference } from './resource.ts';

export interface ProcessorPort { readonly id: string; readonly value: ValueSchema }
export interface ProcessorAsset { readonly reference: AssetReference; readonly license: string }
export interface ProcessorManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly codeSha256: string;
  readonly inputs: readonly ProcessorPort[];
  readonly outputs: readonly ProcessorPort[];
  readonly configuration: Extract<ValueSchema, { type: 'record' }>;
  readonly state: Readonly<{ mode: 'stateless' }> | Readonly<{
    mode: 'resettable'; resetOn: readonly ['input-loss', 'stop', 'reconfigure'];
  }>;
  readonly assets: readonly ProcessorAsset[];
  readonly license: string;
  readonly budgets: Readonly<{ maxComputeMs: number; maxMemoryBytes: number; privacy: 'local-only' | 'explicit-sharing' }>;
}

function fail(code: string, path: string): never { throw new DeviceValidationError(code, path); }
function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('processor-object', path);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) fail('processor-fields', path);
}
function boundedString(value: unknown, path: string, pattern: RegExp, max = 128): string {
  if (typeof value !== 'string' || value.length > max || !pattern.test(value)) fail('processor-string', path);
  return value as string;
}
function positive(value: unknown, path: string, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) fail('processor-limit', path);
  return value as number;
}
function ports(value: unknown, path: string): readonly ProcessorPort[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) fail('processor-ports', path);
  const seen = new Set<string>();
  return Object.freeze(value.map((entry, index) => {
    const part = object(entry, `${path}[${index}]`);
    exact(part, ['id', 'value'], `${path}[${index}]`);
    const id = boundedString(part.id, `${path}[${index}].id`, /^[a-z][a-z0-9-]*$/, 64);
    if (seen.has(id)) fail('processor-duplicate-port', `${path}[${index}].id`);
    seen.add(id);
    return Object.freeze({ id, value: parseValueSchema(part.value, `${path}[${index}].value`) });
  }));
}

/** An inert, closed manifest. It never loads code, assets, devices or grants. */
export function parseProcessorManifest(input: unknown): Readonly<ProcessorManifest> {
  const source = object(snapshotJson(input), '$');
  exact(source, ['schemaVersion', 'id', 'version', 'codeSha256', 'inputs', 'outputs',
    'configuration', 'state', 'assets', 'license', 'budgets'], '$');
  if (source.schemaVersion !== 1) fail('processor-version', '$.schemaVersion');
  const id = boundedString(source.id, '$.id', /^[A-Za-z][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/);
  const version = boundedString(source.version, '$.version', /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/, 64);
  const codeSha256 = boundedString(source.codeSha256, '$.codeSha256', /^[0-9a-f]{64}$/, 64);
  const inputs = ports(source.inputs, '$.inputs');
  const outputs = ports(source.outputs, '$.outputs');
  const configuration = parseValueSchema(source.configuration, '$.configuration');
  if (configuration.type !== 'record') fail('processor-configuration', '$.configuration');
  const stateInput = object(source.state, '$.state');
  let state: ProcessorManifest['state'];
  if (stateInput.mode === 'stateless') {
    exact(stateInput, ['mode'], '$.state');
    state = Object.freeze({ mode: 'stateless' });
  } else if (stateInput.mode === 'resettable') {
    exact(stateInput, ['mode', 'resetOn'], '$.state');
    if (!Array.isArray(stateInput.resetOn) || stateInput.resetOn.join('\0') !== 'input-loss\0stop\0reconfigure') {
      fail('processor-reset-policy', '$.state.resetOn');
    }
    state = Object.freeze({ mode: 'resettable', resetOn: Object.freeze(['input-loss', 'stop', 'reconfigure'] as const) });
  } else fail('processor-state', '$.state.mode');
  if (!Array.isArray(source.assets) || source.assets.length > 16) fail('processor-assets', '$.assets');
  const assets = Object.freeze(source.assets.map((entry, index) => {
    const item = object(entry, `$.assets[${index}]`);
    exact(item, ['reference', 'license'], `$.assets[${index}]`);
    return Object.freeze({ reference: parseAssetReference(item.reference),
      license: boundedString(item.license, `$.assets[${index}].license`, /^[A-Za-z0-9.+-]+$/, 64) });
  }));
  if (new Set(assets.map((asset) => asset.reference.id)).size !== assets.length) fail('processor-duplicate-asset', '$.assets');
  const license = boundedString(source.license, '$.license', /^[A-Za-z0-9.+-]+$/, 64);
  const budgetInput = object(source.budgets, '$.budgets');
  exact(budgetInput, ['maxComputeMs', 'maxMemoryBytes', 'privacy'], '$.budgets');
  const maxComputeMs = positive(budgetInput.maxComputeMs, '$.budgets.maxComputeMs', 1000);
  const maxMemoryBytes = positive(budgetInput.maxMemoryBytes, '$.budgets.maxMemoryBytes', 64 * 1024 * 1024);
  if (budgetInput.privacy !== 'local-only' && budgetInput.privacy !== 'explicit-sharing') {
    fail('processor-privacy', '$.budgets.privacy');
  }
  return Object.freeze({ schemaVersion: 1, id, version, codeSha256, inputs, outputs,
    configuration, state, assets, license,
    budgets: Object.freeze({ maxComputeMs, maxMemoryBytes, privacy: budgetInput.privacy }) });
}
