import { DeviceValidationError, snapshotJson } from './descriptor.ts';
import type { JsonValue } from './descriptor.ts';
import { compareClockStamps } from './observation-timing.ts';
import type { ClockStamp } from './observation-timing.ts';

export interface DeviceHealthFault {
  readonly code: string;
  readonly severity: 'warning' | 'blocking';
}
export interface DeviceHealthResource {
  readonly capabilityId: string;
  readonly state: 'available' | 'unavailable' | 'busy' | 'denied';
  readonly maxHz: number;
  readonly maxActiveRoutes: number;
}
export interface DeviceHealthReport {
  readonly schemaVersion: 1;
  readonly deviceId: string;
  readonly observed: ClockStamp;
  readonly maxAgeMs: number;
  readonly battery: Readonly<{ levelPercent: number; charging: boolean }> | null;
  readonly thermal: 'nominal' | 'elevated' | 'critical' | 'unknown';
  readonly firmware: Readonly<{ version: string }> | null;
  readonly connectivity: 'connected' | 'degraded' | 'offline' | 'unknown' | 'not-applicable';
  readonly faults: readonly DeviceHealthFault[];
  readonly resources: readonly DeviceHealthResource[];
}
export type DeviceHealthAssessment =
  | Readonly<{ readiness: 'available'; limits: Readonly<{ maxHz: number; maxActiveRoutes: number }> }>
  | Readonly<{ readiness: 'stale' | 'unavailable' | 'busy' | 'denied';
      reason: 'stale' | 'device' | 'resource' | 'connectivity' | 'thermal' | 'fault' | 'resource-state' }>;

const FAULT_CODE = /^[A-Za-z][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/;
function fail(code: string, path: string): never { throw new DeviceValidationError(code, path); }
function object(input: JsonValue | undefined, path: string): Record<string, JsonValue> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('health-object', path);
  return input;
}
function closed(value: Record<string, JsonValue>, keys: readonly string[], path: string): void {
  const names = Object.keys(value);
  if (names.length !== keys.length || names.some(name => !keys.includes(name)) || keys.some(name => !Object.hasOwn(value, name)))
    fail('health-fields', path);
}
function label(value: JsonValue | undefined, path: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.length || value.length > maxLength || value.trim() !== value ||
      Array.from(value).some(character => { const code = character.charCodeAt(0); return code < 32 || code === 127 || code >= 128 && code <= 159; }))
    fail('health-label', path);
  return value;
}
function boundedNumber(value: JsonValue | undefined, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail('health-number', path);
  return value;
}
function choice<T extends string>(value: JsonValue | undefined, choices: readonly T[], path: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) fail('health-choice', path);
  return value as T;
}

