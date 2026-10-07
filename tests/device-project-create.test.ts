import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createDeviceScaffold } from '../packages/devkit/src/device-scaffold.ts';

const root = resolve(import.meta.dirname, '..');
function fixture(run: (directory: string, target: string) => void) {
  const directory = mkdtempSync('/tmp/101-create-device-test-');
  try { run(directory, join(directory, 'project')); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}
function create(target: string, hook?: string) {
  return execFileSync(process.execPath, [
    '--experimental-strip-types', ...(hook ? ['--import', hook] : []),
    'tools/create-device-project.mjs', 'room-sensor', target,
  ], { cwd: root, encoding: 'utf8', timeout: 10000, stdio: 'pipe' });
}

test('device CLI exclusively creates the exact current scaffold', () => {
  fixture((_directory, target) => {
    assert.match(create(target), /Created device project/);
    for (const [path, contents] of Object.entries(createDeviceScaffold({ id: 'room-sensor' })))
      assert.equal(readFileSync(join(target, path), 'utf8'), contents);
  });
});

test('device CLI preserves existing directory, file and symlink destinations', () => {
  fixture((directory, target) => {
    mkdirSync(target);
    const identity = lstatSync(target);
    assert.throws(() => create(target));
    assert.equal(lstatSync(target).ino, identity.ino);
    assert.equal(lstatSync(target).dev, identity.dev);
    writeFileSync(join(target, 'foreign'), 'foreign data');
    assert.throws(() => create(target));
    assert.equal(readFileSync(join(target, 'foreign'), 'utf8'), 'foreign data');
    const file = join(directory, 'file');
    writeFileSync(file, 'existing file');
    assert.throws(() => create(file));
    assert.equal(readFileSync(file, 'utf8'), 'existing file');
    const link = join(directory, 'link');
    symlinkSync(target, link);
    assert.throws(() => create(link));
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(readFileSync(join(target, 'foreign'), 'utf8'), 'foreign data');
  });
});

test('device CLI refuses a real directory acquired at the native ownership boundary', () => {
  fixture((directory, target) => {
    const hook = join(directory, 'race.mjs'), observed = join(directory, 'foreign-identity.json');
    // Exercise both the old rename boundary and the exclusive mkdir boundary.
    // The competitor uses actual native mkdir, not fabricated EEXIST/stat output.
    writeFileSync(hook, `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
const target = ${JSON.stringify(target)}, observed = ${JSON.stringify(observed)};
const nativeMkdir = fs.mkdir, nativeRename = fs.rename;
let acquired = false;
async function compete() {
  if (acquired) return;
  acquired = true;
  await nativeMkdir(target);
  const facts = await fs.lstat(target);
  await fs.writeFile(observed, JSON.stringify({ dev: facts.dev, ino: facts.ino }));
}
fs.mkdir = async function(path, ...options) {
  if (resolve(String(path)) === target) await compete();
  return nativeMkdir(path, ...options);
};
fs.rename = async function(from, to) {
  if (resolve(String(to)) === target) await compete();
  return nativeRename(from, to);
};
syncBuiltinESMExports();
`, { flag: 'wx' });
    let refused = false;
    try { create(target, hook); } catch { refused = true; }
    const before = JSON.parse(readFileSync(observed, 'utf8')) as { dev: number; ino: number };
    const after = lstatSync(target);
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino, 'Concurrent destination ownership must survive');
    assert.equal(refused, true, 'Creation must refuse a competing destination');
  });
});
