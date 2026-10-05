import { parseDeviceDescriptor } from './descriptor.ts';
import type { DeviceCapability, ValueSchema } from './descriptor.ts';

export const INPUT_PROFILE_IDS = Object.freeze([
  'app:pointer/1', 'app:keyboard/1', 'app:text/1', 'app:gamepad/1',
  'app:touch/1', 'app:pen/1', 'app:switch/1',
] as const);
export type InputProfileId = typeof INPUT_PROFILE_IDS[number];

/** Source declarations only. A host still probes the device and grants each actual route. */
export interface InputProfile {
  readonly id: InputProfileId;
  readonly capabilities: readonly DeviceCapability[];
  readonly sinkOperations: Readonly<Record<string, 'write'>>;
}

const latest = Object.freeze({ mode: 'latest' as const, maxHz: 60, maxAgeMs: 100 });

function signal(id: string, semantic: string, value: ValueSchema, kind: 'sample' | 'event', schemaVersion = 1, eventMaxAgeMs = 1000): DeviceCapability {
  return { id, semantic, schemaVersion, kind, value,
    delivery: kind === 'sample' ? latest : { mode: 'reliable', maxAgeMs: eventMaxAgeMs },
    permissions: ['subscribe'] };
}

function profile(id: InputProfileId, capabilities: readonly DeviceCapability[]): InputProfile {
  const parsed = parseDeviceDescriptor({ schemaVersion: 1, id: 'input-profile-template', label: id, revision: 1,
    adapter: { id: 'app:input-profile', version: '1' }, runtime: { platform: 'declaration' }, capabilities });
  return Object.freeze({ id, capabilities: parsed.capabilities,
    sinkOperations: Object.freeze(Object.fromEntries(parsed.capabilities.map(capability => [capability.id, 'write' as const]))) });
}

const profiles = new Map<InputProfileId, InputProfile>([
  profile('app:pointer/1', [
    signal('position', 'app:pointer-position/1', { type: 'vector', components: ['x', 'y'], unit: '1',
      frame: 'surface-normalized', min: 0, max: 1 }, 'sample'),
    signal('contact', 'app:pointer-contact/1', { type: 'boolean' }, 'event', 1, 100),
  ]),
  profile('app:keyboard/1', [signal('key', 'app:key-transition/1', { type: 'key' }, 'event', 2)]),
  profile('app:text/1', [signal('composition', 'app:text-composition/1', { type: 'text', maxLength: 2048 }, 'event', 2)]),
  profile('app:gamepad/1', [
    signal('axes', 'app:gamepad-axes/1', { type: 'array', items: { type: 'scalar', unit: '1', min: -1, max: 1 },
      minItems: 0, maxItems: 16 }, 'sample'),
    signal('button', 'app:gamepad-button/1', { type: 'record', fields: {
      id: { type: 'enum', values: Array.from({ length: 32 }, (_, index) => `button-${index}`) },
      pressed: { type: 'boolean' }, pressure: { type: 'scalar', unit: '1', min: 0, max: 1 },
    } }, 'event'),
  ]),
  profile('app:touch/1', [signal('contact', 'app:touch-contact/1', { type: 'contact', frame: 'surface-normalized' }, 'event', 2)]),
  profile('app:pen/1', [signal('pen', 'app:pen-contact/1', { type: 'pen', frame: 'surface-normalized' }, 'event', 2)]),
  profile('app:switch/1', [signal('switch', 'app:switch-transition/1', { type: 'record', fields: {
    channel: { type: 'enum', values: Array.from({ length: 16 }, (_, index) => `switch-${index}`) },
    active: { type: 'boolean' },
  } }, 'event')]),
].map(value => [value.id, value]));

export function getInputProfile(id: string): InputProfile {
  const value = profiles.get(id as InputProfileId);
  if (!value) throw new RangeError(`Unknown input profile: ${id}`);
  return value;
}
