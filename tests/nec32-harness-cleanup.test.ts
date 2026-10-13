import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

for (const callerOption of [false, true])
 test('failed emitter readiness fixture joins its actual held native close before returning' + (callerOption ? ' with caller option isolation' : ''), async t => {
  const directory = await mkdtemp(join(tmpdir(), '101-nec32-harness-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const injector = join(directory, 'failure-and-held-close.mjs'), callerPreload = join(directory, 'caller-preload.mjs');
  await writeFile(callerPreload, "throw Error('Unrelated caller preload reached the fixed software emitter');\n");
  // Fail the test's first wait after genuine native dispatch. Hold and forward
  // the actual close event once; no emitter message or readiness is fabricated.
  await writeFile(injector, `import { ChildProcess } from 'node:child_process';
import { afterEach } from 'node:test';
const originalSpawn = ChildProcess.prototype.spawn, nativeTimer = globalThis.setTimeout;
let selected, nativeClosed, injected = false, held = false, forwarded = false, callerOptionInherited = false, runnerContextInherited = false;
const callerPreload = ${JSON.stringify(pathToFileURL(callerPreload).href)};
if (${callerOption} && process.env.NODE_TEST_CONTEXT) process.env.NODE_OPTIONS = '--import=' + callerPreload;
ChildProcess.prototype.spawn = function(options) {
  const value = Reflect.apply(originalSpawn, this, [options]);
  if (options.args.some(arg => typeof arg === 'string' && arg.endsWith('/examples/ir-emitter/software-emitter.mjs'))) {
    selected = this; const emit = this.emit;
    callerOptionInherited = options.envPairs.some(value => value.startsWith('NODE_OPTIONS=') && value.includes(callerPreload));
    runnerContextInherited = options.envPairs.some(value => value.startsWith('NODE_TEST_CONTEXT='));
    nativeClosed = new Promise(resolve => this.once('close', resolve));
    this.emit = function(event, ...args) {
      if (event === 'close' && !held) {
        held = true;
        nativeTimer(() => { forwarded = true; Reflect.apply(emit, this, [event, ...args]); }, 50);
        return true;
      }
      return Reflect.apply(emit, this, [event, ...args]);
    };
  }
  return value;
};
globalThis.setTimeout = function(callback, milliseconds, ...args) {
  if (selected && !injected && milliseconds === 5 && new Error().stack.includes('/nec32-ir-emitter-gateway.test.ts')) {
    injected = true; process.stderr.write('101-nec32-harness:actual-dispatch-body-failure\\n');
    throw Error('Deliberate failure after actual native emitter dispatch');
  }
  return Reflect.apply(nativeTimer, this, [callback, milliseconds, ...args]);
};
afterEach(async () => {
  if (selected) {
    process.stderr.write('101-nec32-harness:' + JSON.stringify({ injected, held, forwarded, callerOptionInherited, runnerContextInherited, nativePid: selected.pid }) + '\\n');
    await nativeClosed;
    process.stderr.write('101-nec32-harness:actual-native-close-forwarded\\n');
  }
});
`);
  const environment = { ...process.env }; delete environment.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--experimental-strip-types', '--import', pathToFileURL(injector).href,
    '--test', '--test-name-pattern=^software child rejects a valid frame from a retired generation and token$',
    resolve('packages/hub-server/src/nec32-ir-emitter-gateway.test.ts')],
  { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: environment });
  let output = '', injected = false, killed = false, deadline: ReturnType<typeof setTimeout> | undefined;
  const terminate = () => { killed = true; if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already closed. */ } } };
  const bootstrap = setTimeout(terminate, 10000);
  const collect = (bytes: Buffer) => {
    output = (output + bytes.toString()).slice(-16384);
    if (!injected && output.includes('101-nec32-harness:actual-dispatch-body-failure')) {
      injected = true; clearTimeout(bootstrap); deadline = setTimeout(terminate, 4000);
    }
  };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  let nativeError: Error | undefined;
  child.once('error', error => { nativeError = error; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  try {
    const outcome = await closed;
    assert.equal(nativeError, undefined);
    assert.ok(injected, 'Actual native dispatch must reach the failure point: ' + output);
    assert.equal(killed, false, 'Failed emitter fixture must settle naturally: ' + output);
    assert.equal(outcome.signal, null);
    assert.equal(outcome.code, 1, 'The injected test failure must remain a failure');
    assert.ok(output.includes('101-nec32-harness:actual-native-close-forwarded'), 'The observer must join its actual native close');
    const confirmation = /101-nec32-harness:(\{[^\n]+\})/.exec(output);
    assert.ok(confirmation, 'The actual failed test must report its cleanup: ' + output);
    const { nativePid, ...state } = JSON.parse(confirmation[1]!);
    assert.ok(Number.isSafeInteger(nativePid) && nativePid > 0, 'The real fixed emitter must be dispatched with an actual PID');
    assert.deepEqual(state, { injected: true, held: true, forwarded: true, callerOptionInherited: false, runnerContextInherited: false },
      'The failed fixture must join actual close and exclude caller/runner environment');
  } finally {
    clearTimeout(bootstrap); if (deadline) clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) terminate();
    await closed; child.stdout.off('data', collect); child.stderr.off('data', collect);
  }
});
