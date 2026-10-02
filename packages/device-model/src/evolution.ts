import { parseDeviceDescriptor } from './descriptor.ts';
import type { DeviceCapability, DeviceDescriptor } from './descriptor.ts';

export type DescriptorEvolution =
  | Readonly<{ compatibility: 'compatible'; addedCapabilities: readonly string[] }>
  | Readonly<{ compatibility: 'incompatible'; reason: 'revision' | 'identity' | 'capability' }>;

function same(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' ||
      Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((value, index) => same(value, right[index]));
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  const names = Object.keys(a);
  return names.length === Object.keys(b).length && names.every(name => Object.hasOwn(b, name) && same(a[name], b[name]));
}

function sameContract(old: DeviceCapability, next: DeviceCapability): boolean {
  return old.id === next.id && old.semantic === next.semantic && old.schemaVersion === next.schemaVersion &&
    old.kind === next.kind && same(old.value, next.value) && same(old.delivery, next.delivery) &&
    same([...old.permissions].sort(), [...next.permissions].sort()) && same(old.ownership, next.ownership);
}

/** Additive revision planning only; it does not migrate payloads or transfer grants. */
export function planDescriptorEvolution(previous: unknown, candidate: unknown): DescriptorEvolution {
  const old: DeviceDescriptor = parseDeviceDescriptor(previous);
  const next: DeviceDescriptor = parseDeviceDescriptor(candidate);
  if (next.revision <= old.revision) return Object.freeze({ compatibility: 'incompatible', reason: 'revision' });
  if (old.id !== next.id || old.adapter.id !== next.adapter.id || old.runtime.platform !== next.runtime.platform)
    return Object.freeze({ compatibility: 'incompatible', reason: 'identity' });
  const nextCapabilities = new Map(next.capabilities.map(capability => [capability.id, capability]));
  for (const capability of old.capabilities) {
    const replacement = nextCapabilities.get(capability.id);
    if (!replacement || !sameContract(capability, replacement))
      return Object.freeze({ compatibility: 'incompatible', reason: 'capability' });
  }
  const priorIds = new Set(old.capabilities.map(capability => capability.id));
  return Object.freeze({ compatibility: 'compatible', addedCapabilities: Object.freeze(next.capabilities
    .filter(capability => !priorIds.has(capability.id)).map(capability => capability.id)) });
}
