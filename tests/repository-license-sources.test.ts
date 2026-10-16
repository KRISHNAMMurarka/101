import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';

const run = promisify(execFile);
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const prefix = 'third_party/licenses/npm/keyv/4.5.4';
const authored = await readFile(new URL('../' + prefix + '/LICENSE', import.meta.url));
const proofBytes = await readFile(new URL('../' + prefix + '/provenance.json', import.meta.url));
const proof = JSON.parse(proofBytes.toString('utf8'));
assert.equal(sha(authored), '1f7dca26d2d328c3dbb9b6fe3b15ec3cda08ffe2288e47b73d617454b256f959');
assert.equal(sha(proofBytes), 'f9caddaf0ec028005d003db066a4187046db81c9f96535fbc6662f8617c2e231');
// Exact public npm artifact, never evaluated or installed by this fixture.
const tarball = Buffer.from(await readFile(new URL('./fixtures/license-author-source/keyv-4.5.4.tgz.base64.txt', import.meta.url), 'utf8'), 'base64');
assert.equal('sha512-' + createHash('sha512').update(tarball).digest('base64'), proof.lockedArtifact.integrity);
const archive = gunzipSync(tarball), files = new Map<string, Buffer>();
for (let at = 0; at + 512 <= archive.length && archive[at];) {
  const name = archive.subarray(at, at + 100).toString().split('\0')[0]!;
  const size = parseInt(archive.subarray(at + 124, at + 136).toString().replace(/\0/g, '').trim(), 8);
  if (archive[at + 156] === 53) { assert.ok(['package', 'package/src'].includes(name) && size === 0); at += 512; continue; }
  assert.ok(name.startsWith('package/') && !name.split('/').includes('..') && Number.isSafeInteger(size));
  assert.ok([0, 48].includes(archive[at + 156]!));
  files.set(name.slice(8), Buffer.from(archive.subarray(at + 512, at + 512 + size)));
  at += 512 + Math.ceil(size / 512) * 512;
}
assert.equal(files.size, 4);
for (const file of proof.publishedFiles) assert.equal(sha(files.get(file.path)!), file.sha256);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), '101-repository-license-'));
  for (const name of ['generate-license-inventory.mjs', 'license-inventory-validation.mjs', 'package-release.mjs', 'web-artifact-validation.mjs']) {
    await mkdir(join(root, 'tools'), { recursive: true });
    await copyFile(new URL('../tools/' + name, import.meta.url), join(root, 'tools', name));
  }
  const directory = join(root, 'node_modules/keyv'); await mkdir(directory, { recursive: true });
  for (const [path, bytes] of files) { await mkdir(dirname(join(directory, path)), { recursive: true }); await writeFile(join(directory, path), bytes); }
  const locked = { version: '4.5.4', license: 'MIT', ...proof.lockedArtifact };
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/keyv': locked } }));
  const file = { origin: 'repository-author-source', path: prefix + '/LICENSE', sha256: sha(authored),
    provenance: { path: prefix + '/provenance.json', sha256: sha(proofBytes) } };
  const row = { name: 'keyv', version: '4.5.4', installedPath: 'node_modules/keyv', licenseFiles: [file] };
  const manifest = { schemaVersion: 2, packages: [row] };
  await mkdir(join(root, prefix), { recursive: true }); await writeFile(join(root, file.path), authored); await writeFile(join(root, file.provenance.path), proofBytes);
  const declare = () => writeFile(join(root, 'THIRD_PARTY_LICENSE_SOURCES.json'), JSON.stringify(manifest) + '\n');
  await declare();
  const api = await import(pathToFileURL(join(root, 'tools/generate-license-inventory.mjs')).href);
  const validation = await import(pathToFileURL(join(root, 'tools/license-inventory-validation.mjs')).href);
  const collect = () => api.collectLicenseInventory({ root });
  async function setProof(value: typeof proof) { const bytes = JSON.stringify(value) + '\n'; file.provenance.sha256 = sha(bytes); await writeFile(join(root, file.provenance.path), bytes); await declare(); }
  async function inventory() { const value = await collect(); await writeFile(join(root, 'THIRD_PARTY_LICENSES.json'), JSON.stringify(value)); return value; }
  async function rust() {
    const path = 'apps/desktop-hub/src-tauri'; await mkdir(join(root, path), { recursive: true });
    const lock = 'version = 4\n[[package]]\nname = "owned-fixture"\nversion = "1.0.0"\n';
    await writeFile(join(root, path, 'Cargo.lock'), lock); await writeFile(join(root, path, 'Cargo.toml'), '[package]\nname = "owned-fixture"\nversion = "1.0.0"\n');
    await writeFile(join(root, 'THIRD_PARTY_RUST_LICENSES.json'), JSON.stringify({ schemaVersion: 1, generatedFrom: path + '/Cargo.lock', lockSha256: sha(lock), metadataSha256: sha('fixture'), packages: [], licenseTexts: [],
      coverage: { complete: true, lockedPackages: 0, missingPackages: 0, packagesWithoutText: 0, distinctTexts: 0, textBytes: 0, scope: 'Owned empty Cargo dependency fixture' } }));
  }
  return { root, directory, file, row, manifest, declare, setProof, collect, inventory, rust, api, validation,
    close: () => rm(root, { recursive: true, force: true }) };
}

