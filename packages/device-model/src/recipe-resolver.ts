import { DeviceValidationError, parseDeviceDescriptor, snapshotJson } from './descriptor.ts';
import type { DeviceCapability, DeviceDescriptor, ValueSchema } from './descriptor.ts';
import { parseProcessorManifest } from './processor-manifest.ts';
import type { ProcessorManifest } from './processor-manifest.ts';
import { parseRecipe } from './recipe.ts';
import type { Recipe, RecipeEndpoint, RecipePermission, RecipeRoute } from './recipe.ts';
import { parseSignalValue, schemasCompatible } from './sample.ts';

export interface RecipeSelection { readonly deviceId: string; readonly capability: string }
export interface RecipeAlternative extends RecipeSelection { readonly compatible: boolean }
export interface RecipeResolutionIssue {
  readonly code: 'resource-unselected' | 'resource-incompatible' | 'processor-unavailable' |
    'processor-configuration' | 'route-incompatible';
  readonly target: string; readonly message: string;
  readonly alternatives?: readonly RecipeAlternative[];
}
export interface ResolvedRecipe {
  readonly recipe: Readonly<Recipe>;
  readonly resources: readonly Readonly<{ id: string; device: Readonly<DeviceDescriptor>; capability: string }>[];
  readonly processors: readonly Readonly<{ id: string; manifest: Readonly<ProcessorManifest>; configuration: Readonly<Record<string, unknown>> }>[];
  readonly routes: readonly RecipeRoute[];
  readonly executionOrder: readonly string[];
  /** A declaration to request owner permission, never a grant. */
  readonly requiredOperations: readonly Readonly<{
    route: string; side: 'from' | 'to'; deviceId: string; capability: string;
    operation: RecipePermission['operation']; purpose: string;
  }>[];
}
export type RecipeResolution = Readonly<{ ok: true; value: Readonly<ResolvedRecipe> }> |
  Readonly<{ ok: false; issues: readonly Readonly<RecipeResolutionIssue>[] }>;

