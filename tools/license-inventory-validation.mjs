import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { LICENSE_INVENTORY_LIMITS as limits, readLocalLicenseBytes, readDeclaredLicenseSources, readRepositoryAuthorLicenseSource, collectDeclaredLicenseRepositoryFiles, installedLicensePackagePresent } from './generate-license-inventory.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value, bound = 1024) => typeof value === 'string' && value.length > 0 && value.length <= bound;
const localPath = value => string(value) && !value.startsWith('/') && !value.includes('\\')
  && !value.split('/').some(part => !part || part === '.' || part === '..');
const registry = 'registry+https://github.com/rust-lang/crates.io-index';
const rustLock = 'apps/desktop-hub/src-tauri/Cargo.lock';
const utf8 = value => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value);
// Packaging deliberately bounds serialized metadata as well as embedded text.
const inventoryBytes = 32 * 1024 * 1024;

function cargoIdentity(text) {
  const value = {};
  for (const line of text.split('\n')) {
    const match = /^(name|version|source)\s*=\s*(".*")\s*$/.exec(line);
    if (!match) continue;
    if (Object.hasOwn(value, match[1])) throw new Error('Duplicate Cargo package identity');
    value[match[1]] = JSON.parse(match[2]);
  }
  if (!string(value.name, 128) || !/^[A-Za-z0-9_-]+$/.test(value.name) || !string(value.version, 128)
    || value.source !== undefined && !string(value.source, 1024)) throw new Error('Invalid Cargo package identity');
  return value;
}

function validateTexts(inventory, allowRepositoryAuthors = false) {
  if (!Array.isArray(inventory.licenseTexts) || inventory.licenseTexts.length > limits.packages * limits.filesPerPackage)
    throw new Error('Invalid bounded embedded license texts');
  const texts = new Set(), referenced = new Set(); let textBytes = 0, missingPackages = 0, packagesWithoutText = 0;
  for (const value of inventory.licenseTexts) {
    if (!object(value) || !hash(value.sha256) || texts.has(value.sha256) || !string(value.text, limits.textBytes)
      || !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > limits.textBytes)
      throw new Error('Invalid embedded license text record');
    const bytes = Buffer.from(value.text, 'utf8');
    if (bytes.toString('utf8') !== value.text || bytes.length !== value.bytes || digest(bytes) !== value.sha256)
      throw new Error('Embedded license text bytes or hash do not match');
    textBytes += bytes.length;
    if (textBytes > limits.textTotalBytes) throw new Error('Embedded license text total byte bound exceeded');
    texts.add(value.sha256);
  }
  for (const pkg of inventory.packages) {
    if (!Array.isArray(pkg.licenseFiles) || pkg.licenseFiles.length > limits.filesPerPackage)
      throw new Error('Invalid bounded package license files');
    const paths = new Set();
    for (const file of pkg.licenseFiles) {
      if (!object(file) || !localPath(file.path) || paths.has(file.path) || !hash(file.sha256) || !texts.has(file.sha256))
        throw new Error('Invalid or unresolved package license text reference');
      paths.add(file.path); referenced.add(file.sha256);
    }
    if (pkg.coverage === 'local-texts' || allowRepositoryAuthors && pkg.coverage === 'repository-author-texts') {
      if (!pkg.licenseFiles.length) throw new Error('Package coverage does not match license text references');
    } else if (pkg.coverage === 'not-installed' || pkg.coverage === 'no-local-text') {
      if (pkg.licenseFiles.length) throw new Error('Package coverage does not match license text references');
      if (pkg.coverage === 'not-installed') missingPackages++; else packagesWithoutText++;
    } else throw new Error('Invalid package license coverage');
  }
  if (referenced.size !== texts.size) throw new Error('Embedded license text is not referenced by a locked package');
  const coverage = inventory.coverage;
  if (!object(coverage) || coverage.complete !== (missingPackages === 0 && packagesWithoutText === 0)
    || coverage.lockedPackages !== inventory.packages.length || coverage.missingPackages !== missingPackages
    || coverage.packagesWithoutText !== packagesWithoutText || coverage.distinctTexts !== texts.size
    || coverage.textBytes !== textBytes || !string(coverage.scope, 2048))
    throw new Error('License inventory coverage does not match its records');
}

async function inventoryFor(root, name, generatedFrom) {
  const lockBytes = await readLocalLicenseBytes(join(root, generatedFrom), limits.lockBytes);
  const inventory = JSON.parse(utf8(await readLocalLicenseBytes(join(root, name), inventoryBytes)));
  if (!object(inventory) || inventory.schemaVersion !== 1 || inventory.generatedFrom !== generatedFrom
    || !Array.isArray(inventory.packages) || inventory.packages.length > limits.packages)
    throw new Error('Unsupported or invalid license inventory format');
  if (!hash(inventory.lockSha256) || inventory.lockSha256 !== digest(lockBytes))
    throw new Error('License inventory lock hash does not match ' + generatedFrom);
  for (const pkg of inventory.packages) {
    if (!object(pkg) || !string(pkg.name, 1024) || !string(pkg.version, 128) || !string(pkg.license, 2048))
      throw new Error('Invalid locked license inventory identity');
  }
  return { inventory, lockBytes };
}