test('versioned repository author text preserves exact Keyv bytes, provenance and unchanged installed distribution', async () => {
  const f = await fixture(); try {
    const result = await f.inventory(); const file = result.packages[0].licenseFiles[0];
    assert.equal(result.packages[0].coverage, 'repository-author-texts');
    assert.equal(file.origin, 'repository-author-source'); assert.deepEqual(file.provenance, { ...f.file.provenance, document: proof });
    assert.equal(file.sha256, sha(authored)); assert.equal(result.licenseTexts[0].text, authored.toString('utf8'));
    assert.equal(result.coverage.packagesWithoutText, 0);
    for (const [path, bytes] of files) assert.deepEqual(await readFile(join(f.directory, path)), bytes);
    await f.rust(); await f.validation.auditReleaseLicenseInventories(f.root);
  } finally { await f.close(); }
});

test('legacy v1 installed legal sources retain package-relative origin and exact bytes', async () => {
  const f = await fixture(); try {
    f.manifest.schemaVersion = 1;
    const manifest = { schemaVersion: 1, packages: [{ ...f.row, licenseFiles: [{ path: 'README.md', sha256: sha(files.get('README.md')!) }] }] };
    await writeFile(join(f.root, 'THIRD_PARTY_LICENSE_SOURCES.json'), JSON.stringify(manifest));
    const result = await f.collect(); assert.equal(result.packages[0].coverage, 'local-texts');
    assert.deepEqual(result.packages[0].licenseFiles, manifest.packages[0]!.licenseFiles);
  } finally { await f.close(); }
});

for (const cause of ['row-name', 'row-version', 'proof-name', 'proof-version', 'proof-package', 'resolved', 'integrity', 'installed-file', 'body-hash', 'proof-hash', 'commit', 'blob', 'source-path', 'missing-proof', 'unknown-origin', 'extra-proof-field', 'missing-manifest-file'] as const)
  test(`repository author source refuses ${cause} without replacing prior inventory`, async () => {
    const f = await fixture(); try {
      const output = join(f.root, 'THIRD_PARTY_LICENSES.json'); await writeFile(output, 'prior accepted inventory');
      const changed = structuredClone(proof);
      if (cause === 'row-name') f.row.name = 'another';
      else if (cause === 'row-version') f.row.version = '5.0.0';
      else if (cause === 'proof-name') changed.name = 'another';
      else if (cause === 'proof-version') changed.version = '5.0.0';
      else if (cause === 'proof-package') changed.installedPath = 'node_modules/another';
      else if (cause === 'resolved') changed.lockedArtifact.resolved += '?another';
      else if (cause === 'integrity') changed.lockedArtifact.integrity = 'sha512-' + 'A'.repeat(86) + '==';
      else if (cause === 'installed-file') await writeFile(join(f.directory, 'src/index.js'), 'changed installed bytes');
      else if (cause === 'body-hash') f.file.sha256 = '0'.repeat(64);
      else if (cause === 'proof-hash') f.file.provenance.sha256 = '0'.repeat(64);
      else if (cause === 'commit') changed.source.commit = 'main';
      else if (cause === 'blob') changed.source.gitBlobSha1 = '0'.repeat(40);
      else if (cause === 'source-path') changed.source.path = '../LICENSE';
      else if (cause === 'missing-proof') await rm(join(f.root, f.file.provenance.path));
      else if (cause === 'unknown-origin') f.file.origin = 'url';
      else if (cause === 'extra-proof-field') changed.url = 'https://unrelated.invalid/';
      else if (cause === 'missing-manifest-file') changed.publishedFiles = changed.publishedFiles.filter((file: { path: string }) => file.path !== 'package.json');
      if (['proof-name', 'proof-version', 'proof-package', 'resolved', 'integrity', 'commit', 'blob', 'source-path', 'extra-proof-field', 'missing-manifest-file'].includes(cause)) await f.setProof(changed);
      else await f.declare();
      await assert.rejects(f.collect); assert.equal(await readFile(output, 'utf8'), 'prior accepted inventory');
    } finally { await f.close(); }
  });

