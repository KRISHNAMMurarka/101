import { DeviceValidationError, parseDeviceDescriptor, parseRecipe, resolveRecipe } from '@101/device-model';
import type { DeviceDescriptor, Recipe, RecipeEndpoint, RecipeResolution, ResolvedRecipe,
  RouteGroupMember, ValueSchema } from '@101/device-model';
import { createRouteGroupController } from './route-group-runtime.ts';
import type { RouteGroupController } from './route-group-runtime.ts';
import { failure, success } from './scheduler.ts';
import type { Result } from './scheduler.ts';
import type { DeviceRuntime, EndpointHandle } from './types.ts';

export interface RecipeEndpointBinding {
  readonly device: unknown; readonly capability: string; readonly handle: EndpointHandle;
}
export interface RecipeConsentPreview {
  readonly recipeId: string; readonly version: string;
  readonly resources: ResolvedRecipe['resources'];
  readonly requiredOperations: ResolvedRecipe['requiredOperations'];
}
export interface RecipeSessionOptions {
  readonly runtime: DeviceRuntime;
  readonly identity: Readonly<{ principalId: string; applicationId: string; sessionId: string }>;
  /** Read current host inventory and explicit choices on every attempt. */
  getEnvironment(): unknown;
  /** UI/owner decision. The runtime still obtains each concrete grant. */
  requestConsent(preview: Readonly<RecipeConsentPreview>): boolean | Promise<boolean>;
  /** Return an existing host registration; do not create side effects here. */
  bind(endpoint: Readonly<RecipeEndpoint>, side: 'from' | 'to'): RecipeEndpointBinding;
}
export interface RecipeSession {
  readonly recipe: Readonly<Recipe>;
  preview(): RecipeResolution;
  start(): Promise<Result<Readonly<{ active: readonly string[]; omittedOptional: readonly string[] }>>>;
  stop(reason?: string): void;
  status(): Readonly<{ state: 'idle' | 'awaiting-consent' | 'active' | 'paused' | 'closed';
    omittedOptional: readonly string[] }>;
}

