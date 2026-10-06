import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, symlink, chmod, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const source = 'registry+https://github.com/rust-lang/crates.io-index';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), '101-rust-legal-')));
  await mkdir(join(root, 'tools')); await mkdir(join(root, 'apps/desktop-hub/src-tauri'), { recursive: true });
  for (const name of ['generate-rust-license-inventory.mjs', 'generate-license-inventory.mjs']) await copyFile(new URL('../tools/' + name, import.meta.url), join(root, 'tools', name));
  const cargoHome = join(root, 'cache'); await mkdir(join(cargoHome, 'registry/src/owned'), { recursive: true });
  const packages: Record<string, unknown>[] = [];
  async function add(name: string, version = '1.0.0', license: string | null = 'MIT') {
    const directory = join(cargoHome, 'registry/src/owned', name + '-' + version); await mkdir(directory);
    const manifest_path = join(directory, 'Cargo.toml'); await writeFile(manifest_path, `[package]\nname = "${name}"\nversion = "${version}"\n`);
    packages.push({ name, version, license, source, id: source + '#' + name + '@' + version, manifest_path, license_file: null });
    return directory;
  }
  const metadata = () => Buffer.from(JSON.stringify({ version: 1, packages, workspace_members: ['owned-workspace'] }));
  async function lock() { await writeFile(join(root, 'apps/desktop-hub/src-tauri/Cargo.lock'), 'version = 4\n' + packages.map(p => `\n[[package]]\nname = "${p.name}"\nversion = "${p.version}"\nsource = "${p.source}"\n`).join('')); }
  async function collect() {
    await lock(); const api = await import(pathToFileURL(join(root, 'tools/generate-rust-license-inventory.mjs')).href);
    assert.equal(typeof api.collectRustLicenseInventory, 'function', 'Offline native legal-text collector exists');
    return api.collectRustLicenseInventory({ root, cargoHome, metadataBytes: metadata() });
  }
  async function fakeCargo() {
    const bin = join(root, 'bin'); await mkdir(bin);
    await writeFile(join(root, 'metadata.json'), metadata()); const calls = join(root, 'calls.json');
    await writeFile(join(bin, 'cargo'), `#!${process.execPath}\nimport{writeFileSync,readFileSync}from'node:fs';writeFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2)));if(!process.argv.includes('--offline')||!process.argv.includes('--locked'))process.exit(65);process.stdout.write(readFileSync(${JSON.stringify(join(root, 'metadata.json'))}));\n`);
    await chmod(join(bin, 'cargo'), 0o700);
    return { env: { ...process.env, PATH: bin + ':/usr/bin:/bin', CARGO_HOME: cargoHome }, calls };
  }
  return { root, cargoHome, packages, add, lock, collect, fakeCargo, dispose: () => rm(root, { recursive: true, force: true }) };
}

