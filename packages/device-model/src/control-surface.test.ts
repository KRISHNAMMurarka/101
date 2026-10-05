import assert from 'node:assert/strict';
import test from 'node:test';
import { parseControlSurface, surfaceColumnCount, surfaceControlValueValid } from './control-surface.ts';

const style = { id: 'normal', tone: 'normal', density: 'comfortable', motion: 'feedback' };
function description() {
  return { schemaVersion: 1, id: 'example:controls', title: 'Room controls', minColumnWidth: 240,
    styles: [style], nodes: [{ id: 'panel', kind: 'box', title: 'Settings', style: 'normal', children: [
      { id: 'note', kind: 'text', text: 'Choose a setting', style: 'normal' },
      { id: 'readout', kind: 'value', label: 'Current level', text: 'Not available', style: 'normal' },
      { id: 'run', kind: 'button', label: 'Apply', style: 'normal' },
      { id: 'power', kind: 'toggle', label: 'Power', initial: false, style: 'normal' },
      { id: 'level', kind: 'slider', label: 'Level', min: 0, max: 10, step: 0.5, initial: 2, style: 'normal' },
      { id: 'mode', kind: 'choice', label: 'Mode', options: [{ value: 'quiet', label: 'Quiet' }, { value: 'normal', label: 'Normal' }], initial: 'quiet', style: 'normal' },
    ] }] };
}

test('a reusable surface description retains all authored primitives as immutable inert data', () => {
  const input = description(), parsed = parseControlSurface(input);
  assert.deepEqual(parsed, input); assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.nodes[0]));
  input.nodes[0]!.title = 'changed'; assert.equal(parsed.nodes[0]!.kind, 'box');
  if (parsed.nodes[0]!.kind === 'box') assert.equal(parsed.nodes[0].title, 'Settings');
});

test('styles, controls and referenced IDs are closed and cannot grant access or inject markup behavior', () => {
  for (const change of [
    (x: Record<string, unknown>) => { x.schemaVersion = 2; },
    (x: Record<string, unknown>) => { x.grants = []; },
    (x: Record<string, unknown>) => { x.styles = [{ ...style, color: 'red' }]; },
    (x: Record<string, unknown>) => { x.styles = [{ ...style, motion: 'infinite' }]; },
    (x: Record<string, unknown>) => { x.nodes = [{ id: 'bad', kind: 'html', html: '<script>bad()</script>', style: 'normal' }]; },
    (x: Record<string, unknown>) => { x.nodes = [{ id: 'bad', kind: 'button', label: 'Apply', style: 'absent' }]; },
    (x: Record<string, unknown>) => { x.nodes = [{ id: 'same', kind: 'text', text: 'A', style: 'normal' }, { id: 'same', kind: 'button', label: 'B', style: 'normal' }]; },
  ]) { const input: Record<string, unknown> = description(); change(input); assert.throws(() => parseControlSurface(input)); }
  let read = false;
  const getter = { ...description(), get title() { read = true; return 'Private'; } };
  assert.throws(() => parseControlSurface(getter)); assert.equal(read, false);
  const literal = { ...description(), title: '<img src="https://invalid.example/x">' };
  assert.equal(parseControlSurface(literal).title, literal.title); // rendering uses textContent, never HTML
});

test('slider grids and choices cannot silently round or select an undeclared value', () => {
  const base = { id: 'level', kind: 'slider', label: 'Level', min: -2, max: 2, step: 0.5, initial: 0, style: 'normal' };
  for (const invalid of [{ ...base, initial: 0.1 }, { ...base, min: 5 }, { ...base, step: 0 },
    { ...base, max: Infinity }, { ...base, step: 0.0000001 }, { ...base, initial: 3 },
    { id: 'mode', kind: 'choice', label: 'Mode', style: 'normal', options: [{ value: 'x', label: 'X' }], initial: 'y' },
    { id: 'mode', kind: 'choice', label: 'Mode', style: 'normal', options: [{ value: 'x', label: 'X' }, { value: 'x', label: 'Again' }], initial: 'x' }]) {
    assert.throws(() => parseControlSurface({ ...description(), nodes: [invalid] }));
  }
  assert.equal(parseControlSurface({ ...description(), nodes: [base] }).nodes.length, 1);
});

test('surface node count, one box layer and measured layout are bounded without reordering controls', () => {
  const input = description();
  assert.throws(() => parseControlSurface({ ...input, nodes: Array.from({ length: 65 }, (_, i) => ({ id: `n${i}`, kind: 'text', text: 'Label', style: 'normal' })) }));
  assert.throws(() => parseControlSurface({ ...input, nodes: [{ id: 'outer', kind: 'box', title: 'Outer', style: 'normal', children: input.nodes }] }));
  assert.equal(surfaceColumnCount(0, 240), 1); assert.equal(surfaceColumnCount(390, 240), 1);
  assert.equal(surfaceColumnCount(520, 240), 2); assert.equal(surfaceColumnCount(10000, 240), 4);
  assert.equal(surfaceColumnCount(NaN, 240), 1); assert.equal(surfaceColumnCount(1000, NaN), 1);
});
test('native slider grids require a real interval and cannot round a non-minimum value to zero', () => {
  const description = {
    schemaVersion: 1, id: 'example:tiny-grid', title: 'Grid', minColumnWidth: 240,
    styles: [{ id: 'normal', tone: 'normal', density: 'comfortable', motion: 'none' }],
    nodes: [{ id: 'level', kind: 'slider', label: 'Level', style: 'normal', min: 0, max: 0.01, step: 1000000, initial: 0.01 }],
  };
  assert.throws(() => parseControlSurface(description));
  const node = { id: 'level', kind: 'slider' as const, label: 'Level', style: 'normal', min: 0, max: 1, step: 1, initial: 0 };
  assert.equal(surfaceControlValueValid(node, 0.000000001), false);
});

test('coarse slider grids use machine roundoff rather than permitting visible native rounding', () => {
  const node = { id: 'level', kind: 'slider' as const, label: 'Level', style: 'normal', min: 0, max: 1000000, step: 1000000, initial: 999999.99 };
  assert.equal(surfaceControlValueValid(node, node.initial), false);
  assert.throws(() => parseControlSurface({ ...description(), nodes: [node] }));
  assert.equal(surfaceControlValueValid({ ...node, max: 1, step: 0.1 }, 0.3), true);
});
