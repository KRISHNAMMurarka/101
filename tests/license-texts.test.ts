import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

interface Inventory {
  packages: { name: string; version: string; license: string; coverage: string; licenseFiles: { path: string; sha256: string }[] }[];
  licenseTexts: { sha256: string; bytes: number; text: string }[];
  coverage: { complete: boolean; missingPackages: number; packagesWithoutText: number };
  lockSha256: string;
}
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), '101-license-texts-'));
  await mkdir(join(root, 'tools')); await mkdir(join(root, 'node_modules'));
  await copyFile(new URL('../tools/generate-license-inventory.mjs', import.meta.url), join(root, 'tools/generate-license-inventory.mjs'));
  const packages: Record<string, { version: string; license?: string }> = {};
  async function lock() { await writeFile(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages })); }
  await lock();
  const api = await import(pathToFileURL(join(root, 'tools/generate-license-inventory.mjs')).href) as {
    collectLicenseInventory?: (options: { root: string }) => Promise<Inventory>;
  };
  async function add(name: string, license: string | null = 'MIT', installed = true) {
    packages['node_modules/' + name] = { version: '1.0.0', ...(license ? { license } : {}) }; await lock();
    const directory = join(root, 'node_modules', name);
    if (installed) { await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0' })); }
    return directory;
  }
  async function collect() { assert.equal(typeof api.collectLicenseInventory, 'function', 'Local license text collector exists'); return api.collectLicenseInventory!({ root }); }
  return { root, add, collect, close: () => rm(root, { recursive: true, force: true }) };
}

test('license inventory preserves actual local license and notice bytes with exact source hashes', async () => {
  const f = await fixture(); try {
    const directory = await f.add('alpha'); const license = 'MIT License\nCopyright (c) alpha contributors\n'; const notice = 'Third-party notice — exact attribution\n';
    await writeFile(join(directory, 'LICENSE'), license); await writeFile(join(directory, 'NOTICE.txt'), notice);
    const result = await f.collect(); assert.equal(result.packages[0].coverage, 'local-texts'); assert.equal(result.coverage.complete, true);
    assert.equal(result.licenseTexts.find(value => value.sha256 === digest(license))?.text, license);
    assert.equal(result.licenseTexts.find(value => value.sha256 === digest(notice))?.text, notice);
    assert.equal(result.lockSha256, digest(await readFile(join(f.root, 'package-lock.json'))));
    assert.deepEqual(result.packages[0].licenseFiles.map(value => value.path), ['LICENSE', 'NOTICE.txt']);
  } finally { await f.close(); }
});
test('absent optional packages and installed packages without license text stay explicitly incomplete', async () => {
  const f = await fixture(); try { await f.add('absent', 'MIT', false); const d = await f.add('empty'); await writeFile(join(d, 'README.md'), 'Documentation is not a license');
    const result = await f.collect(); assert.equal(result.coverage.complete, false); assert.equal(result.coverage.missingPackages, 1); assert.equal(result.coverage.packagesWithoutText, 1);
    assert.deepEqual(result.packages.map(value => value.coverage), ['not-installed', 'no-local-text']); assert.equal(result.licenseTexts.length, 0);
  } finally { await f.close(); }
});
test('unknown license declarations remain unknown and identical license text is stored once', async () => {
  const f = await fixture(); try { for (const name of ['alpha', 'beta']) await writeFile(join(await f.add(name, null), 'LICENSE'), 'Exact upstream text\n');
    const result = await f.collect(); assert.deepEqual(result.packages.map(value => value.license), ['UNKNOWN', 'UNKNOWN']); assert.equal(result.licenseTexts.length, 1);
    assert.equal(result.packages[0].licenseFiles[0].sha256, result.packages[1].licenseFiles[0].sha256);
  } finally { await f.close(); }
});
test('license directories preserve nested notices while ignoring unrelated package source files', async () => {
  const f = await fixture(); try { const d = await f.add('@vendor/alpha'); await mkdir(join(d, 'licenses/vendor'), { recursive: true });
    await writeFile(join(d, 'licenses/vendor/terms.txt'), 'Vendored terms\n'); await writeFile(join(d, 'index.js'), 'Not license text');
    const result = await f.collect(); assert.deepEqual(result.packages[0].licenseFiles.map(value => value.path), ['licenses/vendor/terms.txt']);
  } finally { await f.close(); }
});
test('installed package identity mismatch fails before replacing an existing inventory', async () => {
  const f = await fixture(); try { const d = await f.add('alpha'); await writeFile(join(d, 'package.json'), JSON.stringify({ name: 'alpha', version: '2.0.0' }));
    const output = join(f.root, 'THIRD_PARTY_LICENSES.json'); await writeFile(output, 'previous accepted bytes'); await assert.rejects(f.collect, /identity/);
    assert.equal(await readFile(output, 'utf8'), 'previous accepted bytes');
  } finally { await f.close(); }
});
test('symlink license files and symlink package roots cannot contribute outside text', async () => {
  const f = await fixture(); try { const d = await f.add('alpha'); const outside = join(f.root, 'unrelated-license'); await writeFile(outside, 'Unrelated bytes');
    await symlink(outside, join(d, 'LICENSE')); await assert.rejects(f.collect, /ordinary/);
    await rm(d, { recursive: true }); await mkdir(join(f.root, 'substituted')); await symlink(join(f.root, 'substituted'), d); await assert.rejects(f.collect, /ordinary/);
  } finally { await f.close(); }
});
test('selected legal-directory symlinks cannot hide missing vendored terms behind another license', async () => {
  const f = await fixture(); try { const d = await f.add('alpha'); await writeFile(join(d, 'LICENSE'), 'Package terms\n');
    const substituted = join(f.root, 'outside-terms'); await mkdir(substituted); await writeFile(join(substituted, 'NOTICE'), 'Vendored terms\n');
    await symlink(substituted, join(d, 'licenses')); await assert.rejects(f.collect, /ordinary/);
  } finally { await f.close(); }
});
test('oversized and invalid UTF-8 legal files fail without truncated successful coverage', async () => {
  const f = await fixture(); try { const d = await f.add('alpha'), file = join(d, 'LICENSE'); await writeFile(file, Buffer.alloc(131073, 65)); await assert.rejects(f.collect, /bound/);
    await writeFile(file, Buffer.from([0xc3, 0x28])); await assert.rejects(f.collect, /UTF-8/);
  } finally { await f.close(); }
});
test('collector import is inert and empty local lockfiles need no network or output write', async () => {
  const f = await fixture(); try { const output = join(f.root, 'THIRD_PARTY_LICENSES.json'); await assert.rejects(lstat(output), { code: 'ENOENT' });
    const result = await f.collect(); assert.equal(result.coverage.complete, true); assert.deepEqual(result.packages, []); await assert.rejects(lstat(output), { code: 'ENOENT' });
  } finally { await f.close(); }
});