test('Rust collector import is inert and CLI uses locked offline Cargo metadata', async () => {
  const f = await fixture(); try {
    const d = await f.add('alpha'); await writeFile(join(d, 'LICENSE'), 'License alpha\n'); await f.lock(); const cargo = await f.fakeCargo();
    const imported = spawnSync(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(pathToFileURL(join(f.root, 'tools/generate-rust-license-inventory.mjs')).href)});`], { env: cargo.env, encoding: 'utf8', timeout: 10000 });
    assert.equal(imported.status, 0, imported.stderr); await assert.rejects(readFile(cargo.calls), { code: 'ENOENT' });
    const cli = spawnSync(process.execPath, [join(f.root, 'tools/generate-rust-license-inventory.mjs')], { env: cargo.env, encoding: 'utf8', timeout: 10000 });
    assert.equal(cli.status, 0, cli.stderr); const args = JSON.parse(await readFile(cargo.calls, 'utf8')); assert.ok(args.includes('--offline')); assert.ok(args.includes('--locked'));
    const inventory = JSON.parse(await readFile(join(f.root, 'THIRD_PARTY_RUST_LICENSES.json'), 'utf8')); assert.equal(inventory.coverage.complete, true);
  } finally { await f.dispose(); }
});
test('Rust collection preserves exact license and notice bytes, declared paths and lock provenance', async () => {
  const f = await fixture(); try { const d = await f.add('alpha'); const legal = '\uFEFFCopyright — alpha\n'; await writeFile(join(d, 'LICENSE-MIT'), legal); await mkdir(join(d, 'licenses')); await writeFile(join(d, 'licenses/vendor.txt'), 'Vendor terms\n'); await writeFile(join(d, 'terms.txt'), 'Declared terms\n'); f.packages[0].license_file = 'terms.txt';
    const r = await f.collect(); assert.equal(r.licenseTexts.find((t: { sha256: string }) => t.sha256 === digest(legal)).text, legal); assert.equal(r.packages[0].licenseFiles.length, 3); assert.equal(r.lockSha256, digest(await readFile(join(f.root, 'apps/desktop-hub/src-tauri/Cargo.lock'), 'utf8'))); assert.ok(!JSON.stringify(r).includes(f.cargoHome));
  } finally { await f.dispose(); }
});
test('Rust unknown declarations, deduplicated bytes and missing local legal texts remain explicit', async () => {
  const f = await fixture(); try { const a = await f.add('alpha', '1.0.0', null), b = await f.add('beta'); await f.add('empty'); await writeFile(join(a, 'LICENSE'), 'Same terms\n'); await writeFile(join(b, 'LICENSE'), 'Same terms\n'); const r = await f.collect(); assert.equal(r.licenseTexts.length, 1); assert.equal(r.packages[0].license, 'UNKNOWN'); assert.equal(r.coverage.packagesWithoutText, 1); assert.equal(r.coverage.complete, false);
  } finally { await f.dispose(); }
});
test('Rust package identity and source must match locked metadata', async () => {
  const f = await fixture(); try { const d = await f.add('alpha'); await writeFile(join(d, 'Cargo.toml'), '[package]\nname = "substitute"\nversion = "1.0.0"\n'); await assert.rejects(f.collect, /identity/); } finally { await f.dispose(); }
});
test('Rust missing cache packages stay incomplete instead of fabricating legal bytes', async () => {
  const f = await fixture(); try { const d = await f.add('alpha'); await rm(d, { recursive: true }); const r = await f.collect(); assert.equal(r.coverage.missingPackages, 1); assert.equal(r.packages[0].coverage, 'not-installed'); assert.equal(r.coverage.complete, false); } finally { await f.dispose(); }
});
test('Rust oversized native manifests fail without partial successful collection', async () => {
  const f = await fixture(); try { const d = await f.add('alpha'); await writeFile(join(d, 'Cargo.toml'), '[package]\nname = "alpha"\nversion = "1.0.0"\n' + '#'.repeat(131073)); await assert.rejects(f.collect, /bound/); } finally { await f.dispose(); }
});
test('Rust declared license paths cannot escape or traverse a symlink', async () => {
  const f = await fixture(); try { const d = await f.add('alpha'); await writeFile(join(f.root, 'outside'), 'Outside bytes'); f.packages[0].license_file = '../outside'; await assert.rejects(f.collect, /path/); f.packages[0].license_file = 'selected.txt'; await symlink(join(f.root, 'outside'), join(d, 'selected.txt')); await assert.rejects(f.collect, /ordinary/); } finally { await f.dispose(); }
});
test('Rust metadata cannot select a package outside the ordinary Cargo cache', async () => {
  const f = await fixture(); try { await f.add('alpha'); f.packages[0].manifest_path = join(f.root, 'outside/Cargo.toml'); await assert.rejects(f.collect, /cache/); } finally { await f.dispose(); }
});
test('Rust CLI failure preserves the previous native license inventory', async () => {
  const f = await fixture(); try { const d = await f.add('alpha'); await writeFile(join(d, 'Cargo.toml'), '[package]\nname = "wrong"\nversion = "1.0.0"\n'); await f.lock(); const cargo = await f.fakeCargo(); const target = join(f.root, 'THIRD_PARTY_RUST_LICENSES.json'); await writeFile(target, 'retained bytes'); const cli = spawnSync(process.execPath, [join(f.root, 'tools/generate-rust-license-inventory.mjs')], { env: cargo.env, encoding: 'utf8', timeout: 10000 }); assert.notEqual(cli.status, 0); assert.equal(await readFile(target, 'utf8'), 'retained bytes'); } finally { await f.dispose(); }
});
