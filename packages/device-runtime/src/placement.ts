import { DeviceValidationError, parseAssetReference, parseWorkloadRequirements, snapshotJson } from '@101/device-model';
import type { AssetReference, WorkloadRequirements, WorkloadResource } from '@101/device-model';

export interface PlacementPrincipal {
  readonly principalId: string; readonly applicationId: string; readonly sessionId: string;
}
export interface PlacementAuthorityRequest extends PlacementPrincipal {
  readonly hostId: string; readonly ownerId: string; readonly deviceId: string;
  readonly capability: string; readonly operation: WorkloadResource['operation'];
}
export interface PlacementResource extends WorkloadResource { readonly ownerId: string }
export interface Placement {
  readonly id: string; readonly hostId: string; readonly resources: readonly PlacementResource[];
  readonly omittedOptional: readonly string[];
}
export type PlacementResult = Readonly<{ ok: true; placement: Placement }> |
  Readonly<{ ok: false; reason: 'incompatible' | 'capacity' | 'unauthorized' }>;
export interface PlacementScheduler {
  place(workload: unknown, principal: unknown): PlacementResult;
  release(placementId: string): boolean;
}
export interface PlacementSchedulerOptions {
  readonly context: unknown;
  /** Trusted, currently observed host inventory; the scheduler does not authenticate self-reported inventories. */
  readonly hosts: unknown;
  /** Read-only check for an existing owner grant scoped to this host, principal and operation. */
  readonly isAuthorized: (request: Readonly<PlacementAuthorityRequest>) => boolean;
}

interface Host {
  id: string;
  runtimes: { platform: string; version: string }[];
  applications: { id: string; version: string; codeSha256: string }[];
  processors: { id: string; version: string; codeSha256: string }[];
  assets: Readonly<AssetReference>[];
  resources: Omit<PlacementResource, 'required'>[];
  sharingDestinations: string[];
  quota: { maxComputeMs: number; maxMemoryBytes: number; maxWorkloads: number };
}

