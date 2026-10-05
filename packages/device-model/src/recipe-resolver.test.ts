import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveRecipe } from './index.ts';

const value = { type: 'boolean' };
const source = {
  schemaVersion: 1, id: 'selected-switch', label: 'Switch', revision: 1,
  adapter: { id: 'example:switch', version: '1.0.0' }, runtime: { platform: 'embedded' },
  capabilities: [{ id: 'state', semantic: 'example:switch-state', schemaVersion: 1, kind: 'property', value,
    delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 1000 }, permissions: ['read', 'subscribe'] }],
};
const sink = {
  schemaVersion: 1, id: 'selected-view', label: 'View', revision: 1,
  adapter: { id: 'example:view', version: '1.0.0' }, runtime: { platform: 'embedded' },
  capabilities: [{ id: 'state', semantic: 'example:switch-state', schemaVersion: 1, kind: 'property', value,
    delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 1000 }, permissions: ['write'], ownership: { mode: 'exclusive' } }],
};
const recipe = {
  schemaVersion: 1, id: 'example:switch-view', version: '1.0.0',
  resources: [
    { id: 'switch', direction: 'source', semantic: 'example:switch-state', schemaVersion: 1, required: true },
    { id: 'view', direction: 'sink', semantic: 'example:switch-state', schemaVersion: 1, required: true },
  ], processors: [],
  routes: [{ id: 'show', from: { node: 'switch', port: 'value' }, to: { node: 'view', port: 'value' }, required: true }],
  permissions: [
    { route: 'show', side: 'from', operation: 'read', owner: 'required', purpose: 'Show current switch state' },
    { route: 'show', side: 'to', operation: 'write', owner: 'required', purpose: 'Display current switch state' },
  ], styles: [{ id: 'default', tone: 'normal', density: 'comfortable' }],
  surfaces: [{ id: 'main', title: 'Switch view', components: [
    { id: 'current', kind: 'value', label: 'Current state', from: { node: 'switch', port: 'value' }, style: 'default' },
  ] }],
};
const environment = { devices: [source, sink], processors: [], selections: {
  switch: { deviceId: 'selected-switch', capability: 'state' },
  view: { deviceId: 'selected-view', capability: 'state' },
} };

test('resolver binds an explicitly selected read/property route without granting it', () => {
  const result = resolveRecipe(recipe, environment);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.routes.map(route => route.id), ['show']);
  assert.deepEqual(result.value.requiredOperations.map(item => item.operation), ['read', 'write']);
  assert.equal(result.value.resources[0]?.device.id, 'selected-switch');
  assert.equal(Object.isFrozen(result.value), true);
});

test('missing and wrong selections return compatible alternatives without choosing one', () => {
  const missing = resolveRecipe(recipe, { ...environment, selections: { view: environment.selections.view } });
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.equal(missing.issues[0]?.code, 'resource-unselected');
  assert.deepEqual(missing.issues[0]?.alternatives, [
    { deviceId: 'selected-switch', capability: 'state', compatible: true },
    { deviceId: 'selected-view', capability: 'state', compatible: false },
  ]);
  const wrong = resolveRecipe(recipe, { ...environment, selections: { ...environment.selections,
    switch: { deviceId: 'unknown', capability: 'state' } } });
  assert.equal(wrong.ok, false);
  if (!wrong.ok) assert.equal(wrong.issues[0]?.code, 'resource-incompatible');
  const incompatible = resolveRecipe(recipe, { ...environment, devices: [{ ...source,
    capabilities: [{ ...source.capabilities[0], schemaVersion: 2 }] }, sink] });
  assert.equal(incompatible.ok, false);
  if (!incompatible.ok) assert.ok(incompatible.issues[0]?.alternatives?.every(option => !option.compatible));
});

test('pinned processor and configuration must match an installed inert manifest', () => {
  const manifest = {
    schemaVersion: 1, id: 'example:invert', version: '1.0.0', codeSha256: 'a'.repeat(64),
    inputs: [{ id: 'in', value }], outputs: [{ id: 'out', value }],
    configuration: { type: 'record', fields: { enabled: { type: 'boolean' } } },
    state: { mode: 'stateless' }, assets: [], license: 'MIT',
    budgets: { maxComputeMs: 5, maxMemoryBytes: 65536, privacy: 'local-only' },
  };
  const processed = { ...recipe, processors: [{ id: 'invert', manifest: { id: manifest.id,
    version: manifest.version, codeSha256: manifest.codeSha256 }, configuration: { enabled: true } }],
  routes: [
    { id: 'first', from: { node: 'switch', port: 'value' }, to: { node: 'invert', port: 'in' }, required: true },
    { id: 'second', from: { node: 'invert', port: 'out' }, to: { node: 'view', port: 'value' }, required: true },
  ], permissions: [
    { route: 'first', side: 'from', operation: 'subscribe', owner: 'required', purpose: 'Read selected switch' },
    { route: 'second', side: 'to', operation: 'write', owner: 'required', purpose: 'Show derived state' },
  ] };
  const withManifest = { ...environment, processors: [manifest] };
  assert.equal(resolveRecipe(processed, withManifest).ok, true);
  const missing = resolveRecipe(processed, { ...environment, processors: [] });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.issues[0]?.code, 'processor-unavailable');
  const changed = resolveRecipe(processed, { ...environment, processors: [{ ...manifest, codeSha256: 'b'.repeat(64) }] });
  assert.equal(changed.ok, false);
  if (!changed.ok) assert.equal(changed.issues[0]?.code, 'processor-unavailable');
  const invalid = resolveRecipe({ ...processed, processors: [{ ...processed.processors[0], configuration: { enabled: 'yes' } }] }, withManifest);
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.issues[0]?.code, 'processor-configuration');
});

test('resolver rejects executable environment fields without reading their getters', () => {
  let called = 0;
  const selections = { ...environment.selections, get switch() { called++; return environment.selections.switch; } };
  assert.throws(() => resolveRecipe(recipe, { ...environment, selections }));
  const outer = { ...environment, get devices() { called++; return environment.devices; } };
  assert.throws(() => resolveRecipe(recipe, outer));
  assert.equal(called, 0);
});

test('resolver accepts a descriptor schema at the descriptor parser depth bound', () => {
  const nested = { type: 'record', fields: { payload: { type: 'array', items: { type: 'boolean' }, minItems: 0, maxItems: 2 } } };
  const nestedSource = { ...source, capabilities: [{ ...source.capabilities[0], semantic: 'example:nested',
    kind: 'sample', value: nested, permissions: ['subscribe'] }] };
  const nestedSink = { ...sink, capabilities: [{ ...sink.capabilities[0], semantic: 'example:nested', value: nested }] };
  const nestedRecipe = { ...recipe,
    resources: recipe.resources.map(item => ({ ...item, semantic: 'example:nested' })),
    permissions: [{ ...recipe.permissions[0], operation: 'subscribe' }, recipe.permissions[1]],
  };
  assert.equal(resolveRecipe(nestedRecipe, { ...environment, devices: [nestedSource, nestedSink] }).ok, true);
});
