import { parseDeviceDescriptor, parseSignalValue } from '@101/connect';
import type { DeviceCapability, DeviceDescriptor, SignalValue, ValueSchema } from '@101/connect';

export interface ReadingChoice {
  readonly id: string; readonly label: string; readonly supported: boolean;
  readonly shape?: 'record' | 'table'; readonly fields: readonly string[];
  readonly columns: readonly Readonly<{ key: string; label: string; unit?: string; optional?: boolean }>[];
}
export interface ReadingTable {
  readonly columns: readonly Readonly<{ key: string; label: string; unit?: string }>[];
  readonly rows: readonly (readonly string[])[];
}
type RecordSchema = Extract<ValueSchema, { type: 'record' }>;
const deviceBase = { schemaVersion: 1, id: 'reading-validation', label: 'Reading', revision: 1,
  adapter: { id: 'app:reading-validation', version: '1' }, runtime: { platform: 'browser-application' } };
export const readingFieldLabel = (key: string) => key.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ').replace(/^./, first => first.toUpperCase());
function fieldsSupported(schema: RecordSchema): boolean {
  const fields = Object.entries(schema.fields);
  return fields.length >= 1 && fields.length <= 6 && fields.every(([key, value]) => key.length <= 32 &&
    (value.type === 'boolean' || value.type === 'scalar' && value.unit.length <= 16 || value.type === 'enum' &&
      value.values.length >= 1 && value.values.length <= 8 && value.values.every(choice => choice.length <= 24)));
}
function shape(capability: DeviceCapability): 'record' | 'table' | undefined {
  if (capability.schemaVersion !== 1 || !['sample', 'property'].includes(capability.kind) || !capability.permissions.includes('subscribe') ||
    capability.delivery.mode !== 'latest') return;
  if (capability.value.type === 'record' && fieldsSupported(capability.value)) return 'record';
  if (capability.value.type === 'array' && capability.value.minItems >= 1 && capability.value.maxItems <= 8 &&
    capability.value.items.type === 'record' && fieldsSupported(capability.value.items)) return 'table';
}
/** Presentation eligibility is derived from a validated capability, never a grant. */
export function readingChoices(input: unknown): readonly ReadingChoice[] {
  const device = parseDeviceDescriptor(input);
  if (device.capabilities.length > 8) throw new TypeError('Reading choices unavailable');
  const totals = new Map<'record' | 'table', number>();
  for (const capability of device.capabilities) { const kind = shape(capability); if (kind) totals.set(kind, (totals.get(kind) ?? 0) + 1); }
  const counts = new Map<'record' | 'table', number>();
  return Object.freeze(device.capabilities.map(capability => {
    const kind = shape(capability), schema = capability.value.type === 'array' ? capability.value.items : capability.value;
    if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
    const label = kind === 'record' ? 'One reading' : kind === 'table' ? 'Reading table' : 'Unavailable reading';
    return Object.freeze({ id: capability.id, label: label + (kind && (totals.get(kind) ?? 0) > 1 ? ` ${counts.get(kind)}` : ''),
      supported: kind !== undefined, ...(kind ? { shape: kind } : {}),
      fields: Object.freeze(kind && schema.type === 'record' ? Object.keys(schema.fields) : []),
      columns: Object.freeze(kind && schema.type === 'record' ? Object.entries(schema.fields).map(([key, field]) => Object.freeze({
        key, label: readingFieldLabel(key), ...(field.type === 'scalar' ? { unit: field.unit } : {}),
        ...(schema.optional?.includes(key) ? { optional: true } : {}) })) : []) });
  }));
}
function isRecord(value: SignalValue): value is { readonly [key: string]: SignalValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isArray(value: SignalValue): value is readonly SignalValue[] { return Array.isArray(value); }
/** Revalidate and snapshot both declaration and actual value before retaining cells. */
export function readingTable(input: unknown, value: unknown): ReadingTable | undefined {
  try {
    const capability = parseDeviceDescriptor({ ...deviceBase, capabilities: [input] }).capabilities[0];
    if (!capability || !shape(capability)) return;
    const schema = capability.value.type === 'array' ? capability.value.items : capability.value;
    if (schema.type !== 'record') return;
    const parsed = parseSignalValue(value, capability.value), items = isArray(parsed) ? parsed : [parsed];
    const columns = Object.freeze(Object.entries(schema.fields).map(([key, field]) => Object.freeze({ key, label: readingFieldLabel(key),
      ...(field.type === 'scalar' ? { unit: field.unit } : {}) })));
    const rows: (readonly string[])[] = [];
    for (const item of items) {
      if (!isRecord(item)) return;
      rows.push(Object.freeze(columns.map(column => {
        if (!Object.hasOwn(item, column.key)) return 'Not supplied';
        const cell = item[column.key]; return typeof cell === 'boolean' ? cell ? 'On' : 'Off' : String(cell);
      })));
    }
    return Object.freeze({ columns, rows: Object.freeze(rows) });
  } catch { return; }
}
/** Application form state only; no sensor, native device or saved identity claim. */
export function pageReadingDescriptor(epoch = 'unconnected'): Readonly<DeviceDescriptor> {
  const value: ValueSchema = { type: 'record', fields: { step: { type: 'scalar', unit: '1', min: 0, max: 100 },
    ready: { type: 'boolean' }, mode: { type: 'enum', values: ['count-up', 'count-down'] } }, optional: ['ready'] };
  return parseDeviceDescriptor({ ...deviceBase, id: `page-readings:${epoch}`, label: 'Readings from this page',
    adapter: { id: 'app:page-readings', version: '1' }, capabilities: [
      { id: 'reading', semantic: 'app:page-reading/1', schemaVersion: 1, kind: 'sample', permissions: ['subscribe'], value,
        delivery: { mode: 'latest', maxHz: 4, maxAgeMs: 1000 } },
      { id: 'table', semantic: 'app:page-reading-table/1', schemaVersion: 1, kind: 'sample', permissions: ['subscribe'],
        value: { type: 'array', minItems: 1, maxItems: 8, items: value }, delivery: { mode: 'latest', maxHz: 4, maxAgeMs: 1000 } },
    ] });
}