async function auditJavaScript(root) {
  const { inventory, lockBytes } = await inventoryFor(root, 'THIRD_PARTY_LICENSES.json', 'package-lock.json');
  const lock = JSON.parse(utf8(lockBytes));
  if (!object(lock.packages)) throw new Error('Invalid locked package inventory');
  const locked = new Map(Object.entries(lock.packages)
    .filter(([path, pkg]) => path.includes('node_modules/') && pkg?.version));
  if (locked.size > limits.packages || locked.size !== inventory.packages.length)
    throw new Error('License inventory does not match package-lock.json');
  const declared = await readDeclaredLicenseSources({ root, lockedPackages: locked });
  if (declared.manifest ? !object(inventory.declaredSources)
    || inventory.declaredSources.path !== declared.manifest.path || inventory.declaredSources.sha256 !== declared.manifest.sha256
    : inventory.declaredSources !== undefined && inventory.declaredSources !== null)
    throw new Error('License inventory declared source provenance does not match');
  await collectDeclaredLicenseRepositoryFiles(root);
  for (const pkg of inventory.packages) {
    const expected = locked.get(pkg.installedPath);
    if (!localPath(pkg.installedPath) || !expected || pkg.name !== (expected.name ?? pkg.installedPath.split('node_modules/').at(-1))
      || pkg.version !== expected.version || pkg.license !== (expected.license ?? 'UNKNOWN'))
      throw new Error('License inventory does not match package-lock.json');
    const selected = declared.packages.get(pkg.installedPath)?.licenseFiles ?? [];
    if (pkg.coverage === 'not-installed' && selected.some(file => file.origin === 'repository-author-source') && await installedLicensePackagePresent(root, pkg.installedPath))
      throw new Error('Repository author inventory misstates an installed package as missing');
    if (pkg.coverage !== 'not-installed') for (const required of selected) {
      const expectedFile = required.origin === 'repository-author-source'
        ? (await readRepositoryAuthorLicenseSource(root, pkg, required, expected)).file : required;
      if (!pkg.licenseFiles?.some(file => file.path === required.path && file.sha256 === required.sha256
        && (required.origin === undefined ? file.origin === undefined && file.provenance === undefined : JSON.stringify(file) === JSON.stringify(expectedFile))))
        throw new Error('License inventory omits or changes a declared legal source origin/provenance');
    }
    const authors = (pkg.licenseFiles ?? []).filter(file => file.origin !== undefined || file.provenance !== undefined);
    if (authors.some(file => file.origin !== 'repository-author-source' || !selected.some(required => required.origin === file.origin && required.path === file.path))
      || (pkg.coverage === 'repository-author-texts') !== (authors.length > 0)) throw new Error('Invalid declared author source inventory origin');
    locked.delete(pkg.installedPath);
  }
  validateTexts(inventory, true);
}

async function auditRust(root) {
  const { inventory, lockBytes } = await inventoryFor(root, 'THIRD_PARTY_RUST_LICENSES.json', rustLock);
  if (!hash(inventory.metadataSha256)) throw new Error('Invalid Cargo metadata fingerprint');
  const identity = value => JSON.stringify([value.name, value.version, value.source ?? 'workspace']);
  const packages = utf8(lockBytes).split(/^\[\[package\]\]\s*$/m).slice(1).map(cargoIdentity);
  const locked = new Map(packages.map(pkg => [identity(pkg), pkg]));
  if (packages.length > limits.packages || locked.size !== packages.length) throw new Error('Invalid bounded Cargo lock identities');
  const manifest = utf8(await readLocalLicenseBytes(join(root, 'apps/desktop-hub/src-tauri/Cargo.toml'), 131072));
  const packageSection = manifest.split(/^\[package\]\s*$/m)[1]?.split(/^\[/m)[0];
  if (!packageSection) throw new Error('Missing first-party Cargo package identity');
  const firstParty = cargoIdentity(packageSection);
  if (firstParty.source !== undefined || !locked.delete(identity(firstParty)) || [...locked.values()].some(pkg => pkg.source !== registry))
    throw new Error('Unsupported or mismatched Cargo package source');
  if (locked.size !== inventory.packages.length) throw new Error('License inventory does not match Cargo.lock');
  for (const pkg of inventory.packages) {
    if (pkg.source !== registry || !locked.delete(identity(pkg))) throw new Error('License inventory does not match Cargo.lock');
  }
  validateTexts(inventory);
}

/** Read-only admission of copied inventories. Text presence is not redistribution approval. */
export async function auditReleaseLicenseInventories(root) {
  for (const [label, audit] of [['JavaScript', auditJavaScript], ['Rust', auditRust]]) {
    try { await audit(root); }
    catch (error) { throw new Error(`${label} license inventory: ${error.message}; run npm run license:inventory`, { cause: error }); }
  }
}
