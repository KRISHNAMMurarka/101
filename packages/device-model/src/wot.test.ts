import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import Ajv from 'ajv';
import { DeviceValidationError, exportWoTThingDescription, importWoTThingDescription } from './index.ts';
import type { DeviceDescriptor } from './index.ts';

const descriptor: DeviceDescriptor = {
  schemaVersion: 1, id: 'lamp-1', label: 'Lamp', revision: 2,
  adapter: { id: 'example:lamp', version: '1.0.0' }, runtime: { platform: 'embedded-test' },
  capabilities: [
    { id: 'on', semantic: 'example:on', schemaVersion: 1, kind: 'property', value: { type: 'boolean' },
      delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 1000 }, permissions: ['read', 'subscribe'],
      extensions: { 'vendor:calibration': { revision: 4 } } },
    { id: 'set', semantic: 'example:set', schemaVersion: 1, kind: 'command', value: { type: 'boolean' },
      delivery: { mode: 'reliable', maxAgeMs: 1000 }, permissions: ['invoke'] },
    { id: 'print', semantic: 'example:print', schemaVersion: 1, kind: 'job', value: { type: 'enum', values: ['a', 'b'] },
      delivery: { mode: 'reliable', maxAgeMs: 1000 }, permissions: ['invoke'] },
    { id: 'alert', semantic: 'example:alert', schemaVersion: 1, kind: 'event', value: { type: 'scalar', unit: 'Cel', min: 0, max: 100 },
      delivery: { mode: 'reliable', maxAgeMs: 1000 }, permissions: ['subscribe'] },
  ],
  extensions: { 'vendor:display': { room: 'A' } },
};
const bindings = { security: { scheme: 'bearer' }, hrefs: {
  on: 'https://example.com/on', set: 'https://example.com/set',
  print: 'https://example.com/print', alert: 'https://example.com/alert',
}, subscriptions: { on: 'longpoll', alert: 'longpoll' } } as const;

test('bounded WoT profile projects standard affordances and round-trips inert native contracts', () => {
  const td = exportWoTThingDescription(descriptor, bindings);
  assert.deepEqual(td['@context'], ['https://www.w3.org/2022/wot/td/v1.1', { c101: 'urn:101:td:profile:1#' }]);
  assert.deepEqual(td.securityDefinitions, { bearer_sc: { scheme: 'bearer' } });
  assert.deepEqual(td.properties?.on?.forms?.map((form) => form.op), ['readproperty', 'observeproperty']);
  assert.deepEqual(td.properties?.on?.forms?.[1], { op: 'observeproperty', href: 'https://example.com/on',
    contentType: 'application/json', subprotocol: 'longpoll', 'htv:methodName': 'GET' });
  assert.deepEqual(td.events?.alert?.forms?.[0], { op: 'subscribeevent', href: 'https://example.com/alert',
    contentType: 'application/json', subprotocol: 'longpoll', 'htv:methodName': 'GET' });
  assert.equal(td.properties?.on?.observable, true);
  assert.equal(Object.hasOwn(td.actions?.print ?? {}, 'synchronous'), false);
  assert.deepEqual(td.events?.alert?.data, { type: 'number', minimum: 0, maximum: 100, unit: 'Cel' });
  assert.deepEqual(importWoTThingDescription(JSON.stringify(td)), descriptor);
  assert.equal(Object.isFrozen(td), true);
  assert.equal(Object.isFrozen(importWoTThingDescription(td).capabilities[0]?.extensions), true);
});

test('WoT import rejects changed standard fields, forms, authority and unknown profile data', () => {
  const td = exportWoTThingDescription(descriptor, bindings);
  for (const altered of [
    { ...td, securityDefinitions: { bearer_sc: { scheme: 'nosec' } } },
    { ...td, properties: { ...td.properties, on: { ...td.properties?.on, type: 'string' } } },
    { ...td, actions: { ...td.actions, print: { ...td.actions?.print, synchronous: false } } },
    { ...td, extra: true },
    { ...td, properties: { ...td.properties, on: { ...td.properties?.on,
      forms: [{ op: 'writeproperty', href: 'https://example.com/on' }] } } },
    { ...td, events: { ...td.events, alert: { ...td.events?.alert,
      forms: [{ op: 'subscribeevent', href: 'https://example.com/alert', contentType: 'application/json' }] } } },
  ]) assert.throws(() => importWoTThingDescription(altered), DeviceValidationError);
  assert.throws(() => importWoTThingDescription({ ...td, 'c101:descriptor': undefined }), DeviceValidationError);
});

test('WoT export rejects unsupported schemas, kinds, grants and unbound or unsafe forms', () => {
  const sample = { ...descriptor, capabilities: [{ ...descriptor.capabilities[0], kind: 'sample' }] };
  assert.throws(() => exportWoTThingDescription(sample, bindings), DeviceValidationError);
  const vector = { ...descriptor, capabilities: [{ ...descriptor.capabilities[0], value: {
    type: 'vector', unit: 'm', min: 0, max: 1, frame: 'screen', components: ['x', 'y'],
  } }] };
  assert.throws(() => exportWoTThingDescription(vector, bindings), DeviceValidationError);
  assert.throws(() => exportWoTThingDescription(descriptor, { ...bindings, hrefs: { ...bindings.hrefs, on: 'http://example.com/on' } }), DeviceValidationError);
  assert.throws(() => exportWoTThingDescription(descriptor, { ...bindings, hrefs: { ...bindings.hrefs, extra: 'https://example.com/extra' } }), DeviceValidationError);
  assert.throws(() => exportWoTThingDescription(descriptor, { ...bindings, security: { scheme: 'nosec' } }), DeviceValidationError);
  assert.throws(() => exportWoTThingDescription(descriptor, { ...bindings, subscriptions: {} }), DeviceValidationError);
  let calls = 0;
  const evil = Object.defineProperty({}, 'security', { enumerable: true, get() { calls += 1; return {}; } });
  assert.throws(() => exportWoTThingDescription(descriptor, evil), DeviceValidationError);
  assert.equal(calls, 0);
});

test('exported fixture validates against pinned W3C TD 1.1 JSON Schema', () => {
  const bytes = readFileSync(new URL('../fixtures/wot-td-schema-v1.1.json', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),
    'fd44f319f94c6f16f66978860ef2f9f4e0e9fd7fc5835a2f3840b9cf2002e0f1');
  const validate = new Ajv({ allErrors: true, logger: false }).compile(JSON.parse(bytes.toString('utf8')));
  const td = exportWoTThingDescription(descriptor, bindings);
  assert.equal(validate(td), true, JSON.stringify(validate.errors));
  const invalid = { ...td, security: [] };
  assert.equal(validate(invalid), false);
});
