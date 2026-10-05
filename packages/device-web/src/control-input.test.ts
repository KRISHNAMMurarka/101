import assert from 'node:assert/strict';
import test from 'node:test';
import { createControlInput } from './control-input.ts';
import type { SurfaceControl } from '@101/device-model';

const controls: readonly SurfaceControl[] = [
  { id: 'level', kind: 'slider', label: 'Level', style: 'normal', min: 0, max: 10, step: 1, initial: 0 },
  { id: 'apply', kind: 'button', label: 'Apply', style: 'normal' },
];
const turn = () => new Promise<void>(resolve => setTimeout(resolve, 0));

test('controls start unavailable and only emit declared input after an explicit host enable', () => {
  const values: unknown[] = [];
  const input = createControlInput(controls, value => { values.push(value); });
  assert.equal(input.send('level', 1), 'unavailable');
  input.enable('level', true); assert.equal(input.send('level', 1), 'sent');
  assert.equal(input.send('level', 0.1), 'invalid'); assert.equal(input.send('unknown', 1), 'invalid');
  assert.deepEqual(values, [{ id: 'level', kind: 'slider', value: 1, sequence: 1 }]);
  assert.equal(input.state('level')?.status, 'sent');
  input.setValue('level', 2); assert.equal(values.length, 1); assert.equal(input.state('level')?.value, 2);
  input.close(); assert.equal(input.send('level', 3), 'unavailable');
});

test('one async state update retains only the latest desired value, while actions reject duplicates', async () => {
  const values: unknown[] = [], finish: (() => void)[] = [];
  const input = createControlInput(controls, value => { values.push(value); return new Promise<void>(resolve => finish.push(resolve)); });
  input.enable('level', true); input.enable('apply', true);
  assert.equal(input.send('level', 1), 'sent'); assert.equal(input.send('level', 2), 'queued'); assert.equal(input.send('level', 3), 'queued');
  assert.equal(input.send('apply', true), 'sent'); assert.equal(input.send('apply', true), 'busy');
  assert.equal(values.length, 2); finish[0]!(); await turn();
  assert.equal(values.length, 3); assert.equal((values[2] as { value: number }).value, 3);
  finish[1]!(); finish[2]!(); await turn(); assert.equal(input.state('level')?.status, 'sent');
  input.close();
});

test('disable and close abort pending input, clear queued work and fence late callback completion', async () => {
  let resolve!: () => void; let calls = 0; let signal!: AbortSignal;
  const input = createControlInput(controls, (_value, context) => {
    calls++; signal = context.signal; return new Promise<void>(finish => { resolve = finish; });
  });
  input.enable('level', true); input.send('level', 1); input.send('level', 2);
  input.enable('level', false); assert.equal(signal.aborted, true);
  resolve(); await turn(); assert.equal(calls, 1); assert.equal(input.state('level')?.status, 'unavailable');
  input.enable('level', true); input.send('level', 3); input.close();
  assert.equal(signal.aborted, true); resolve(); await turn(); assert.equal(calls, 2);
});

test('thrown/rejected callbacks and timeout expose fixed states, preserve accepted choice and permit retry', async () => {
  let failure = true;
  const input = createControlInput(controls, () => { if (failure) throw new Error('private callback message'); });
  input.enable('level', true); input.send('level', 2);
  assert.equal(input.state('level')?.status, 'failed'); assert.equal(input.state('level')?.value, 0);
  assert.equal(JSON.stringify(input.state('level')).includes('private callback'), false);
  failure = false; input.send('level', 3); assert.equal(input.state('level')?.status, 'sent'); input.close();
  const timed = createControlInput(controls, () => new Promise<void>(() => {}), 100);
  timed.enable('level', true); timed.send('level', 2);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(timed.state('level')?.status, 'failed'); assert.equal(timed.state('level')?.pending, false); timed.close();
  const rejected = createControlInput(controls, async () => { throw new Error('private rejection'); });
  rejected.enable('level', true); rejected.send('level', 1); await turn();
  assert.equal(rejected.state('level')?.status, 'failed'); rejected.close();
});

test('reentrant abort listeners cannot dispatch orphan work during disable or replacement', () => {
  const calls: number[] = [], signals: AbortSignal[] = [];
  const input = createControlInput(controls, (event, { signal }) => {
    calls.push(event.value as number); signals.push(signal);
    signal.addEventListener('abort', () => { input.setValue('level', 0); input.send('level', 9); });
    return new Promise<void>(() => {});
  });
  input.enable('level', true); input.send('level', 1); input.enable('level', false);
  assert.deepEqual(calls, [1]); assert.equal(input.state('level')?.enabled, false);
  input.enable('level', true); input.send('level', 2); input.setValue('level', 3);
  assert.deepEqual(calls, [1, 2]);
  input.close(); assert.ok(signals.every(signal => signal.aborted));
});

test('a subscriber that closes input during sending prevents the callback entirely', () => {
  let calls = 0;
  const input = createControlInput(controls, () => { calls++; });
  input.enable('level', true);
  input.subscribe(() => { if (input.state('level')?.pending) input.close(); });
  input.send('level', 1); assert.equal(calls, 0);
});
