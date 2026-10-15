import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

test('invalid ROS fixture mode rejects before loading its WebSocket dependency', async t => {
  const directory = await mkdtemp(join(tmpdir(), '101-ros-invalid-startup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const audit = join(directory, 'audit.mjs');
  await writeFile(audit, `import Module from 'node:module';
const load = Module._load;
Module._load = function(request, ...args) {
  if (request === 'ws') process.stderr.write('101-ros-invalid:loaded-ws\\n');
  return Reflect.apply(load, this, [request, ...args]);
};\n`);
  const startupEnvironment = process.platform === 'darwin' ? { __CF_USER_TEXT_ENCODING: `0x${process.getuid!().toString(16).toUpperCase()}:0:0` } : {};
  const child = fork(resolve('examples/rosbridge-pose/peer.mjs'), ['invalid-fixture-mode'], {
    execArgv: ['--import', pathToFileURL(audit).href], env: { NODE_ENV: 'production', ...startupEnvironment },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let errors = '', nativeError: Error | undefined;
  child.stderr!.on('data', bytes => { errors = (errors + bytes.toString()).slice(-8192); });
  child.once('error', error => { nativeError = error; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    assert.equal(nativeError, undefined); assert.ok(child.pid! > 0);
    assert.equal(outcome.signal, null, errors); assert.equal(outcome.code, 1, errors);
    assert.match(errors, /owned fixture mode required/);
    assert.equal(errors.includes('101-ros-invalid:loaded-ws'), false, 'Rejected fixture input must not initialize its optional protocol dependency');
  } finally { clearTimeout(timer); }
});
