import { DeviceValidationError, parseDeviceDescriptor, snapshotJson } from './descriptor.ts';
import type { DeviceCapability, DeviceDescriptor, JsonObject, JsonValue, ValueSchema } from './descriptor.ts';

const CONTEXT = 'https://www.w3.org/2022/wot/td/v1.1';
const PROFILE = 'urn:101:td:profile:1#';
const PROFILE_KEY = 'c101:descriptor';
const MAX_TD_BYTES = 65536;

export interface WoTBindings {
  readonly security: { readonly scheme: 'bearer' };
  readonly hrefs: Readonly<Record<string, string>>;
  readonly subscriptions: Readonly<Record<string, 'longpoll'>>;
}

export interface WoTForm {
  readonly op: string; readonly href: string; readonly contentType: 'application/json';
  readonly 'htv:methodName': 'GET' | 'POST'; readonly subprotocol?: 'longpoll';
}
export interface WoTAffordance {
  readonly type?: string; readonly minimum?: number; readonly maximum?: number; readonly unit?: string;
  readonly enum?: readonly string[]; readonly observable?: boolean; readonly readOnly?: boolean;
  readonly input?: JsonObject; readonly data?: JsonObject;
  readonly forms: readonly WoTForm[];
}
export interface WoTThingDescription {
  readonly '@context': readonly [typeof CONTEXT, { readonly c101: typeof PROFILE }];
  readonly '@type': 'Thing'; readonly id: string; readonly title: string;
  readonly version: { readonly instance: string };
  readonly securityDefinitions: { readonly bearer_sc: { readonly scheme: 'bearer' } };
  readonly security: 'bearer_sc';
  readonly properties: Readonly<Record<string, WoTAffordance>>;
  readonly actions: Readonly<Record<string, WoTAffordance>>;
  readonly events: Readonly<Record<string, WoTAffordance>>;
  readonly 'c101:descriptor': Readonly<DeviceDescriptor>;
}

function reject(code: string, path: string): never { throw new DeviceValidationError(code, path); }

function dataSchema(value: ValueSchema, path: string): JsonObject {
  if (value.type === 'boolean') return { type: 'boolean' };
  if (value.type === 'scalar') return { type: 'number', minimum: value.min, maximum: value.max, unit: value.unit };
  if (value.type === 'enum') return { type: 'string', enum: [...value.values] };
  return reject('wot-unsupported-value', path);
}

function operations(capability: DeviceCapability, path: string): readonly string[] {
  const permissions = new Set<string>(capability.permissions);
  const allowed = capability.kind === 'property' ? ['read', 'subscribe']
    : capability.kind === 'event' ? ['subscribe']
      : capability.kind === 'command' || capability.kind === 'job' ? ['invoke'] : [];
  if (allowed.length === 0 || [...permissions].some((permission) => !allowed.includes(permission))) {
    return reject('wot-unsupported-operation', path);
  }
  return allowed.filter((permission) => permissions.has(permission)).map((permission) => ({
    read: 'readproperty', subscribe: capability.kind === 'event' ? 'subscribeevent' : 'observeproperty',
    invoke: 'invokeaction',
  })[permission as 'read' | 'subscribe' | 'invoke']);
}

function bindingHref(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length > 2048) return reject('wot-href', path);
  let url: URL;
  try { url = new URL(value); } catch { return reject('wot-href', path); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash || url.href !== value) {
    return reject('wot-href', path);
  }
  return value;
}

function bindingSnapshot(input: unknown, descriptor: Readonly<DeviceDescriptor>): WoTBindings {
  const value = snapshotJson(input);
  if (value === null || Array.isArray(value) || typeof value !== 'object' ||
      Object.keys(value).sort().join(',') !== 'hrefs,security,subscriptions') reject('wot-bindings', '$.bindings');
  const bindings = value as JsonObject;
  const security = bindings.security;
  if (security === null || Array.isArray(security) || typeof security !== 'object' ||
      Object.keys(security).join(',') !== 'scheme' || security.scheme !== 'bearer') reject('wot-security', '$.bindings.security');
  const hrefs = bindings.hrefs;
  if (hrefs === null || Array.isArray(hrefs) || typeof hrefs !== 'object') reject('wot-bindings', '$.bindings.hrefs');
  const names = descriptor.capabilities.map((capability) => capability.id).sort();
  if (Object.keys(hrefs).sort().join('\0') !== names.join('\0')) reject('wot-bindings', '$.bindings.hrefs');
  for (const name of names) bindingHref(hrefs[name], `$.bindings.hrefs.${name}`);
  const subscriptions = bindings.subscriptions;
  if (subscriptions === null || Array.isArray(subscriptions) || typeof subscriptions !== 'object') {
    reject('wot-bindings', '$.bindings.subscriptions');
  }
  const subscribed = descriptor.capabilities.filter((capability) => capability.permissions.includes('subscribe'))
    .map((capability) => capability.id).sort();
  if (Object.keys(subscriptions).sort().join('\0') !== subscribed.join('\0') ||
      subscribed.some((name) => subscriptions[name] !== 'longpoll')) reject('wot-bindings', '$.bindings.subscriptions');
  return value as unknown as WoTBindings;
}