for (const path of ['../LICENSE', '/LICENSE', 'C:LICENSE', 'third_party/licenses/npm/other/4.5.4/LICENSE', prefix + '/sub/../LICENSE', 'https://example.invalid/LICENSE'])
  test(`repository author source refuses nonexact repository path ${path}`, async () => {
    const f = await fixture(); try { f.file.path = path; await f.declare(); await assert.rejects(f.collect, /author|declared|path/i); } finally { await f.close(); }
  });

for (const mode of ['text', 'ancestor', 'proof'] as const) test(`repository author source refuses ${mode} symlinks`, async () => {
  const f = await fixture(); try {
    const target = join(f.root, 'outside'); await writeFile(target, mode === 'proof' ? proofBytes : authored);
    const path = mode === 'proof' ? f.file.provenance.path : f.file.path;
    if (mode === 'ancestor') { await rm(join(f.root, prefix), { recursive: true }); await mkdir(join(f.root, 'elsewhere')); await symlink(join(f.root, 'elsewhere'), join(f.root, prefix)); }
    else { await rm(join(f.root, path)); await symlink(target, join(f.root, path)); }
    await assert.rejects(f.collect, /ordinary/i);
  } finally { await f.close(); }
});

test('absent optional target remains not-installed and cannot claim repository author text coverage', async () => {
  const f = await fixture(); try {
    await rm(f.directory, { recursive: true });
    const result = await f.collect(); assert.equal(result.packages[0].coverage, 'not-installed');
    assert.deepEqual(result.packages[0].licenseFiles, []); assert.equal(result.licenseTexts.length, 0);
    assert.equal(result.coverage.complete, false); assert.equal(result.coverage.missingPackages, 1);
    await f.inventory(); await f.rust(); await f.validation.auditReleaseLicenseInventories(f.root);
  } finally { await f.close(); }
});

for (const cause of ['origin', 'proof', 'body', 'undeclared-author-entry', 'claimed-missing', 'changed-installed-source', 'missing-source-proof'] as const) test(`artifact validator rejects ${cause} substitution`, async () => {
  const f = await fixture(); try {
    const value = await f.inventory(); await f.rust(); const entry = value.packages[0].licenseFiles[0];
    if (cause === 'origin') delete entry.origin;
    else if (cause === 'proof') entry.provenance.document.source.commit = '0'.repeat(40);
    else if (cause === 'body') value.licenseTexts[0].text += '\n';
    else if (cause === 'undeclared-author-entry') value.packages[0].licenseFiles.push({ ...entry, path: prefix + '/unreviewed' });
    else if (cause === 'claimed-missing') { value.packages[0].coverage = 'not-installed'; value.packages[0].licenseFiles = []; value.licenseTexts = [];
      Object.assign(value.coverage, { complete: false, missingPackages: 1, distinctTexts: 0, textBytes: 0 }); }
    else if (cause === 'changed-installed-source') await writeFile(join(f.directory, 'src/index.js'), 'changed after inventory');
    else await rm(join(f.root, f.file.provenance.path));
    await writeFile(join(f.root, 'THIRD_PARTY_LICENSES.json'), JSON.stringify(value));
    await assert.rejects(f.validation.auditReleaseLicenseInventories(f.root), /JavaScript license inventory/i);
  } finally { await f.close(); }
});

