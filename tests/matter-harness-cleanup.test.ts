import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

test('failed pre-upgrade Matter assertion releases its actual held close and local server', async t => {
  const directory = await mkdtemp(join(tmpdir(), '101-matter-harness-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const injector = join(directory, 'assertion-failure.mjs');
  // A genuine test-body failure must also clean up. This changes only the
  // assertion outcome; the socket, held close event and producer are real.
  await writeFile(injector, `import assert from 'node:assert/strict';
const equal = assert.equal;
assert.equal = function(actual, expected, ...args) {
  if (expected === 'retiring') {
    process.stderr.write('101-matter-harness:actual-body-failure\\n');
    throw new Error('Deliberate assertion failure after real TCP shutdown');
  }
  return Reflect.apply(equal, this, [actual, expected, ...args]);
};\n`);
  const environment = { ...process.env }; delete environment.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--experimental-strip-types', '--import', pathToFileURL(injector).href,
    '--test', '--test-name-pattern=^pre-upgrade genuine TCP close remains owned independently$',
    resolve('packages/hub-server/src/matter-ws-switch.test.ts')],
  { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: environment });
  let output = '', injected = false, killed = false, deadline: ReturnType<typeof setTimeout> | undefined;
  const terminate = () => { killed = true; if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already closed. */ } } };
  // This is the observation window for a failed test runner's natural exit.
  // No connector, native operation, grant or existing test deadline changes.
  const bootstrap = setTimeout(terminate, 10000);
  const collect = (bytes: Buffer) => {
    output = (output + bytes.toString()).slice(-16384);
    if (!injected && output.includes('101-matter-harness:actual-body-failure')) {
      injected = true; clearTimeout(bootstrap); deadline = setTimeout(terminate, 4000);
    }
  };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  let nativeError: Error | undefined;
  child.once('error', error => { nativeError = error; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  try {
    const outcome = await closed;
    t.diagnostic(JSON.stringify({ injected, killed, ...outcome, actualChildClose: true }));
    assert.equal(nativeError, undefined);
    assert.ok(injected, 'The real test must reach the intended failure point: ' + output);
    assert.equal(killed, false, 'Failed test leaked a local listener or held close: ' + output);
    assert.equal(outcome.signal, null);
    assert.equal(outcome.code, 1, 'The original assertion must remain a failure');
  } finally {
    clearTimeout(bootstrap); if (deadline) clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) terminate();
    await closed; child.stdout.off('data', collect); child.stderr.off('data', collect);
  }
});