/** Parses inert provider claims. This cannot authenticate a physical device or its state. */
export function parseDeviceHealthReport(input: unknown): DeviceHealthReport {
  const value = object(snapshotJson(input), '$');
  closed(value, ['schemaVersion', 'deviceId', 'observed', 'maxAgeMs', 'battery', 'thermal',
    'firmware', 'connectivity', 'faults', 'resources'], '$');
  if (value.schemaVersion !== 1) fail('health-version', '$.schemaVersion');
  label(value.deviceId, '$.deviceId', 128);
  const observed = object(value.observed, '$.observed');
  closed(observed, ['clockId', 'at'], '$.observed');
  label(observed.clockId, '$.observed.clockId', 128);
  boundedNumber(observed.at, '$.observed.at', 0, Number.MAX_SAFE_INTEGER);
  boundedNumber(value.maxAgeMs, '$.maxAgeMs', Number.MIN_VALUE, 60000);
  if (value.battery !== null) {
    const battery = object(value.battery, '$.battery');
    closed(battery, ['levelPercent', 'charging'], '$.battery');
    boundedNumber(battery.levelPercent, '$.battery.levelPercent', 0, 100);
    if (typeof battery.charging !== 'boolean') fail('health-battery', '$.battery.charging');
  }
  choice(value.thermal, ['nominal', 'elevated', 'critical', 'unknown'], '$.thermal');
  if (value.firmware !== null) {
    const firmware = object(value.firmware, '$.firmware');
    closed(firmware, ['version'], '$.firmware');
    label(firmware.version, '$.firmware.version', 64);
  }
  choice(value.connectivity, ['connected', 'degraded', 'offline', 'unknown', 'not-applicable'], '$.connectivity');
  if (!Array.isArray(value.faults) || value.faults.length > 8) fail('health-faults', '$.faults');
  const faultCodes = new Set<string>();
  value.faults.forEach((entry, index) => {
    const path = `$.faults[${index}]`, fault = object(entry, path);
    closed(fault, ['code', 'severity'], path);
    const code = label(fault.code, `${path}.code`, 128);
    if (!FAULT_CODE.test(code) || faultCodes.has(code)) fail('health-fault-code', `${path}.code`);
    faultCodes.add(code);
    choice(fault.severity, ['warning', 'blocking'], `${path}.severity`);
  });
  if (!Array.isArray(value.resources) || value.resources.length < 1 || value.resources.length > 32)
    fail('health-resources', '$.resources');
  const resourceIds = new Set<string>();
  value.resources.forEach((entry, index) => {
    const path = `$.resources[${index}]`, resource = object(entry, path);
    closed(resource, ['capabilityId', 'state', 'maxHz', 'maxActiveRoutes'], path);
    const id = label(resource.capabilityId, `${path}.capabilityId`, 128);
    if (resourceIds.has(id)) fail('health-resource-id', `${path}.capabilityId`);
    resourceIds.add(id);
    choice(resource.state, ['available', 'unavailable', 'busy', 'denied'], `${path}.state`);
    boundedNumber(resource.maxHz, `${path}.maxHz`, Number.MIN_VALUE, 1000);
    if (typeof resource.maxActiveRoutes !== 'number' || !Number.isSafeInteger(resource.maxActiveRoutes) ||
        resource.maxActiveRoutes < 1 || resource.maxActiveRoutes > 4096)
      fail('health-resource-limit', `${path}.maxActiveRoutes`);
  });
  return value as unknown as DeviceHealthReport;
}

/** Checks a complete report at the caller's declared clock; resource limits remain provider claims. */
export function assessDeviceHealth(input: unknown, expectedDeviceId: string, capabilityId: string,
  now: ClockStamp): DeviceHealthAssessment {
  const report = parseDeviceHealthReport(input);
  const current = snapshotJson(now) as unknown as ClockStamp;
  compareClockStamps(report.observed, current);
  if (current.at < report.observed.at) fail('health-future', '$.now');
  if (current.at - report.observed.at > report.maxAgeMs) return Object.freeze({ readiness: 'stale', reason: 'stale' });
  if (report.deviceId !== expectedDeviceId) return Object.freeze({ readiness: 'unavailable', reason: 'device' });
  const resource = report.resources.find(entry => entry.capabilityId === capabilityId);
  if (!resource) return Object.freeze({ readiness: 'unavailable', reason: 'resource' });
  if (report.connectivity === 'offline' || report.connectivity === 'unknown')
    return Object.freeze({ readiness: 'unavailable', reason: 'connectivity' });
  if (report.thermal === 'critical' || report.thermal === 'unknown')
    return Object.freeze({ readiness: 'unavailable', reason: 'thermal' });
  if (report.faults.some(fault => fault.severity === 'blocking'))
    return Object.freeze({ readiness: 'unavailable', reason: 'fault' });
  if (resource.state !== 'available') return Object.freeze({ readiness: resource.state, reason: 'resource-state' });
  return Object.freeze({ readiness: 'available', limits: Object.freeze({ maxHz: resource.maxHz,
    maxActiveRoutes: resource.maxActiveRoutes }) });
}
