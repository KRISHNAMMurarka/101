import { parseDeviceDescriptor } from './descriptor.ts';
import type { DeviceCapability } from './descriptor.ts';

export const HAPTIC_PROFILE_IDS = Object.freeze(['app:expo-haptic-presets/1', 'app:browser-haptic-presets/1'] as const);
export type HapticProfileId = typeof HAPTIC_PROFILE_IDS[number];
export type HapticPreset = 'tap' | 'impact' | 'warning';
export const HAPTIC_OUTPUT_LIMITS = Object.freeze({ maxAgeMs: 100, maxHz: 10, queueCapacity: 1, maxInFlight: 1, maxRecords: 64 });
export interface HapticOutputProfile {
  readonly id: HapticProfileId;
  readonly capability: DeviceCapability;
  readonly duration: Readonly<{ control: 'platform-preset' | 'fixed-request'; custom: false; maxRequestedMs?: number }>;
  readonly intensity: Readonly<{ control: 'platform-preset' | 'unsupported'; custom: false }>;
  readonly physicalCancellation: 'unsupported' | 'api-request-only';
  readonly requestedPatterns?: Readonly<Record<HapticPreset, readonly number[]>>;
}
const capability = parseDeviceDescriptor({ schemaVersion: 1, id: 'haptic-profile', label: 'Haptic presets', revision: 1,
  adapter: { id: 'app:haptic-presets', version: '1' }, runtime: { platform: 'declaration' }, capabilities: [
    { id: 'preset', semantic: 'app:haptic-preset/1', schemaVersion: 1, kind: 'command',
      value: { type: 'enum', values: ['tap', 'impact', 'warning'] }, permissions: ['invoke'],
      ownership: { mode: 'exclusive' }, delivery: { mode: 'reliable', maxAgeMs: HAPTIC_OUTPUT_LIMITS.maxAgeMs } },
  ] }).capabilities[0]!;
const profiles: Readonly<Record<HapticProfileId, HapticOutputProfile>> = Object.freeze({
  'app:expo-haptic-presets/1': Object.freeze({ id: 'app:expo-haptic-presets/1', capability,
    duration: Object.freeze({ control: 'platform-preset', custom: false }),
    intensity: Object.freeze({ control: 'platform-preset', custom: false }), physicalCancellation: 'unsupported' }),
  'app:browser-haptic-presets/1': Object.freeze({ id: 'app:browser-haptic-presets/1', capability,
    duration: Object.freeze({ control: 'fixed-request', custom: false, maxRequestedMs: 135 }),
    intensity: Object.freeze({ control: 'unsupported', custom: false }), physicalCancellation: 'api-request-only',
    requestedPatterns: Object.freeze({ tap: Object.freeze([15]), impact: Object.freeze([35]), warning: Object.freeze([50, 35, 50]) }) }),
});

/** Preset names describe API requests, never measured intensity, duration, or physical distinction. */
export function getHapticOutputProfile(id: string): HapticOutputProfile {
  if (!HAPTIC_PROFILE_IDS.includes(id as HapticProfileId)) throw new TypeError('Unsupported haptic profile');
  return profiles[id as HapticProfileId];
}
