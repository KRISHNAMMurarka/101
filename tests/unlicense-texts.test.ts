import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);
const source = new URL('./fixtures/license-unlicense/stream-buffers-2.2.0.UNLICENSE', import.meta.url);
const digest = (raw: Uint8Array) => createHash('sha256').update(raw).digest('hex');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), '101-unlicense-texts-'));
  try {
    const directory = join(root, 'node_modules/stream-buffers'); await mkdir(directory, { recursive: true });
    await mkdir(join(root, 'tools'));
    await copyFile(new URL('../tools/generate-license-inventory.mjs', import.meta.url), join(root, 'tools/generate-license-inventory.mjs'));
    await copyFile(new URL('./fixtures/license-unlicense/package.json', import.meta.url), join(directory, 'package.json'));
    await writeFile(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
      'node_modules/stream-buffers': { version: '2.2.0', license: 'Unlicense',
        resolved: 'https://registry.npmjs.org/stream-buffers/-/stream-buffers-2.2.0.tgz',
        integrity: 'sha512-uyQK/mx5QjHun80FLJTfaWE7JtwfRMKBLkMne6udYOmvH0CawotVa7TfgYHzAnpphn4+TweIx1QKMnRIbipmUg==', engines: { node: '>= 0.10.0' } },
    } }));
    const api = await import(pathToFileURL(join(root, 'tools/generate-license-inventory.mjs')).href);
    return { root, directory, collect: () => api.collectLicenseInventory({ root }), close: () => rm(root, { recursive: true, force: true }) };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

test('root UNLICENSE keeps the exact installed stream-buffers author file', async () => {
  const f = await fixture(); try {
    const raw = await readFile(source); assert.equal(raw.length, 1210);
    assert.equal(digest(raw), 'ca2abdf695884c77ea4b4a5b64ca7b732d9d9dbade4eebc1c2e76c53e9e3bc83');
    await writeFile(join(f.directory, 'UNLICENSE'), raw);
    const result = await f.collect(); const row = result.packages[0];
    assert.equal(row.name, 'stream-buffers'); assert.equal(row.version, '2.2.0'); assert.equal(row.license, 'Unlicense');
    assert.equal(row.coverage, 'local-texts'); assert.deepEqual(row.licenseFiles, [{ path: 'UNLICENSE', sha256: digest(raw) }]);
    assert.equal(result.coverage.packagesWithoutText, 0);
    const text = result.licenseTexts.find((value: { sha256: string }) => value.sha256 === digest(raw));
    assert.equal(text.bytes, raw.length); assert.deepEqual(Buffer.from(text.text, 'utf8'), raw);
  } finally { await f.close(); }
});

test('newly selected UNLICENSE sources reject unsafe bytes before replacing the prior CLI output', async t => {
  for (const kind of ['symlink', 'oversized', 'invalid-utf8']) await t.test(kind, async () => {
    const f = await fixture(); try {
      const target = join(f.directory, 'UNLICENSE'), output = join(f.root, 'THIRD_PARTY_LICENSES.json');
      const previous = Buffer.from('previous accepted inventory bytes'); await writeFile(output, previous);
      if (kind === 'symlink') {
        const outside = join(f.root, 'outside-author-file'); await copyFile(source, outside); await symlink(outside, target);
      } else await writeFile(target, kind === 'oversized' ? Buffer.alloc(131073, 65) : Buffer.from([0xc3, 0x28]));
      await assert.rejects(run(process.execPath, [join(f.root, 'tools/generate-license-inventory.mjs')], { cwd: f.root }),
        (error: { stderr?: string }) => new RegExp(kind === 'symlink' ? 'ordinary' : kind === 'oversized' ? 'byte bound' : 'UTF-8').test(error.stderr ?? ''));
      assert.deepEqual(await readFile(output), previous);
    } finally { await f.close(); }
  });
});
