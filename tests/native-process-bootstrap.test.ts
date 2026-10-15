import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

test('fixed native launches derive platform bootstrap environment without caller preloads', async t => {
  const directory = await mkdtemp(join(tmpdir(), '101-native-bootstrap-'));
  let ownedPid = 0;
  const groupAlive = () => {
    if (!ownedPid) return false;
    try { process.kill(-ownedPid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
  };
  t.after(async () => {
    assert.equal(groupAlive(), false, 'Owned native group must join before scratch removal');
    await rm(directory, { recursive: true, force: true });
  });
  const marker = join(directory, 'caller-preload-ran'), preload = join(directory, 'caller.mjs');
  const audit = join(directory, 'audit.mjs');
  const names = [
    'software child rejects a valid frame from a retired generation and token',
    'failed peer startup also waits for native child close without orphan rejection',
    'declared version mismatch is checked against the actual native handshake',
    'existing loader failure retains its actual earlier milestone and native close',
  ];
  await writeFile(preload, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'caller preload executed');\n`);
  await writeFile(audit, `import { ChildProcess } from 'node:child_process';
import { beforeEach, afterEach } from 'node:test';
const names = ${JSON.stringify(names)};
let current, previous;
beforeEach(t => {
  current = names.indexOf(t.name);
  if (current < 0) return;
  previous = [process.env.__CF_USER_TEXT_ENCODING, process.env.NODE_OPTIONS];
  process.env.__CF_USER_TEXT_ENCODING = 'caller-controlled-encoding';
  process.env.NODE_OPTIONS = ${JSON.stringify('--import=' + pathToFileURL(preload).href)};
});
afterEach(() => {
  if (current < 0 || !previous) return;
  for (const [index, key] of ['__CF_USER_TEXT_ENCODING', 'NODE_OPTIONS'].entries()) {
    if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
  }
  current = -1; previous = undefined;
});
const descriptor = Object.getOwnPropertyDescriptor(ChildProcess.prototype, 'spawn');
Object.defineProperty(ChildProcess.prototype, 'spawn', { ...descriptor, value: function(...args) {
  const result = Reflect.apply(descriptor.value, this, args);
  const argv = this.spawnargs;
  const match = current === 0 ? argv.some(v => v.endsWith('/software-emitter.mjs')) :
    current === 1 ? argv.some(v => v.endsWith('/rosbridge-pose/peer.mjs')) :
    current === 2 ? argv.includes('--eval') && argv.some(v => v.includes('read-rss')) :
    current === 3 && argv.some(v => v.endsWith('/runtime-host.mjs'));
  if (match) {
    const env = args[0].envPairs;
    process.stderr.write('101-native-bootstrap:' + JSON.stringify({ index: current, pid: this.pid,
      encoding: env.find(v => v.startsWith('__CF_USER_TEXT_ENCODING=')) ?? null,
      inheritedOptions: env.some(v => v.startsWith('NODE_OPTIONS=') && v !== 'NODE_OPTIONS='),
      inheritedPreload: [${JSON.stringify(pathToFileURL(preload).href)}, ${JSON.stringify(pathToFileURL(audit).href)}].some(v => argv.includes(v)) }) + '\\n');
  }
  return result;
} });
process.once('exit', () => Object.defineProperty(ChildProcess.prototype, 'spawn', descriptor));
`);
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT; delete environment.NODE_OPTIONS; delete environment.NODE_PATH;
  const child = spawn(process.execPath, ['--experimental-strip-types', '--import', pathToFileURL(audit).href,
    '--test', '--test-concurrency=1', '--test-name-pattern=^(' + names.join('|') + ')$',
    ...['packages/hub-server/src/nec32-ir-emitter-gateway.test.ts', 'packages/hub-server/src/rosbridge-pose-connector.test.ts',
      'packages/hub-server/src/scoped-agent-ipc.test.ts', 'tests/cross-host-workload.test.ts'].map(path => resolve(path))],
  { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: environment });
  ownedPid = child.pid ?? 0;
  let output = '', nativeError: Error | undefined, timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const killGroup = (signal: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, signal); } catch { /* Already joined. */ } } };
  const deadline = setTimeout(() => { timedOut = true; killGroup('SIGTERM'); killTimer = setTimeout(() => killGroup('SIGKILL'), 1000); }, 45000);
  const collect = (bytes: Buffer) => { output = (output + bytes.toString()).slice(-131072); };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  child.once('error', error => { nativeError = error; });
  try {
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    assert.equal(nativeError, undefined); assert.equal(timedOut, false, output);
    const observations = output.split('\n').filter(line => line.includes('101-native-bootstrap:'))
      .map(line => JSON.parse(line.slice(line.indexOf('101-native-bootstrap:') + '101-native-bootstrap:'.length)) as {
        index: number; pid: number; encoding: string | null; inheritedOptions: boolean; inheritedPreload: boolean;
      });
    assert.deepEqual(observations.map(value => value.index).sort(), [0, 1, 2, 3], output);
    const encoding = process.platform === 'darwin' ? '__CF_USER_TEXT_ENCODING=0x' + process.getuid!().toString(16).toUpperCase() + ':0:0' : null;
    for (const observed of observations) {
      assert.ok(observed.pid > 0, 'The real native launch returned a PID');
      assert.equal(observed.encoding, encoding, names[observed.index] + ': derive platform bootstrap environment');
      assert.equal(observed.inheritedOptions, false); assert.equal(observed.inheritedPreload, false);
    }
    assert.equal(existsSync(marker), false, 'Caller-only code must not execute in fixed children');
    assert.equal(outcome.signal, null, output); assert.equal(outcome.code, 0, output);
    assert.match(output, /(?:#|ℹ) pass 4\b/); assert.match(output, /(?:#|ℹ) (?:fail|skipped) 0\b/);
  } finally {
    clearTimeout(deadline);
    if (timedOut) {
      killGroup('SIGKILL');
      for (let turn = 0; turn < 100 && groupAlive(); turn++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(groupAlive(), false, 'Watchdog must join descendants after supervisor close');
    }
    clearTimeout(killTimer);
  }
});