test('copied author-source closure retains exact manifest/body/proof and rejects copy tampering', async () => {
  const f = await fixture(); try {
    const selected = await f.api.collectDeclaredLicenseRepositoryFiles(f.root);
    assert.deepEqual(selected.map((file: { path: string }) => file.path).sort(), ['THIRD_PARTY_LICENSE_SOURCES.json', f.file.path, f.file.provenance.path].sort());
    const copy = join(f.root, 'copied'); await mkdir(copy);
    for (const file of selected) { await mkdir(dirname(join(copy, file.path)), { recursive: true }); await copyFile(join(f.root, file.path), join(copy, file.path)); }
    await f.api.verifyCopiedLicenseRepositoryFiles(copy, selected);
    await writeFile(join(copy, f.file.provenance.path), '{}'); await assert.rejects(f.api.verifyCopiedLicenseRepositoryFiles(copy, selected), /copied|hash/i);
  } finally { await f.close(); }
});

for (const installed of [true, false]) test(`actual packaging copies versioned author proof for ${installed ? 'installed' : 'absent optional'} target into its fingerprinted web closure`, async () => {
  const f = await fixture(); try {
    if (!installed) await rm(f.directory, { recursive: true });
    const collected = await f.inventory(); await f.rust();
    assert.equal(collected.packages[0].coverage, installed ? 'repository-author-texts' : 'not-installed');
    if (!installed) { assert.deepEqual(collected.packages[0].licenseFiles, []); assert.equal(collected.licenseTexts.length, 0); }
    for (const path of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'third_party/APACHE-2.0.txt', 'docs/vision.md']) {
      await mkdir(dirname(join(f.root, path)), { recursive: true }); await writeFile(join(f.root, path), 'Owned package metadata\n');
    }
    await writeFile(join(f.root, 'package.json'), JSON.stringify({ name: 'owned-fixture', version: '1.0.0', scripts: { build: 'node emit.mjs' } }));
    const paths = ['server/index.js', 'server/BUILD_ID', 'client/sw.js', 'client/link.webmanifest', 'client/manifest.webmanifest', 'client/icons/101-link.svg',
      'client/models/hand_landmarker.task', 'client/models/pose_landmarker_lite.task', 'client/mediapipe/wasm/vision_wasm_internal.js', 'client/mediapipe/wasm/vision_wasm_internal.wasm',
      'client/mediapipe/wasm/vision_wasm_nosimd_internal.js', 'client/mediapipe/wasm/vision_wasm_nosimd_internal.wasm', 'client/_next/static/fixture.js'];
    await writeFile(join(f.root, 'emit.mjs'), `import{mkdirSync,writeFileSync}from'node:fs';import{dirname}from'node:path';for(const p of ${JSON.stringify(paths)}){mkdirSync(dirname('dist/'+p),{recursive:true});writeFileSync('dist/'+p,'public fixture');}mkdirSync('dist/client/.vite',{recursive:true});writeFileSync('dist/client/.vite/manifest.json',JSON.stringify({'virtual:vinext-app-browser-entry':{file:'_next/static/fixture.js'}}));writeFileSync('dist/client/vinext-client-entry-manifest.json',JSON.stringify({appBrowserEntry:'_next/static/fixture.js'}));`);
    const args = ['tools/package-release.mjs', '--release', 'web'];
    const launched = run(process.execPath, args, { cwd: f.root, timeout: 30000, maxBuffer: 131072 });
    const result = await launched;
    await writeFile(join(f.root, 'pack.stdout.log'), result.stdout); await writeFile(join(f.root, 'pack.stderr.log'), result.stderr);
    await writeFile(join(f.root, 'pack.invocation.json'), JSON.stringify({ argv: [process.execPath, ...args], cwd: f.root,
      pid: launched.child.pid, exitCode: launched.child.exitCode, signalCode: launched.child.signalCode,
      callbackJoined: true, timeoutMs: 30000, maxBuffer: 131072, NODE_OPTIONS: process.env.NODE_OPTIONS ?? null, NODE_PATH: process.env.NODE_PATH ?? null }));
    assert.equal(result.stderr, '');
    const names = (await readdir(join(f.root, 'release'))).filter(name => name.startsWith('package-')); assert.equal(names.length, 1);
    const manifest = JSON.parse(await readFile(join(f.root, 'release', names[0]!, 'manifest.json'), 'utf8'));
    assert.equal(manifest.packagingComplete, true); assert.equal(manifest.releaseAccepted, false);
    const produced = manifest.produced[0], artifact = join(f.root, produced.artifact);
    for (const path of ['THIRD_PARTY_LICENSE_SOURCES.json', f.file.path, f.file.provenance.path]) {
      const bytes = await readFile(join(artifact, path)); assert.deepEqual(bytes, await readFile(join(f.root, path)));
      assert.equal(produced.contents.find((file: { path: string }) => file.path === path).sha256, sha(bytes));
      assert.equal(manifest.source.inputs.files.find((file: { path: string }) => file.path === path).sha256, sha(bytes));
    }
    assert.equal((await lstat(join(artifact, f.file.path))).isFile(), true);
  } finally { await f.close(); }
});


