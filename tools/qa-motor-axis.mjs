import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createMotorAxisGateway } from '../packages/hub-server/src/motor-axis-gateway.ts';

assert.equal(process.argv.length, 3, 'Pass an owned receipt path');
const receiptPath = resolve(process.argv[2]);

const paths = [
  'packages/hub-server/src/motor-axis-gateway.ts',
  'packages/hub-server/src/motor-axis-gateway.test.ts',
  'examples/motor-axis/software-axis-fixtures.mjs',
  'examples/motor-axis/consumer.mjs',
  'tools/qa-motor-axis.mjs',
  'tools/qa-installed-motor-axis.mjs',
];
const bytes = Object.fromEntries(await Promise.all(paths.map(async path =>
  [path, await readFile(new URL(`../${path}`, import.meta.url))])));
const sourceSha256 = Object.fromEntries(Object.entries(bytes).map(([path, value]) =>
  [path, createHash('sha256').update(value).digest('hex')]));

const { runMotorAxisConsumer, childProvider } = await import('../examples/motor-axis/consumer.mjs');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function actualProducerCheck(run) {
  const child = spawn(process.execPath, [new URL('../examples/motor-axis/software-axis-fixtures.mjs', import.meta.url).pathname, 'actuator'],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  const messages = [];
  let buffer = '';
  child.stdout.on('data', bytes => {
    buffer += bytes;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'); messages.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1);
    }
  });
  child.stderr.on('data', () => {});
  const exit = new Promise(resolve => child.once('exit', resolve));
  const until = async match => {
    for (let turn = 0; turn < 100; turn++) {
      const found = messages.find(match); if (found) return found;
      await pause(5);
    }
    throw new Error('producer regression deadline');
  };
  const send = value => child.stdin.write(typeof value === 'string' || Buffer.isBuffer(value) ? value : `${JSON.stringify(value)}\n`);
  const token = 'a'.repeat(32);
  const identity = { generation: 1, token };
  try {
    await until(value => value.type === 'hello');
    await run({ child, messages, send, until, identity });
  } finally { child.kill('SIGKILL'); await exit; }
}
const protocolChecks = [];
const startupFaultCases = [];
const unhandledStartupErrors = [];
const captureStartupError = error => unhandledStartupErrors.push(String(error));
process.on('unhandledRejection', captureStartupError);
try {
  for (const mode of ['startup-expiry', 'set-send-bounds', 'read-send-bounds', 'close-unopened']) {
    const role = mode === 'read-send-bounds' ? 'feedback' : 'actuator';
    const fixture = childProvider(role);
    const makeContext = () => ({generation: 1, sessionToken: {}, signal: new AbortController().signal,
      deadline: performance.now() + 450, invalidate() {}});
    try {
      if (mode === 'startup-expiry' || mode === 'close-unopened') {
        await assert.rejects(fixture.provider.open({...makeContext(),
          deadline: performance.now() + (mode === 'startup-expiry' ? 10 : -1)}), /expired host deadline/);
      } else {
        await fixture.provider.open(makeContext());
        const operation = {...makeContext(), operationId: 'x'.repeat(2000)};
        await assert.rejects(role === 'actuator' ? fixture.provider.setPosition(2, operation) : fixture.provider.read(operation),
          /command bounds exceeded/);
      }
      assert.equal(fixture.status().waiters, 0);
      assert.equal(fixture.status().timers, 0);
      await fixture.provider.close(); await pause(25);
      assert.deepEqual(fixture.status(), {waiters: 0, timers: 0, childRunning: false});
      startupFaultCases.push({mode, lifecycle: fixture.status()});
      protocolChecks.push(mode);
    } finally { await fixture.provider.close(); }
  }
  assert.deepEqual(unhandledStartupErrors, [], 'startup and command setup faults must retain every rejection');
} finally { process.off('unhandledRejection', captureStartupError); }

for (const kind of ['unknown-key', 'duplicate-key', 'stale-close', 'stale-release', 'stale-stop', 'partial-line', 'invalid-utf8', 'input-total']) {
  await actualProducerCheck(async ({ child, messages, send, until, identity }) => {
    if (kind === 'partial-line' || kind === 'invalid-utf8') {
      send(kind === 'partial-line' ? 'x'.repeat(1025) : Buffer.from([255]));
      await pause(80); assert.notEqual(child.exitCode, null); return;
    }
    send({ type: 'open', ...identity, remainingMs: 400 }); await until(value => value.type === 'ready');
    if (kind === 'unknown-key') send({ type: 'set-position', ...identity, operationId: '1', targetMm: 2, remainingMs: 300, unknown: true });
    if (kind === 'duplicate-key') send(`{"type":"set-position","generation":1,"token":"${identity.token}","operationId":"1","targetMm":1,"targetMm":2,"remainingMs":300}\n`);
    if (kind.startsWith('stale-')) {
      send({ type: 'set-position', ...identity, operationId: '1', targetMm: 2, remainingMs: 300 });
      await until(value => value.type === 'completed');
      send({ type: kind.slice(6), generation: 0, token: 'b'.repeat(32) });
    }
    if (kind === 'input-total') {
      const command = `${JSON.stringify({type: 'set-position', ...identity, operationId: '1', targetMm: 0, remainingMs: 300})}\n`;
      send(command.repeat(Math.ceil(16385 / Buffer.byteLength(command))));
      await pause(80); assert.notEqual(child.exitCode, null); return;
    }
    await pause(60);
    if (kind.startsWith('stale-')) {
      assert.equal(child.exitCode, null);
      assert.equal(messages.some(value => ['released', 'stopped', 'closed'].includes(value.type)), false);
      assert.equal(messages.filter(value => value.type === 'position-step').length, 2);
    } else assert.equal(messages.some(value => value.type === 'position-step'), false);
  });
  protocolChecks.push(kind);
}
const restart = childProvider('actuator');
const context = () => ({ generation: 1, sessionToken: {}, signal: new AbortController().signal,
  deadline: performance.now() + 450, invalidate() {} });
