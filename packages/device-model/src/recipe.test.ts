import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRecipe } from './index.ts';

const recipe = {
  schemaVersion: 1, id: 'example:room-control', version: '1.0.0',
  resources: [
    { id: 'sensor', direction: 'source', semantic: 'example:temperature', schemaVersion: 1, required: true },
    { id: 'relay', direction: 'sink', semantic: 'example:relay-state', schemaVersion: 1, required: true },
  ],
  processors: [{ id: 'threshold', manifest: { id: 'example:temperature-threshold', version: '1.0.0',
    codeSha256: 'a'.repeat(64) }, configuration: { onAt: 30, offAt: 28 } }],
  routes: [
    { id: 'measure', from: { node: 'sensor', port: 'value' }, to: { node: 'threshold', port: 'temperature' }, required: true },
    { id: 'actuate', from: { node: 'threshold', port: 'switch' }, to: { node: 'relay', port: 'value' }, required: true },
  ],
  permissions: [
    { route: 'measure', side: 'from', operation: 'subscribe', owner: 'required', purpose: 'Read room temperature' },
    { route: 'actuate', side: 'to', operation: 'invoke', owner: 'required', purpose: 'Set the selected relay' },
  ],
  styles: [{ id: 'default', tone: 'normal', density: 'comfortable' },
    { id: 'muted', tone: 'muted', density: 'compact' }],
  surfaces: [{ id: 'room', title: 'Room', components: [
    { id: 'heading', kind: 'text', text: 'Room controls', style: 'default' },
    { id: 'reading', kind: 'value', label: 'Temperature', from: { node: 'sensor', port: 'value' }, style: 'muted' },
    { id: 'switch', kind: 'action', label: 'Set relay', route: 'actuate', style: 'default' },
  ] }],
};

test('recipe v1 keeps an inert, complete, immutable declaration', () => {
  const parsed = parseRecipe(recipe);
  assert.deepEqual(parsed, recipe);
  assert.equal(Object.isFrozen(parsed.processors[0]?.configuration), true);
  assert.equal(Object.isFrozen(parsed.surfaces[0]?.components[0]), true);
  assert.equal(parsed.permissions.length, 2);
});

test('recipe rejects missing owner declarations, unknown references and unpinned processors', () => {
  for (const bad of [
    { ...recipe, permissions: recipe.permissions.slice(0, 1) },
    { ...recipe, permissions: [...recipe.permissions, recipe.permissions[0]] },
    { ...recipe, processors: [{ ...recipe.processors[0], manifest: { ...recipe.processors[0]!.manifest, codeSha256: 'latest' } }] },
    { ...recipe, routes: [{ ...recipe.routes[0], from: { node: 'missing', port: 'value' } }, recipe.routes[1]] },
    { ...recipe, routes: [{ ...recipe.routes[0], from: { node: 'relay', port: 'value' } }, recipe.routes[1]] },
    { ...recipe, surfaces: [{ ...recipe.surfaces[0], components: [{ id: 'bad', kind: 'action', label: 'Bad', route: 'measure', style: 'default' }] }] },
    { ...recipe, styles: [{ id: 'default', tone: 'normal', density: 'comfortable', css: 'position:fixed' }] },
    { ...recipe, schemaVersion: 2 },
  ]) assert.throws(() => parseRecipe(bad));
});

test('recipe rejects executable data without invoking getters or factories', () => {
  let called = 0;
  const withGetter = { ...recipe, resources: [{ ...recipe.resources[0], get semantic() { called++; return 'example:temperature'; } }, recipe.resources[1]] };
  assert.throws(() => parseRecipe(withGetter));
  assert.equal(called, 0);
  assert.throws(() => parseRecipe({ ...recipe, processors: [{ ...recipe.processors[0], configuration: { transform: () => true } }] }));
});