function fail(path: string): never { throw new DeviceValidationError('placement-invalid', path); }
function object(input: unknown, path: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail(path);
  return input as Record<string, unknown>;
}
function exact(input: Record<string, unknown>, fields: readonly string[], path: string): void {
  if (Object.keys(input).sort().join('\0') !== [...fields].sort().join('\0')) fail(path);
}
function list(input: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(input) || input.length > max) fail(path);
  return input;
}
function text(input: unknown, path: string): string {
  if (typeof input !== 'string' || !input.length || input.length > 128 || input.trim() !== input ||
      Array.from(input).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) fail(path);
  return input as string;
}
function version(input: unknown, path: string): string {
  if (typeof input !== 'string' || input.length > 64 ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?$/.test(input)) fail(path);
  return input as string;
}
function pin(input: unknown, path: string): string {
  if (typeof input !== 'string' || !/^[0-9a-f]{64}$/.test(input)) fail(path);
  return input as string;
}
function positive(input: unknown, path: string, max: number): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1 || input > max) fail(path);
  return input as number;
}
function unique<T>(items: T[], key: (item: T) => string, path: string): T[] {
  if (new Set(items.map(key)).size !== items.length) fail(path);
  return items;
}
function parseHost(input: unknown, path: string): Host {
  const value = object(input, path);
  exact(value, ['id', 'runtimes', 'applications', 'processors', 'assets', 'resources', 'sharingDestinations', 'quota'], path);
  const id = text(value.id, `${path}.id`);
  const runtimes = unique(list(value.runtimes, `${path}.runtimes`, 8).map((item, index) => {
    const at = `${path}.runtimes[${index}]`, runtime = object(item, at);
    exact(runtime, ['platform', 'version'], at);
    if (runtime.platform !== 'node' && runtime.platform !== 'browser' && runtime.platform !== 'native') fail(`${at}.platform`);
    return { platform: runtime.platform, version: version(runtime.version, `${at}.version`) };
  }), item => item.platform, `${path}.runtimes`);
  const installed = (input: unknown, at: string) => unique(list(input, at, 64).map((item, index) => {
    const path = `${at}[${index}]`, entry = object(item, path);
    exact(entry, ['id', 'version', 'codeSha256'], path);
    return { id: text(entry.id, `${path}.id`), version: version(entry.version, `${path}.version`),
      codeSha256: pin(entry.codeSha256, `${path}.codeSha256`) };
  }), item => item.id, at);
  const applications = installed(value.applications, `${path}.applications`);
  const processors = installed(value.processors, `${path}.processors`);
  const assets = unique(list(value.assets, `${path}.assets`, 64).map(parseAssetReference), item => item.id, `${path}.assets`);
  const resources = unique(list(value.resources, `${path}.resources`, 128).map((item, index) => {
    const at = `${path}.resources[${index}]`, resource = object(item, at);
    exact(resource, ['deviceId', 'capability', 'operation', 'ownerId'], at);
    if (resource.operation !== 'read' && resource.operation !== 'subscribe' &&
        resource.operation !== 'write' && resource.operation !== 'invoke') fail(`${at}.operation`);
    return { deviceId: text(resource.deviceId, `${at}.deviceId`), capability: text(resource.capability, `${at}.capability`),
      operation: resource.operation as WorkloadResource['operation'], ownerId: text(resource.ownerId, `${at}.ownerId`) };
  }), item => `${item.deviceId}\0${item.capability}\0${item.operation}`, `${path}.resources`);
  const sharingDestinations = unique(list(value.sharingDestinations, `${path}.sharingDestinations`, 16)
    .map((item, index) => text(item, `${path}.sharingDestinations[${index}]`)), item => item, `${path}.sharingDestinations`);
  const quotaInput = object(value.quota, `${path}.quota`);
  exact(quotaInput, ['maxComputeMs', 'maxMemoryBytes', 'maxWorkloads'], `${path}.quota`);
  const quota = { maxComputeMs: positive(quotaInput.maxComputeMs, `${path}.quota.maxComputeMs`, 100000),
    maxMemoryBytes: positive(quotaInput.maxMemoryBytes, `${path}.quota.maxMemoryBytes`, 1024 * 1024 * 1024),
    maxWorkloads: positive(quotaInput.maxWorkloads, `${path}.quota.maxWorkloads`, 10000) };
  return { id, runtimes, applications, processors, assets, resources, sharingDestinations, quota };
}
function parsePrincipal(input: unknown, applicationId: string): PlacementPrincipal {
  const value = object(snapshotJson(input), '$.principal');
  exact(value, ['principalId', 'applicationId', 'sessionId'], '$.principal');
  const principalId = text(value.principalId, '$.principal.principalId');
  const declaredApp = text(value.applicationId, '$.principal.applicationId');
  const sessionId = text(value.sessionId, '$.principal.sessionId');
  if (declaredApp !== applicationId) fail('$.principal.applicationId');
  return Object.freeze({ principalId, applicationId, sessionId });
}
function compareVersion(left: string, right: string): number {
  const leftDash = left.indexOf('-'), rightDash = right.indexOf('-');
  const leftCore = leftDash < 0 ? left : left.slice(0, leftDash), leftPre = leftDash < 0 ? undefined : left.slice(leftDash + 1);
  const rightCore = rightDash < 0 ? right : right.slice(0, rightDash), rightPre = rightDash < 0 ? undefined : right.slice(rightDash + 1);
  for (let index = 0; index < 3; index++) {
    const a = BigInt(leftCore!.split('.')[index]!), b = BigInt(rightCore!.split('.')[index]!);
    if (a !== b) return a < b ? -1 : 1;
  }
  if (leftPre === undefined || rightPre === undefined) return leftPre === rightPre ? 0 : leftPre === undefined ? 1 : -1;
  const a = leftPre.split('.'), b = rightPre.split('.');
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const x = a[index]!, y = b[index]!;
    if (x === y) continue;
    const xNumber = /^\d+$/.test(x), yNumber = /^\d+$/.test(y);
    if (xNumber && yNumber) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xNumber !== yNumber) return xNumber ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return Math.sign(a.length - b.length);
}
function compatible(host: Host, workload: WorkloadRequirements): boolean {
  const runtime = (requirement: { platform: string; minimumVersion: string }) =>
    host.runtimes.some(item => item.platform === requirement.platform && compareVersion(item.version, requirement.minimumVersion) >= 0);
  const pinned = (entries: Host['applications'], id: string, itemVersion: string, sha256: string) =>
    entries.some(item => item.id === id && item.version === itemVersion && item.codeSha256 === sha256);
  return runtime(workload.application.runtime) &&
    pinned(host.applications, workload.id, workload.version, workload.application.codeSha256) &&
    workload.processors.every(item => runtime(item.runtime) &&
      pinned(host.processors, item.manifest.id, item.manifest.version, item.manifest.codeSha256)) &&
    workload.assets.every(asset => host.assets.some(item => item.id === asset.id && item.kind === asset.kind &&
      item.mediaType === asset.mediaType && item.byteLength === asset.byteLength && item.sha256 === asset.sha256)) &&
    workload.privacy.destinations.every(destination => host.sharingDestinations.includes(destination)) &&
    workload.resources.every(resource => !resource.required || host.resources.some(item =>
      item.deviceId === resource.deviceId && item.capability === resource.capability && item.operation === resource.operation));
}