test('a v1 declaration cannot silently acquire repository origin and Rust cannot claim this JavaScript-only coverage', async () => {
  const f = await fixture(); try {
    f.manifest.schemaVersion = 1; await f.declare(); await assert.rejects(f.collect, /versioned/i);
    f.manifest.schemaVersion = 2; await f.declare(); await f.inventory(); await f.rust();
    const path = join(f.root, 'THIRD_PARTY_RUST_LICENSES.json'); const value = JSON.parse(await readFile(path, 'utf8'));
    value.packages = [{ name: 'native-fixture', version: '1.0.0', source: 'registry+https://github.com/rust-lang/crates.io-index',
      license: 'MIT', coverage: 'repository-author-texts', licenseFiles: [{ path: 'LICENSE', sha256: sha(authored) }] }];
    value.licenseTexts = [{ sha256: sha(authored), bytes: authored.length, text: authored.toString('utf8') }];
    Object.assign(value.coverage, { lockedPackages: 1, distinctTexts: 1, textBytes: authored.length });
    const lockPath = join(f.root, 'apps/desktop-hub/src-tauri/Cargo.lock'); const lock = (await readFile(lockPath, 'utf8')) + '\n[[package]]\nname = "native-fixture"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n';
    await writeFile(lockPath, lock); value.lockSha256 = sha(lock); await writeFile(path, JSON.stringify(value));
    await assert.rejects(f.validation.auditReleaseLicenseInventories(f.root), /Rust license inventory: Invalid package license coverage/);
  } finally { await f.close(); }
});


test('repository source closure cannot substitute a workspace lock identity for an installed npm package', async () => {
  const f = await fixture(); try {
    const lock = JSON.parse(await readFile(join(f.root, 'package-lock.json'), 'utf8'));
    lock.packages['packages/keyv'] = lock.packages['node_modules/keyv']; delete lock.packages['node_modules/keyv'];
    f.row.installedPath = 'packages/keyv'; await f.declare(); await writeFile(join(f.root, 'package-lock.json'), JSON.stringify(lock));
    await assert.rejects(f.collect, /declared.*identity/i);
    await assert.rejects(f.api.collectDeclaredLicenseRepositoryFiles(f.root), /declared.*identity/i);
  } finally { await f.close(); }
});


test('absent target retains reviewed body and proof in copy closure without minting an installed-package witness', async () => {
  const f = await fixture(); try {
    await rm(f.directory, { recursive: true });
    const result = await f.inventory(); assert.equal(result.packages[0].coverage, 'not-installed');
    assert.deepEqual(result.packages[0].licenseFiles, []); assert.equal(result.licenseTexts.length, 0);
    const selected = await f.api.collectDeclaredLicenseRepositoryFiles(f.root);
    assert.deepEqual(selected.map((entry: { path: string }) => entry.path).sort(), ['THIRD_PARTY_LICENSE_SOURCES.json', f.file.path, f.file.provenance.path].sort());
    await assert.rejects(f.api.readRepositoryAuthorLicenseSource(f.root, f.row, f.file, proof.lockedArtifact), /requires installed package/);
    await f.rust(); await f.validation.auditReleaseLicenseInventories(f.root);
  } finally { await f.close(); }
});

for (const cause of ['missing-proof', 'changed-body', 'wrong-lock', 'invalid-commit'] as const)
  test(`absent target still rejects ${cause} in reviewed copied sources`, async () => {
    const f = await fixture(); try {
      await rm(f.directory, { recursive: true });
      if (cause === 'missing-proof') await rm(join(f.root, f.file.provenance.path));
      else if (cause === 'changed-body') await writeFile(join(f.root, f.file.path), 'Different author body');
      else { const changed = structuredClone(proof); if (cause === 'wrong-lock') changed.lockedArtifact.integrity = 'sha512-' + 'A'.repeat(86) + '==';
        else changed.source.commit = 'main'; await f.setProof(changed); }
      await assert.rejects(f.api.collectDeclaredLicenseRepositoryFiles(f.root));
    } finally { await f.close(); }
  });