function fail(code: string, path: string): never { throw new DeviceValidationError(code, path); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const fields = value as Record<string, unknown>;
    return `{${Object.keys(fields).sort().map(key => `${JSON.stringify(key)}:${canonical(fields[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
type BoundEndpoint = Readonly<{ device: Readonly<DeviceDescriptor>; capability: string; handle: EndpointHandle }>;

function bindPlan(plan: Readonly<ResolvedRecipe>, options: RecipeSessionOptions): RouteGroupController {
  const bindings = new Map<string, BoundEndpoint>();
  const byResource = new Map(plan.resources.map(item => [item.id, item]));
  const byProcessor = new Map(plan.processors.map(item => [item.id, item]));
  function bound(reference: RecipeEndpoint, side: 'from' | 'to'): BoundEndpoint {
    const key = `${reference.node}\0${reference.port}\0${side}`;
    const existing = bindings.get(key);
    if (existing) return existing;
    const offered = options.bind(reference, side);
    if (!offered || typeof offered.capability !== 'string' || typeof offered.handle?.id !== 'string' ||
        !offered.handle.id) fail('recipe-binding', `$.bindings.${reference.node}.${reference.port}`);
    const device = parseDeviceDescriptor(offered.device);
    const capability = device.capabilities.find(item => item.id === offered.capability);
    if (!capability) fail('recipe-binding-capability', `$.bindings.${reference.node}.${reference.port}`);
    const resource = byResource.get(reference.node);
    if (resource) {
      if (resource.device.id !== device.id || resource.capability !== capability.id ||
          canonical(resource.device) !== canonical(device)) fail('recipe-binding-changed', `$.bindings.${reference.node}`);
    } else {
      const processor = byProcessor.get(reference.node);
      const port = (side === 'from' ? processor?.manifest.outputs : processor?.manifest.inputs)
        ?.find(item => item.id === reference.port);
      if (!port || canonical(port.value as ValueSchema) !== canonical(capability.value))
        fail('recipe-binding-processor-port', `$.bindings.${reference.node}.${reference.port}`);
    }
    const result = Object.freeze({ device, capability: capability.id, handle: offered.handle });
    bindings.set(key, result);
    return result;
  }
  const endpoints = new Map(plan.routes.map(route => [route.id, Object.freeze({
    from: bound(route.from, 'from'), to: bound(route.to, 'to'),
  })]));
  const devices = new Map<string, Readonly<DeviceDescriptor>>();
  for (const item of endpoints.values()) for (const endpoint of [item.from, item.to]) {
    const previous = devices.get(endpoint.device.id);
    if (previous && canonical(previous) !== canonical(endpoint.device)) fail('recipe-binding-duplicate-device', '$.bindings');
    devices.set(endpoint.device.id, endpoint.device);
  }
  const member = (route: ResolvedRecipe['routes'][number]) => {
    const pair = endpoints.get(route.id)!;
    const permissions = plan.requiredOperations.filter(item => item.route === route.id);
    const from = permissions.find(item => item.side === 'from')?.operation ?? 'subscribe';
    const sinkCapability = pair.to.device.capabilities.find(item => item.id === pair.to.capability)!;
    const to = permissions.find(item => item.side === 'to')?.operation ??
      (sinkCapability.kind === 'command' || sinkCapability.kind === 'job' ? 'invoke' : 'write');
    const purpose = permissions.length ? permissions.map(item => item.purpose).join('; ') : 'Run declared processor route';
    const startAfter = plan.routes.filter(other => other.to.node === route.from.node &&
      plan.processors.some(processor => processor.id === route.from.node)).map(other => other.id);
    return Object.freeze({ id: route.id, required: route.required,
      from: { deviceId: pair.from.device.id, capability: pair.from.capability, operation: from },
      to: { deviceId: pair.to.device.id, capability: pair.to.capability, operation: to },
      startAfter, consent: { purpose, sourceOwner: 'required', sinkOwner: 'required' },
      compensation: { prepared: 'release-grant', active: 'stop-route', physicalEffects: 'not-undone' },
      safeState: { mode: 'provider-release' } });
  };
  const contract = { schemaVersion: 1, id: plan.recipe.id, members: plan.routes.map(member),
    failure: { required: 'stop-all', optional: 'continue-degraded' },
    recovery: { required: 'pause', optional: 'continue-degraded' } };
  return createRouteGroupController(contract, [...devices.values()], (item: Readonly<RouteGroupMember>) => {
    const pair = endpoints.get(item.id)!;
    return options.runtime.route({ from: pair.from.handle, to: pair.to.handle,
      ...options.identity, sourceOperation: item.from.operation as 'read' | 'subscribe' });
  });
}

/** Consent-gated execution of a freshly resolved recipe on host-owned registrations. */
export function createRecipeSession(recipeInput: unknown, options: RecipeSessionOptions): RecipeSession {
  const recipe = parseRecipe(recipeInput);
  if (!options || typeof options.getEnvironment !== 'function' ||
      typeof options.requestConsent !== 'function' || typeof options.bind !== 'function' ||
      typeof options.runtime?.route !== 'function') fail('recipe-session-options', '$.options');
  let group: RouteGroupController | undefined, closed = false, busy = false, generation = 0;
  const preview = () => resolveRecipe(recipe, options.getEnvironment());
  async function start(): ReturnType<RecipeSession['start']> {
    if (closed) return failure('closed');
    if (busy) return failure('reentrant');
    if (group && (group.status().state === 'active' || group.status().state === 'prepared')) return failure('already-active');
    busy = true;
    const attempt = ++generation;
    try {
      let resolution: RecipeResolution;
      try { resolution = preview(); } catch { return failure('resolution-failed'); }
      if (!resolution.ok) return failure('resolution-failed');
      const access = Object.freeze({ recipeId: recipe.id, version: recipe.version,
        resources: resolution.value.resources, requiredOperations: resolution.value.requiredOperations });
      let approved: boolean;
      try { approved = await options.requestConsent(access) === true; }
      catch { return failure('consent-failed'); }
      if (closed || attempt !== generation) return failure('closed');
      if (!approved) return failure('consent-denied');
      group?.stop('recipe-retry'); group = undefined;
      let next: RouteGroupController;
      try { next = bindPlan(resolution.value, options); }
      catch { return failure('host-binding-failed'); }
      if (closed || attempt !== generation) { next.stop('recipe-stopped'); return failure('closed'); }
      group = next;
      const started = next.start();
      if (!started.ok) { group = undefined; return failure(started.reason); }
      return success(started.value);
    } finally { busy = false; }
  }
  function stop(reason = 'recipe-stopped'): void {
    if (closed) return;
    closed = true; generation++;
    group?.stop(reason); group = undefined;
  }
  function status(): ReturnType<RecipeSession['status']> {
    if (closed) return Object.freeze({ state: 'closed', omittedOptional: Object.freeze([]) });
    if (busy) return Object.freeze({ state: 'awaiting-consent', omittedOptional: Object.freeze([]) });
    const current = group?.status();
    if (current?.state === 'active' || current?.state === 'paused')
      return Object.freeze({ state: current.state, omittedOptional: current.omittedOptional });
    return Object.freeze({ state: 'idle', omittedOptional: Object.freeze([]) });
  }
  return Object.freeze({ recipe, preview, start, stop, status });
}
