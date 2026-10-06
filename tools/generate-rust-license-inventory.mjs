import { execFileSync } from 'node:child_process';
import { lstat, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectLocalPackageLegalTexts, readLocalLicenseBytes, LICENSE_INVENTORY_LIMITS } from './generate-license-inventory.mjs';

export const RUST_LICENSE_INVENTORY_LIMITS = Object.freeze({ ...LICENSE_INVENTORY_LIMITS, manifestBytes: 131072, metadataBytes: 8388608, cargoDeadlineMs: 10000 });
const lockPath = 'apps/desktop-hub/src-tauri/Cargo.lock';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const registry = 'registry+https://github.com/rust-lang/crates.io-index';
const utf8 = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const key = value => JSON.stringify([value.name, value.version, value.source ?? 'workspace']);
function fields(text) {
  const result = {};
  for (const line of text.split('\n')) {
    const value = line.match(/^(name|version|source)\s*=\s*(".*")\s*$/);
    if (value) { if (Object.hasOwn(result, value[1])) throw new Error('Duplicate Cargo package identity'); result[value[1]] = JSON.parse(value[2]); }
  }
  if (typeof result.name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(result.name) || typeof result.version !== 'string' || result.version.length > 128) throw new Error('Invalid Cargo package identity');
  return result;
}
async function cacheDirectory(cargoHome, manifest) {
  if (typeof manifest !== 'string' || manifest.length > 2048) throw new Error('Invalid Cargo cache path');
  const path = relative(cargoHome, manifest).split(sep).join('/');
  if (!path.startsWith('registry/src/') || !path.endsWith('/Cargo.toml') || path.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Manifest outside selected Cargo cache');
  let current = cargoHome;
  for (const part of path.split('/').slice(0, -1)) {
    current = join(current, part); let value;
    try { value = await lstat(current); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (value.isSymbolicLink() || !value.isDirectory()) throw new Error('Cargo cache requires ordinary directories');
  }
  return current;
}

/** Exact local crate legal bytes, selected from locked offline Cargo metadata. Importing is inert. */
export async function collectRustLicenseInventory({ root = resolve(import.meta.dirname, '..'), cargoHome = process.env.CARGO_HOME ?? join(homedir(), '.cargo'), metadataBytes } = {}) {
  root = resolve(root); cargoHome = resolve(cargoHome);
  if (await realpath(cargoHome) !== cargoHome || (await lstat(cargoHome)).isSymbolicLink()) throw new Error('Cargo cache requires ordinary root');
  if (!Buffer.isBuffer(metadataBytes) || metadataBytes.length > RUST_LICENSE_INVENTORY_LIMITS.metadataBytes) throw new Error('Cargo metadata byte bound exceeded');
  const metadata = JSON.parse(utf8(metadataBytes));
  if (metadata.version !== 1 || !Array.isArray(metadata.packages) || !Array.isArray(metadata.workspace_members) || metadata.packages.length > RUST_LICENSE_INVENTORY_LIMITS.packages || metadata.workspace_members.length > RUST_LICENSE_INVENTORY_LIMITS.packages) throw new Error('Invalid bounded Cargo metadata');
  const lockedBytes = await readLocalLicenseBytes(join(root, lockPath), RUST_LICENSE_INVENTORY_LIMITS.lockBytes);
  const locked = utf8(lockedBytes).split(/^\[\[package\]\]\s*$/m).slice(1).map(fields);
  if (locked.length > RUST_LICENSE_INVENTORY_LIMITS.packages || new Set(locked.map(key)).size !== locked.length) throw new Error('Invalid bounded Cargo lock identities');
  const workspace = new Set(metadata.workspace_members), firstParty = new Set(), byIdentity = new Map();
  for (const pkg of metadata.packages) {
    if (!pkg || typeof pkg.name !== 'string' || typeof pkg.version !== 'string' || typeof pkg.id !== 'string') throw new Error('Invalid Cargo metadata identity');
    const identity = key(pkg); if (byIdentity.has(identity) || !locked.some(item => key(item) === identity)) throw new Error('Cargo metadata identity does not match lockfile');
    if (workspace.has(pkg.id)) {
      if (pkg.source !== null || resolve(pkg.manifest_path) !== join(root, 'apps/desktop-hub/src-tauri/Cargo.toml')) throw new Error('Unexpected first-party Cargo identity');
      firstParty.add(identity);
    } else if (pkg.source !== registry) throw new Error('Unsupported Cargo source; separate legal collection required');
    byIdentity.set(identity, pkg);
  }
  const packages = [], texts = new Map(); let missingPackages = 0, packagesWithoutText = 0, total = 0;
  for (const item of locked) {
    const identity = key(item); if (firstParty.has(identity)) continue;
    const pkg = byIdentity.get(identity);
    const row = { name: item.name, version: item.version, license: pkg?.license ?? 'UNKNOWN', source: item.source ?? 'workspace', coverage: 'not-installed', licenseFiles: [] };
    const directory = pkg ? await cacheDirectory(cargoHome, pkg.manifest_path) : undefined;
    if (!directory) missingPackages++;
    else {
      const manifest = utf8(await readLocalLicenseBytes(pkg.manifest_path, RUST_LICENSE_INVENTORY_LIMITS.manifestBytes));
      const lines = manifest.split('\n'), start = lines.findIndex(line => line.trim() === '[package]');
      if (start < 0) throw new Error('Missing Cargo package identity');
      const end = lines.findIndex((line, index) => index > start && line.startsWith('['));
      const actual = fields(lines.slice(start + 1, end < 0 ? undefined : end).join('\n'));
      if (actual.name !== item.name || actual.version !== item.version) throw new Error('Cached Cargo package identity mismatch');
      if (pkg.license !== null && typeof pkg.license !== 'string' || pkg.license_file !== null && typeof pkg.license_file !== 'string') throw new Error('Invalid Cargo legal declarations');
      const legal = await collectLocalPackageLegalTexts(directory, pkg.license_file === null ? [] : [pkg.license_file]);
      row.licenseFiles = legal.files;
      for (const value of legal.texts) if (!texts.has(value.sha256)) {
        total += value.bytes; if (total > RUST_LICENSE_INVENTORY_LIMITS.textTotalBytes) throw new Error('License inventory total byte bound exceeded');
        texts.set(value.sha256, value);
      }
      row.coverage = legal.files.length ? 'local-texts' : 'no-local-text'; if (!legal.files.length) packagesWithoutText++;
    }
    packages.push(row);
  }
  if (sha(await readLocalLicenseBytes(join(root, lockPath), RUST_LICENSE_INVENTORY_LIMITS.lockBytes)) !== sha(lockedBytes)) throw new Error('Cargo lock changed during collection');
  packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version) || a.source.localeCompare(b.source));
  return { schemaVersion: 1, generatedFrom: lockPath, lockSha256: sha(lockedBytes), metadataSha256: sha(metadataBytes), packages,
    licenseTexts: [...texts.values()].sort((a, b) => a.sha256.localeCompare(b.sha256)),
    coverage: { complete: missingPackages === 0 && packagesWithoutText === 0, lockedPackages: packages.length, missingPackages, packagesWithoutText, distinctTexts: texts.size, textBytes: total,
      scope: 'Exact ordinary local crate legal files from locked offline Cargo metadata; missing texts, other sources/assets/models and redistribution review remain separate.' } };
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('Usage: node tools/generate-rust-license-inventory.mjs');
  const root = resolve(import.meta.dirname, '..');
  const metadataBytes = execFileSync('cargo', ['metadata', '--format-version', '1', '--locked', '--offline', '--manifest-path', join(root, 'apps/desktop-hub/src-tauri/Cargo.toml')],
    { env: { ...process.env, CARGO_NET_OFFLINE: 'true' }, maxBuffer: RUST_LICENSE_INVENTORY_LIMITS.metadataBytes, timeout: RUST_LICENSE_INVENTORY_LIMITS.cargoDeadlineMs });
  const inventory = await collectRustLicenseInventory({ root, metadataBytes });
  const target = join(root, 'THIRD_PARTY_RUST_LICENSES.json'), temporary = join(dirname(target), '.101-rust-license-inventory-' + randomUUID() + '.json');
  try { await writeFile(temporary, JSON.stringify(inventory, null, 2) + '\n', { flag: 'wx', mode: 0o644 }); await rename(temporary, target); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  console.log(JSON.stringify({ lockedPackages: inventory.packages.length, coverage: inventory.coverage }));
}