function fail(code: string, path: string): never { throw new DeviceValidationError(code, path); }
function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    fail('recipe-environment-object', path);
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail('recipe-environment-key', path);
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property?.enumerable || !Object.hasOwn(property, 'value')) fail('recipe-environment-property', `${path}.${key}`);
    Object.defineProperty(copy, key, { value: property.value, enumerable: true });
  }
  return copy;
}
function exact(value: Record<string, unknown>, fields: readonly string[], path: string): void {
  if (Object.keys(value).sort().join('\0') !== [...fields].sort().join('\0')) fail('recipe-environment-fields', path);
}
function list(value: unknown, path: string, max: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max)
    fail('recipe-environment-list', path);
  const entries: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property?.enumerable || !Object.hasOwn(property, 'value')) fail('recipe-environment-item', `${path}[${index}]`);
    entries.push(property.value);
  }
  if (Reflect.ownKeys(value).length !== entries.length + 1) fail('recipe-environment-list', path);
  return entries;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const fields = value as Record<string, unknown>;
    return `{${Object.keys(fields).sort().map(key => `${JSON.stringify(key)}:${canonical(fields[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function operationAllowed(capability: DeviceCapability, operation: RecipePermission['operation']): boolean {
  if (!capability.permissions.includes(operation)) return false;
  if (operation === 'read') return capability.kind === 'property' && capability.delivery.mode === 'latest';
  if (operation === 'subscribe') return true;
  if (operation === 'invoke') return capability.kind === 'command' || capability.kind === 'job';
  return capability.kind !== 'command' && capability.kind !== 'job';
}

/** Resolve only host-selected, inert declarations. It never loads code or grants access. */
export function resolveRecipe(recipeInput: unknown, environmentInput: unknown): RecipeResolution {
  const recipe = parseRecipe(recipeInput);
  const environment = object(environmentInput, '$.environment');
  exact(environment, ['devices', 'processors', 'selections'], '$.environment');
  const devices = list(environment.devices, '$.environment.devices', 32)
    .map(item => parseDeviceDescriptor(item));
  if (new Set(devices.map(device => device.id)).size !== devices.length)
    fail('recipe-duplicate-device', '$.environment.devices');
  const manifests = list(environment.processors, '$.environment.processors', 16)
    .map(item => parseProcessorManifest(item));
  const selections = object(snapshotJson(environment.selections), '$.environment.selections');
  if (Object.keys(selections).some(id => !recipe.resources.some(resource => resource.id === id)))
    fail('recipe-unknown-selection', '$.environment.selections');
  const issues: RecipeResolutionIssue[] = [];
  const resources: ResolvedRecipe['resources'][number][] = [];
  for (const resource of recipe.resources) {
    const permissions = recipe.permissions.filter(permission => recipe.routes.some(route =>
      route.id === permission.route && route[permission.side].node === resource.id));
    const options = devices.flatMap(device => device.capabilities.filter(capability => capability.semantic === resource.semantic)
      .map(capability => Object.freeze({ deviceId: device.id, capability: capability.id,
        compatible: capability.schemaVersion === resource.schemaVersion &&
          permissions.every(permission => operationAllowed(capability, permission.operation)) })));
    const selectionInput = selections[resource.id];
    if (selectionInput === undefined) {
      issues.push(Object.freeze({ code: 'resource-unselected', target: resource.id,
        message: `Select a ${resource.semantic} source or sink for ${resource.id}`,
        alternatives: Object.freeze(options) }));
      continue;
    }
    const selection = object(selectionInput, `$.environment.selections.${resource.id}`);
    exact(selection, ['deviceId', 'capability'], `$.environment.selections.${resource.id}`);
    if (typeof selection.deviceId !== 'string' || typeof selection.capability !== 'string' ||
        selection.deviceId.length > 160 || selection.capability.length > 64)
      fail('recipe-selection', `$.environment.selections.${resource.id}`);
    const option = options.find(item => item.deviceId === selection.deviceId && item.capability === selection.capability);
    if (!option?.compatible) {
      issues.push(Object.freeze({ code: 'resource-incompatible', target: resource.id,
        message: `Selected ${resource.id} lacks semantic ${resource.semantic}, schema ${resource.schemaVersion}, or required operations`,
        alternatives: Object.freeze(options) }));
      continue;
    }
    const device = devices.find(item => item.id === selection.deviceId)!;
    resources.push(Object.freeze({ id: resource.id, device, capability: selection.capability }));
  }
  const processors: ResolvedRecipe['processors'][number][] = [];
  for (const processor of recipe.processors) {
    const manifest = manifests.find(item => item.id === processor.manifest.id &&
      item.version === processor.manifest.version && item.codeSha256 === processor.manifest.codeSha256);
    if (!manifest) {
      issues.push(Object.freeze({ code: 'processor-unavailable', target: processor.id,
        message: `Pinned processor ${processor.manifest.id}@${processor.manifest.version} (${processor.manifest.codeSha256}) is not installed` }));
      continue;
    }
    try { parseSignalValue(processor.configuration, manifest.configuration); }
    catch {
      issues.push(Object.freeze({ code: 'processor-configuration', target: processor.id,
        message: `Configuration does not match installed processor ${manifest.id}@${manifest.version}` }));
      continue;
    }
    processors.push(Object.freeze({ id: processor.id, manifest, configuration: processor.configuration }));
  }
  if (issues.length) return Object.freeze({ ok: false, issues: Object.freeze(issues) });
  const byResource = new Map(resources.map(item => [item.id, item]));
  const byProcessor = new Map(processors.map(item => [item.id, item]));
  const endpoint = (reference: RecipeEndpoint, output: boolean): { schema: ValueSchema; capability?: DeviceCapability } | undefined => {
    const resource = byResource.get(reference.node);
    if (resource) {
      const capability = resource.device.capabilities.find(item => item.id === resource.capability);
      return capability ? { schema: capability.value, capability } : undefined;
    }
    const processor = byProcessor.get(reference.node);
    const port = (output ? processor?.manifest.outputs : processor?.manifest.inputs)?.find(item => item.id === reference.port);
    return port ? { schema: port.value } : undefined;
  };
  const inbound = new Map<string, number>(), outbound = new Map<string, number>();
  const successors = new Map([...recipe.resources, ...recipe.processors].map(item => [item.id, [] as string[]]));
  const degree = new Map([...recipe.resources, ...recipe.processors].map(item => [item.id, 0]));
  for (const route of recipe.routes) {
    const from = endpoint(route.from, true), to = endpoint(route.to, false);
    const direct = from?.capability && to?.capability;
    if (!from || !to || (direct
      ? !schemasCompatible(from.capability!, to.capability!) ||
        from.capability!.delivery.mode !== to.capability!.delivery.mode
      : canonical(from.schema) !== canonical(to.schema))) {
      issues.push(Object.freeze({ code: 'route-incompatible', target: route.id,
        message: `Selected route ${route.id} has a missing port or incompatible value/delivery schema` }));
      continue;
    }
    const inPort = `${route.to.node}\0${route.to.port}`;
    inbound.set(inPort, (inbound.get(inPort) ?? 0) + 1);
    const outPort = `${route.from.node}\0${route.from.port}`;
    outbound.set(outPort, (outbound.get(outPort) ?? 0) + 1);
    successors.get(route.from.node)!.push(route.to.node);
    degree.set(route.to.node, degree.get(route.to.node)! + 1);
  }
  for (const processor of processors) {
    for (const input of processor.manifest.inputs)
      if (inbound.get(`${processor.id}\0${input.id}`) !== 1) issues.push(Object.freeze({
        code: 'route-incompatible', target: processor.id,
        message: `Processor input ${processor.id}.${input.id} needs one compatible route` }));
    for (const output of processor.manifest.outputs)
      if (!outbound.get(`${processor.id}\0${output.id}`)) issues.push(Object.freeze({
        code: 'route-incompatible', target: processor.id,
        message: `Processor output ${processor.id}.${output.id} needs a compatible route` }));
  }
  const queue = [...degree].filter(([, count]) => count === 0).map(([id]) => id);
  const executionOrder: string[] = [];
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!;
    executionOrder.push(id);
    for (const next of successors.get(id)!) {
      const remaining = degree.get(next)! - 1;
      degree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  if (executionOrder.length !== degree.size) issues.push(Object.freeze({
    code: 'route-incompatible', target: recipe.id, message: 'Selected recipe routes contain a cycle' }));
  if (issues.length) return Object.freeze({ ok: false, issues: Object.freeze(issues) });
  const requiredOperations = recipe.routes.flatMap(route => recipe.permissions.filter(permission => permission.route === route.id)
    .map(permission => {
      const reference = route[permission.side], resource = byResource.get(reference.node)!;
      return Object.freeze({ route: route.id, side: permission.side, deviceId: resource.device.id,
        capability: resource.capability, operation: permission.operation, purpose: permission.purpose });
    }));
  return Object.freeze({ ok: true, value: Object.freeze({ recipe, resources: Object.freeze(resources),
    processors: Object.freeze(processors), routes: recipe.routes, executionOrder: Object.freeze(executionOrder),
    requiredOperations: Object.freeze(requiredOperations) }) });
}
