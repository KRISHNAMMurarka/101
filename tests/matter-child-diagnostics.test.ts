import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

test('failed Matter child checkpoint retains genuine native launch and close diagnostics', async t => {
  const directory = await mkdtemp(join(tmpdir(), '101-matter-child-diagnostic-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const injector = join(directory, 'checkpoint-failure.mjs');
  await writeFile(injector, `import assert from 'node:assert/strict';
const equal = assert.equal;
assert.equal = function(actual, expected, ...args) {
  if (actual === false && expected === false && new Error().stack.includes('matter-ws-switch.test.ts')) {
    process.stderr.write('101-matter-child:actual-checkpoint-failure\\n');
    throw new Error('Deliberate assertion failure after actual child close was captured');
  }
  return Reflect.apply(equal, this, [actual, expected, ...args]);
};\n`);
  const environment = { ...process.env }; delete environment.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--experimental-strip-types', '--import', pathToFileURL(injector).href,
    '--test', '--test-name-pattern=^actual child exit cannot replace held native child close even on failure$',
    resolve('packages/hub-server/src/matter-ws-switch.test.ts')],
  { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: environment });
  let output = '', injected = false, killed = false, deadline: ReturnType<typeof setTimeout> | undefined;
  const terminate = () => { killed = true; if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already closed. */ } } };
  const bootstrap = setTimeout(terminate, 10000);
  const collect = (bytes: Buffer) => {
    output = (output + bytes.toString()).slice(-16384);
    if (!injected && output.includes('101-matter-child:actual-checkpoint-failure')) {
      injected = true; clearTimeout(bootstrap); deadline = setTimeout(terminate, 4000);
    }
  };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  let nativeError: Error | undefined;
  child.once('error', error => { nativeError = error; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  try {
    const outcome = await closed;
    assert.equal(nativeError, undefined); assert.ok(injected, output);
    assert.equal(killed, false, output); assert.equal(outcome.signal, null); assert.equal(outcome.code, 1);
    const line = output.split('\n').find(line => line.includes('"site":"matter-child-close-checkpoint"'));
    assert.ok(line, 'The failed real checkpoint must retain native diagnostics: ' + output);
    const diagnostic = JSON.parse(line.slice(line.indexOf('{')));
    assert.equal(diagnostic.failure, false); assert.equal(diagnostic.waitMs, 2500);
    assert.equal(diagnostic.closeCaptured, true); assert.equal(diagnostic.settled, false);
    assert.ok(Number.isInteger(diagnostic.childPid) && diagnostic.childPid > 0);
    assert.deepEqual(diagnostic.events.map((event: { event: string }) => event.event), ['spawn', 'exit', 'close']);
    assert.ok(diagnostic.events.every((event: { childPid: number; elapsedMs: number }) => event.childPid === diagnostic.childPid && Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0));
    assert.equal(diagnostic.events[1].code, 0); assert.equal(diagnostic.events[1].signal, null);
    t.diagnostic(JSON.stringify({ injected, killed, ...outcome, retained: diagnostic }));
  } finally {
    clearTimeout(bootstrap); if (deadline) clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) terminate();
    await closed; child.stdout.off('data', collect); child.stderr.off('data', collect);
  }
});