/** Reserves local placement capacity after exact compatibility and owner-grant checks. */
export function createPlacementScheduler(options: PlacementSchedulerOptions): PlacementScheduler {
  if (options === null || typeof options !== 'object' || typeof options.isAuthorized !== 'function') fail('$.options');
  const hosts = unique(list(snapshotJson(options.hosts), '$.hosts', 64).map((item, index) =>
    parseHost(item, `$.hosts[${index}]`)), item => item.id, '$.hosts');
  const reservations = new Map<string, { host: Host; compute: number; memory: number }>();
  const usage = new Map(hosts.map(host => [host.id, { compute: 0, memory: 0, workloads: 0 }]));
  let sequence = 0, placing = false;
  return Object.freeze({
    place(workloadInput: unknown, principalInput: unknown): PlacementResult {
      if (placing) fail('$.place.reentrant');
      const workload = parseWorkloadRequirements(workloadInput, options.context);
      const principal = parsePrincipal(principalInput, workload.id);
      let reason: 'incompatible' | 'capacity' | 'unauthorized' = 'incompatible';
      placing = true;
      try {
        for (const host of hosts) {
          if (!compatible(host, workload)) continue;
          const used = usage.get(host.id)!;
          if (used.workloads >= host.quota.maxWorkloads ||
              used.compute + workload.budget.maxComputeMs > host.quota.maxComputeMs ||
              used.memory + workload.budget.maxMemoryBytes > host.quota.maxMemoryBytes) {
            reason = 'capacity'; continue;
          }
          const resources: PlacementResource[] = [], omittedOptional: string[] = [];
          let denied = false;
          for (const requirement of workload.resources) {
            const available = host.resources.find(item => item.deviceId === requirement.deviceId &&
              item.capability === requirement.capability && item.operation === requirement.operation);
            const authorized = available !== undefined && (() => {
              try { return options.isAuthorized(Object.freeze({ ...principal, hostId: host.id, ownerId: available.ownerId,
                deviceId: requirement.deviceId, capability: requirement.capability, operation: requirement.operation })) === true; }
              catch { return false; }
            })();
            if (!authorized) {
              if (requirement.required) { denied = true; break; }
              omittedOptional.push(`${requirement.deviceId}/${requirement.capability}`);
            } else resources.push(Object.freeze({ ...requirement, ownerId: available.ownerId }));
          }
          if (denied) { reason = 'unauthorized'; continue; }
          const id = `placement-${++sequence}`;
          used.compute += workload.budget.maxComputeMs;
          used.memory += workload.budget.maxMemoryBytes;
          used.workloads++;
          reservations.set(id, { host, compute: workload.budget.maxComputeMs, memory: workload.budget.maxMemoryBytes });
          return Object.freeze({ ok: true, placement: Object.freeze({ id, hostId: host.id,
            resources: Object.freeze(resources), omittedOptional: Object.freeze(omittedOptional) }) });
        }
        return Object.freeze({ ok: false, reason });
      } finally { placing = false; }
    },
    release(id: string): boolean {
      const reservation = reservations.get(id);
      if (!reservation) return false;
      reservations.delete(id);
      const used = usage.get(reservation.host.id)!;
      used.compute -= reservation.compute; used.memory -= reservation.memory; used.workloads--;
      return true;
    },
  });
}