try {
  await restart.provider.open(context()); await restart.provider.setPosition(2, {...context(), operationId: '1'});
  restart.provider.stop(); await restart.provider.whenSettled(); await restart.provider.close();
  const from = restart.messages.length;
  await restart.provider.open(context());
  assert.equal(await restart.provider.setPosition(8, {...context(), operationId: '1'}), 'completed');
  assert.deepEqual(restart.messages.slice(from).filter(value => value.type === 'position-step' && value.operationId === '1')
    .map(value => value.positionMm), [1, 2, 3, 4, 5, 6, 7, 8]);
} finally { await restart.provider.close(); }
assert.deepEqual(restart.status(), {waiters: 0, timers: 0, childRunning: false});
protocolChecks.push('exact-provider-restart-no-history-replay');
for (const [role, mode] of [['actuator', 'slow'], ['actuator', 'fault-after-step'], ['actuator', 'stale-session'],
  ['actuator', 'invalid-utf8-output'], ['actuator', 'unknown-output'], ['actuator', 'duplicate-key-output'],
  ['actuator', 'oversize-line'], ['actuator', 'oversize-total'], ['feedback', 'slow'], ['feedback', 'fault'], ['feedback', 'stale-session'],
  ['feedback', 'out-of-range'], ['feedback', 'oversize-line'], ['feedback', 'oversize-total']]) {
  const fixture = childProvider(role, mode);
  try {
    if (mode.startsWith('oversize-') || mode.endsWith('-output')) await assert.rejects(fixture.provider.open(context()));
    else {
      await fixture.provider.open(context());
      const operation = {...context(), operationId: '1', deadline: performance.now() + 70};
      if (role === 'actuator' && mode === 'slow') assert.equal(await fixture.provider.setPosition(8, operation), 'unavailable');
      else await assert.rejects(role === 'actuator' ? fixture.provider.setPosition(mode === 'stale-session' ? 1 : 8, operation) : fixture.provider.read(operation));
    }
  } finally { await fixture.provider.close(); }
  assert.deepEqual(fixture.status(), {waiters: 0, timers: 0, childRunning: false});
  protocolChecks.push(`${role}:${mode}`);
}
const duplicate = childProvider('actuator', 'duplicate-output');
try {
  await duplicate.provider.open(context());
  assert.equal(await duplicate.provider.setPosition(2, {...context(), operationId: '1'}), 'completed');
  assert.equal(await duplicate.provider.setPosition(4, {...context(), operationId: '2'}), 'completed');
  assert.deepEqual(duplicate.messages.filter(value => value.type === 'position-step' && value.operationId === '2')
    .map(value => value.positionMm), [3, 4]);
} finally { await duplicate.provider.close(); }
assert.deepEqual(duplicate.status(), {waiters: 0, timers: 0, childRunning: false});
protocolChecks.push('duplicate-output-cannot-complete-new-operation');
for (const mode of ['match-script', 'duplicate-sequence', 'stale-sequence']) {
  const actuator = childProvider('actuator');
  const feedback = childProvider('feedback', mode);
  const owner = new AbortController();
  const approve = request => ({request, signal: owner.signal, expiresAt: performance.now() + 2000});
  const gateway = createMotorAxisGateway({ownerSignal: owner.signal,
    scope: {principalId: 'axis-owner', applicationId: 'axis-feedback-qa', sessionId: mode},
    selectedAxis: {id: 'axis-feedback-pair', profileId: 'app:bounded-linear-axis-mm-software/1'},
    actuatorProvider: actuator.provider, feedbackProvider: feedback.provider,
    authorizeActivation: approve, authorizeSet: approve, authorizeObserve: approve, onRetire() {}});
  try {
    const start = await gateway.start({purpose: 'actual feedback modes', deadline: performance.now() + 450});
    assert.ok(start.ok);
    const read = operationId => gateway.observePosition(start.value, {operationId, purpose: 'independent script',
      signal: owner.signal, deadline: performance.now() + 400});
    const first = await read('1');
    if (mode === 'stale-sequence') assert.equal(first.ok, false);
    else {
      assert.ok(first.ok);
      if (mode === 'match-script') {
        assert.equal(first.value.positionMm, 4); assert.equal(first.value.relation, 'no-target');
        assert.equal(first.value.physical, false); assert.equal(first.value.captureTimeKnown, false);
      } else {
        const duplicate = await read('2'); assert.equal(duplicate.ok, false); assert.equal(duplicate.reason, 'out-of-order');
      }
    }
  } finally { await gateway.close(); }
  assert.deepEqual(actuator.status(), {waiters: 0, timers: 0, childRunning: false});
  assert.deepEqual(feedback.status(), {waiters: 0, timers: 0, childRunning: false});
  protocolChecks.push(`feedback:${mode}`);
}
const result = await runMotorAxisConsumer();
for (const path of paths) {
  const finalHash = createHash('sha256').update(await readFile(new URL(`../${path}`, import.meta.url))).digest('hex');
  assert.equal(finalHash, sourceSha256[path]);
}

const receipt = {
  schemaVersion: 1,
  status: result.status,
  environment: { node: process.version, platform: process.platform },
  sourceSha256,
  result,
  protocolChecks,
  startupFaultCases,
  scope: 'Selected paired software axis fixtures only. Virtual register steps, command completion and independently scripted feedback do not verify physical position, motion, slew, limits, deadman, interlock, force, flow or target state.',
};
await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ status: 'pass', receipt: receiptPath, protocolChecks, result }));
