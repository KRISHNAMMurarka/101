import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

interface Inventory {
  declaredSources: { path: string; sha256: string } | null;
  packages: { installedPath: string; coverage: string; licenseFiles: { path: string; sha256: string }[] }[];
  licenseTexts: { sha256: string; bytes: number; text: string }[];
  coverage: { complete: boolean; packagesWithoutText: number };
}
const run = promisify(execFile);
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const readme = await readFile(new URL('./fixtures/license-readmes/imurmurhash-0.1.4.md', import.meta.url));
assert.equal(sha(readme), '4491517f7deb68d0b2a3bb590e785e276a60f12448447a9650d0bd50161a101c');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), '101-declared-license-'));
  await mkdir(join(root, 'tools')); const directory = join(root, 'node_modules/imurmurhash'); await mkdir(directory, { recursive: true });
  await copyFile(new URL('../tools/generate-license-inventory.mjs', import.meta.url), join(root, 'tools/generate-license-inventory.mjs'));
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/imurmurhash': { version: '0.1.4', license: 'MIT' } } }));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'imurmurhash', version: '0.1.4', license: 'MIT' }));
  await writeFile(join(directory, 'README.md'), readme);
  const source = { name: 'imurmurhash', version: '0.1.4', installedPath: 'node_modules/imurmurhash', licenseFiles: [{ path: 'README.md', sha256: sha(readme) }] };
  const manifest = { schemaVersion: 1, packages: [source] }; const path = join(root, 'THIRD_PARTY_LICENSE_SOURCES.json');
  const declare = (value: unknown = manifest) => writeFile(path, JSON.stringify(value) + '\n');
  const api = await import(pathToFileURL(join(root, 'tools/generate-license-inventory.mjs')).href) as { collectLicenseInventory: (options: { root: string }) => Promise<Inventory> };
  return { root, directory, path, source, manifest, declare, collect: () => api.collectLicenseInventory({ root }), close: () => rm(root, { recursive: true, force: true }) };
}

test('declared exact installed README license terms survive inventory regeneration without rewriting authored bytes', async () => {
  const f = await fixture(); try {
    await f.declare(); const result = await f.collect();
    assert.deepEqual(result.packages[0].licenseFiles, [{ path: 'README.md', sha256: sha(readme) }]);
    assert.equal(result.licenseTexts[0].text, readme.toString('utf8')); assert.equal(result.licenseTexts[0].bytes, readme.length);
    assert.deepEqual(result.declaredSources, { path: 'THIRD_PARTY_LICENSE_SOURCES.json', sha256: sha(await readFile(f.path)) });
    assert.equal(result.coverage.complete, true);
  } finally { await f.close(); }
});

test('an undeclared README remains incomplete even when it contains a license-looking heading', async () => {
  const f = await fixture(); try {
    const result = await f.collect(); assert.deepEqual(result.packages[0].licenseFiles, []); assert.equal(result.coverage.complete, false);
    assert.equal(result.coverage.packagesWithoutText, 1); assert.equal(result.declaredSources, null);
  } finally { await f.close(); }
});

test('changed declared README bytes fail before an existing inventory can be replaced', async () => {
  const f = await fixture(); try {
    await f.declare(); await writeFile(join(f.directory, 'README.md'), 'Changed terms');
    const output = join(f.root, 'THIRD_PARTY_LICENSES.json'); await writeFile(output, 'previous accepted inventory');
    await assert.rejects(f.collect, /declared.*(?:hash|bytes|changed)/i); assert.equal(await readFile(output, 'utf8'), 'previous accepted inventory');
  } finally { await f.close(); }
});

for (const field of ['name', 'version', 'installedPath'] as const) test(`declared source ${field} must match an exact lockfile identity`, async () => {
  const f = await fixture(); try {
    await f.declare({ ...f.manifest, packages: [{ ...f.source, [field]: field === 'installedPath' ? 'node_modules/unlocked' : 'different' }] });
    await assert.rejects(f.collect, /declared.*(?:identity|lock)/i);
  } finally { await f.close(); }
});

test('duplicate source identities, duplicate file paths and invalid hashes fail instead of silently shadowing a declaration', async () => {
  const f = await fixture(); try {
    for (const packages of [[f.source, f.source], [{ ...f.source, licenseFiles: [f.source.licenseFiles[0], f.source.licenseFiles[0]] }], [{ ...f.source, licenseFiles: [{ path: 'README.md', sha256: 'not-a-hash' }] }]]) {
      await f.declare({ ...f.manifest, packages }); await assert.rejects(f.collect, /declared/i);
    }
  } finally { await f.close(); }
});

test('declared paths cannot escape, alias platform paths, or follow a symlink to unrelated terms', async () => {
  const f = await fixture(); try {
    for (const path of ['../outside', '/outside', 'C:outside', 'sub\\outside', 'sub/../README.md']) {
      await f.declare({ ...f.manifest, packages: [{ ...f.source, licenseFiles: [{ path, sha256: sha(readme) }] }] }); await assert.rejects(f.collect, /declared.*path/i);
    }
    await f.declare(); await rm(join(f.directory, 'README.md')); await writeFile(join(f.root, 'outside'), readme);
    await symlink(join(f.root, 'outside'), join(f.directory, 'README.md')); await assert.rejects(f.collect, /ordinary/i);
    await rm(join(f.directory, 'README.md')); await assert.rejects(f.collect, { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('malformed, excessive and nonordinary declaration files fail without an inventory write', async () => {
  const f = await fixture(); try {
    await writeFile(f.path, '{'); await assert.rejects(f.collect);
    for (const manifest of [{ schemaVersion: 2, packages: [] }, { schemaVersion: 1, packages: {} }, { schemaVersion: 1, packages: [{ ...f.source, licenseFiles: [] }] }, { schemaVersion: 1, packages: Array(2049).fill(null) }]) {
      await f.declare(manifest); await assert.rejects(f.collect, /declared/i);
    }
    await writeFile(f.path, Buffer.alloc(131073, 65)); await assert.rejects(f.collect, /bound/i);
    await rm(f.path); const outside = join(f.root, 'outside-manifest'); await writeFile(outside, JSON.stringify(f.manifest)); await symlink(outside, f.path);
    await assert.rejects(f.collect, /ordinary/i); await assert.rejects(readFile(join(f.root, 'THIRD_PARTY_LICENSES.json')), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('actual inventory CLI rejects changed declared terms before replacing prior accepted bytes', async () => {
  const f = await fixture(); try {
    await f.declare(); await writeFile(join(f.directory, 'README.md'), 'Changed terms');
    const output = join(f.root, 'THIRD_PARTY_LICENSES.json'); await writeFile(output, 'previous accepted inventory');
    await assert.rejects(run(process.execPath, [join(f.root, 'tools/generate-license-inventory.mjs')], { cwd: f.root }), /Declared license source bytes/);
    assert.equal(await readFile(output, 'utf8'), 'previous accepted inventory');
  } finally { await f.close(); }
});