function profileDocument(descriptor: Readonly<DeviceDescriptor>, bindings: WoTBindings): WoTThingDescription {
  const properties: Record<string, WoTAffordance> = Object.create(null);
  const actions: Record<string, WoTAffordance> = Object.create(null);
  const events: Record<string, WoTAffordance> = Object.create(null);
  for (const capability of descriptor.capabilities) {
    const path = `$.capabilities.${capability.id}`;
    const schema = dataSchema(capability.value, `${path}.value`);
    const href = bindingHref(bindings.hrefs[capability.id], `$.bindings.hrefs.${capability.id}`);
    const forms = operations(capability, `${path}.permissions`).map((op): WoTForm => {
      const form = { op, href, contentType: 'application/json' as const,
        'htv:methodName': op === 'invokeaction' ? 'POST' as const : 'GET' as const };
      if (op === 'observeproperty' || op === 'subscribeevent') {
        const subprotocol = bindings.subscriptions[capability.id];
        if (subprotocol !== 'longpoll') reject('wot-bindings', `$.bindings.subscriptions.${capability.id}`);
        return { ...form, subprotocol };
      }
      return form;
    });
    if (forms.length === 0) reject('wot-unsupported-operation', path);
    if (capability.kind === 'property') {
      properties[capability.id] = { ...schema, observable: capability.permissions.includes('subscribe'),
        readOnly: true, forms } as WoTAffordance;
    } else if (capability.kind === 'event') {
      events[capability.id] = { data: schema, forms };
    } else {
      // A native job does not imply a WoT queryaction/status endpoint.
      actions[capability.id] = { input: schema, forms };
    }
  }
  return {
    '@context': [CONTEXT, { c101: PROFILE }], '@type': 'Thing',
    id: `urn:101:device:${encodeURIComponent(descriptor.id)}`, title: descriptor.label,
    version: { instance: String(descriptor.revision) },
    securityDefinitions: { bearer_sc: { scheme: 'bearer' } }, security: 'bearer_sc',
    properties, actions, events, [PROFILE_KEY]: descriptor,
  } as WoTThingDescription;
}

/** Export a narrow TD 1.1 representation. The caller owns and verifies each HTTPS binding. */
export function exportWoTThingDescription(descriptorInput: unknown, bindingsInput: unknown): WoTThingDescription {
  const descriptor = parseDeviceDescriptor(descriptorInput);
  const bindings = bindingSnapshot(bindingsInput, descriptor);
  const document = profileDocument(descriptor, bindings);
  return snapshotJson(document) as unknown as WoTThingDescription;
}

function normalized(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(normalized).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => {
      const member = value[key];
      if (member === undefined) reject('wot-document', '$');
      return `${JSON.stringify(key)}:${normalized(member)}`;
    }).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Import only this declared profile. The result is inert; forms never create a runtime grant. */
export function importWoTThingDescription(input: unknown): Readonly<DeviceDescriptor> {
  let source = input;
  if (typeof input === 'string') {
    if (new TextEncoder().encode(input).length > MAX_TD_BYTES) reject('byte-limit', '$');
    try { source = JSON.parse(input); } catch { reject('invalid-json', '$'); }
  }
  const document = snapshotJson(source);
  if (document === null || Array.isArray(document) || typeof document !== 'object') reject('wot-document', '$');
  const descriptor = parseDeviceDescriptor(document[PROFILE_KEY]);
  const hrefs: Record<string, string> = Object.create(null);
  const subscriptions: Record<string, 'longpoll'> = Object.create(null);
  for (const capability of descriptor.capabilities) {
    const group = capability.kind === 'property' ? document.properties
      : capability.kind === 'event' ? document.events : document.actions;
    if (group === null || Array.isArray(group) || typeof group !== 'object') reject('wot-affordance', '$');
    const affordance = group[capability.id];
    if (affordance === null || Array.isArray(affordance) || typeof affordance !== 'object') reject('wot-affordance', `$.${capability.id}`);
    const forms = affordance.forms;
    if (!Array.isArray(forms) || forms.length === 0 || forms[0] === null || typeof forms[0] !== 'object' || Array.isArray(forms[0])) {
      reject('wot-form', `$.${capability.id}.forms`);
    }
    hrefs[capability.id] = bindingHref(forms[0].href, `$.${capability.id}.forms[0].href`);
    if (capability.permissions.includes('subscribe')) subscriptions[capability.id] = 'longpoll';
  }
  const expected = exportWoTThingDescription(descriptor, { security: { scheme: 'bearer' }, hrefs, subscriptions });
  if (normalized(document) !== normalized(expected as unknown as JsonValue)) reject('wot-profile-mismatch', '$');
  return descriptor;
}
