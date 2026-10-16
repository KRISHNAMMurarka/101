import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LICENSE_INVENTORY_LIMITS = Object.freeze({ packages: 2048, lockBytes: 2097152,
  packageJsonBytes: 65536, declaredSourceBytes: 131072, textBytes: 131072, filesPerPackage: 64, textTotalBytes: 16777216, directoryDepth: 2 });
export const DECLARED_LICENSE_SOURCES_PATH = 'THIRD_PARTY_LICENSE_SOURCES.json';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const rootText = /^(?:UNLICENSE|LICEN[CS]E|COPYING|COPYRIGHT|NOTICE)(?:[._-].*)?$/i;
const legalDirectory = /^(?:licen[cs]es?|notices?|legal)$/i;
function ordinary(value, directory = false) {
  if (value.isSymbolicLink() || !(directory ? value.isDirectory() : value.isFile())) throw new Error('License inventory requires ordinary local files and directories');
}
async function bytes(path, bound) {
  const before = await lstat(path); ordinary(before);
  if (before.size < 0 || before.size > bound) throw new Error('License inventory byte bound exceeded');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const initial = await file.stat(); ordinary(initial);
    if (initial.dev !== before.dev || initial.ino !== before.ino || initial.size !== before.size) throw new Error('License source changed');
    const buffer = Buffer.alloc(bound + 1); let offset = 0, calls = 0;
    while (offset <= bound) {
      if (++calls > 64) throw new Error('License inventory read bound exceeded');
      const result = await file.read(buffer, offset, buffer.length - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead;
    }
    if (offset > bound) throw new Error('License inventory byte bound exceeded');
    const after = await file.stat();
    if (after.size !== initial.size || offset !== initial.size || after.mtimeMs !== initial.mtimeMs || after.ctimeMs !== initial.ctimeMs) throw new Error('License source changed');
    return buffer.subarray(0, offset);
  } finally { await file.close(); }
}
function utf8(value) {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value); }
  catch { throw new Error('License inventory requires exact UTF-8 text'); }
}
async function packageDirectory(root, path) {
  let current = root;
  for (const segment of path.split('/')) {
    current = join(current, segment);
    let state; try { state = await lstat(current); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    ordinary(state, true);
  }
  return current;
}
async function legalFiles(directory) {
  const paths = [];
  async function visit(current, depth, selected = false) {
    const names = await readdir(current);
    if (names.length > 4096) throw new Error('License inventory directory bound exceeded');
    for (const name of names.sort()) {
      const path = join(current, name), state = await lstat(path);
      if (selected) {
        if (state.isDirectory()) { if (depth >= LICENSE_INVENTORY_LIMITS.directoryDepth) throw new Error('License inventory depth bound exceeded'); ordinary(state, true); await visit(path, depth + 1, true); }
        else { ordinary(state); paths.push(path); }
      } else if (legalDirectory.test(name) && !state.isFile()) { ordinary(state, true); await visit(path, 0, true); }
      else if (rootText.test(name)) { ordinary(state); paths.push(path); }
      if (paths.length > LICENSE_INVENTORY_LIMITS.filesPerPackage) throw new Error('License inventory file bound exceeded');
    }
  }
  await visit(directory, 0); return paths.sort();
}

/** Shared bounded collector for ordinary package legal files. No filesystem writes. */
export async function collectLocalPackageLegalTexts(directory, declaredFiles = []) {
  ordinary(await lstat(directory), true);
  if (!Array.isArray(declaredFiles) || declaredFiles.length > LICENSE_INVENTORY_LIMITS.filesPerPackage) throw new Error('License inventory file bound exceeded');
  const selected = new Set(await legalFiles(directory));
  for (const path of declaredFiles) {
    if (typeof path !== 'string' || path.length > 1024 || path.startsWith('/') || path.includes('\\') || path.split('/').some(value => !value || value === '.' || value === '..')) throw new Error('Invalid declared license path');
    const parts = path.split('/');
    if (parts.length > LICENSE_INVENTORY_LIMITS.directoryDepth + 2) throw new Error('License inventory depth bound exceeded');
    if (parts.length > 1 && !await packageDirectory(directory, parts.slice(0, -1).join('/'))) throw new Error('Missing declared license path');
    selected.add(join(directory, path));
  }
  if (selected.size > LICENSE_INVENTORY_LIMITS.filesPerPackage) throw new Error('License inventory file bound exceeded');
  const files = [], texts = new Map();
  for (const file of [...selected].sort()) {
    const value = await bytes(file, LICENSE_INVENTORY_LIMITS.textBytes);
    if (!value.length) throw new Error('Empty local license text');
    const text = utf8(value), hash = sha256(value);
    texts.set(hash, { sha256: hash, bytes: value.length, text });
    files.push({ path: relative(directory, file).split(sep).join('/'), sha256: hash });
  }
  return { files, texts: [...texts.values()] };
}

export async function readLocalLicenseBytes(path, bound) { return bytes(path, bound); }


// Versioned repository author sources are a separate origin. Package-relative
// selection never gains a path escape, and collection performs no network I/O.
const licenseObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const licenseHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const licensePath = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !value.startsWith('/')
  && !/[\\:\0]/.test(value) && !value.split('/').some(part => !part || part === '.' || part === '..');
function closedLicenseObject(value, keys) {
  return licenseObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function authorPrefix(row) {
  if (!/^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(row.name) || !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/.test(row.version))
    throw new Error('Invalid repository author package path');
  return `third_party/licenses/npm/${row.name}/${row.version}`;
}
function authorReference(row, file) {
  const prefix = authorPrefix(row);
  if (!closedLicenseObject(file, ['origin', 'path', 'sha256', 'provenance']) || file.origin !== 'repository-author-source'
    || file.path !== prefix + '/LICENSE' || !licenseHash(file.sha256)
    || !closedLicenseObject(file.provenance, ['path', 'sha256']) || file.provenance.path !== prefix + '/provenance.json'
    || !licenseHash(file.provenance.sha256)) throw new Error('Invalid repository author source reference');
}
async function ordinaryRelativeBytes(root, path, bound) {
  if (!licensePath(path)) throw new Error('Invalid repository author source path');
  const parts = path.split('/');
  if (parts.length > 1 && !await packageDirectory(root, parts.slice(0, -1).join('/'))) throw new Error('Missing repository author source directory');
  return bytes(join(root, path), bound);
}
/** Reviewed manifest/proof provenance is data, not authenticated publisher proof. */
async function reviewedRepositoryAuthorSource(root, row, file, locked) {
  authorReference(row, file);
  const raw = await ordinaryRelativeBytes(root, file.provenance.path, LICENSE_INVENTORY_LIMITS.textBytes);
  if (sha256(raw) !== file.provenance.sha256) throw new Error('Repository author provenance hash mismatch');
  const proof = JSON.parse(utf8(raw));
  if (!closedLicenseObject(proof, ['schemaVersion', 'name', 'version', 'installedPath', 'source', 'lockedArtifact', 'publishedFiles'])
    || proof.schemaVersion !== 1 || proof.name !== row.name || proof.version !== row.version || proof.installedPath !== row.installedPath)
    throw new Error('Repository author provenance package identity mismatch');
  if (!closedLicenseObject(proof.source, ['repository', 'commit', 'path', 'gitBlobSha1'])
    || typeof proof.source.repository !== 'string' || !/^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(proof.source.repository)
    || !/^[a-f0-9]{40}$/.test(proof.source.commit) || !licensePath(proof.source.path) || !/^[a-f0-9]{40}$/.test(proof.source.gitBlobSha1))
    throw new Error('Invalid repository author source commit or blob');
  if (!closedLicenseObject(proof.lockedArtifact, ['resolved', 'integrity'])
    || proof.lockedArtifact.resolved !== locked.resolved || proof.lockedArtifact.integrity !== locked.integrity
    || typeof locked.resolved !== 'string' || !locked.resolved.startsWith('https://registry.npmjs.org/')
    || typeof locked.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(locked.integrity))
    throw new Error('Repository author source does not match locked artifact');
  if (!Array.isArray(proof.publishedFiles) || !proof.publishedFiles.length || proof.publishedFiles.length > LICENSE_INVENTORY_LIMITS.filesPerPackage)
    throw new Error('Invalid bounded repository author published files');
  const seen = new Set();
  for (const published of proof.publishedFiles) {
    if (!closedLicenseObject(published, ['path', 'sha256']) || !licensePath(published.path) || !licenseHash(published.sha256) || seen.has(published.path))
      throw new Error('Invalid repository author published file');
    seen.add(published.path);
  }
  if (!seen.has('package.json')) throw new Error('Repository author published package manifest missing');
  const body = await ordinaryRelativeBytes(root, file.path, LICENSE_INVENTORY_LIMITS.textBytes);
  if (!body.length || sha256(body) !== file.sha256 || createHash('sha1').update(Buffer.from(`blob ${body.length}\0`)).update(body).digest('hex') !== proof.source.gitBlobSha1)
    throw new Error('Repository author body hash or source blob mismatch');
  const text = utf8(body);
  return { file: { ...file, provenance: { ...file.provenance, document: proof } }, text: { sha256: file.sha256, bytes: body.length, text } };
}


export async function installedLicensePackagePresent(root, path) {
  if (!licensePath(path) || !path.includes('node_modules/')) throw new Error('Invalid installed license package path');
  return !!await packageDirectory(root, path);
}
async function verifyAuthorInstalledFiles(root, row, proof) {
  const directory = await packageDirectory(root, row.installedPath);
  if (!directory) throw new Error('Repository author source requires installed package');
  const installed = JSON.parse(utf8(await bytes(join(directory, 'package.json'), LICENSE_INVENTORY_LIMITS.packageJsonBytes)));
  if (installed.name !== row.name || installed.version !== row.version) throw new Error('Repository author installed identity mismatch');
  for (const published of proof.publishedFiles) {
    if (sha256(await ordinaryRelativeBytes(directory, published.path, LICENSE_INVENTORY_LIMITS.textBytes)) !== published.sha256)
      throw new Error('Repository author installed published file hash mismatch');
  }
}
/** Public installed-package witness remains strict even when author text is local. */
export async function readRepositoryAuthorLicenseSource(root, row, file, locked) {
  const reviewed = await reviewedRepositoryAuthorSource(root, row, file, locked);
  await verifyAuthorInstalledFiles(root, row, reviewed.file.provenance.document);
  return reviewed;
}

/** Exact additional files needed by a copied artifact and its source fingerprint. */
export async function collectDeclaredLicenseRepositoryFiles(root) {
  const lock = JSON.parse(utf8(await bytes(join(root, 'package-lock.json'), LICENSE_INVENTORY_LIMITS.lockBytes)));
  if (!licenseObject(lock.packages)) throw new Error('Invalid locked package inventory');
  const locked = new Map(Object.entries(lock.packages).filter(([path, pkg]) => path.includes('node_modules/') && pkg?.version));
  const declared = await readDeclaredLicenseSources({ root, lockedPackages: locked });
  const files = new Map();
  if (declared.manifest) files.set(DECLARED_LICENSE_SOURCES_PATH, declared.manifest);
  for (const row of declared.packages.values()) {
    for (const file of row.licenseFiles) if (file.origin === 'repository-author-source') {
      // The copied manifest must never refer to omitted reviewed bytes merely
      // because an optional distribution target is absent on this machine.
      const reviewed = await reviewedRepositoryAuthorSource(root, row, file, locked.get(row.installedPath));
      if (await installedLicensePackagePresent(root, row.installedPath)) await verifyAuthorInstalledFiles(root, row, reviewed.file.provenance.document);
      files.set(file.path, { path: file.path, sha256: file.sha256 });
      files.set(file.provenance.path, file.provenance);
    }
  }
  return [...files.values()];
}
export async function verifyCopiedLicenseRepositoryFiles(root, files) {
  if (!Array.isArray(files) || files.length > LICENSE_INVENTORY_LIMITS.packages * 3 + 1) throw new Error('Copied author source file bound exceeded');
  const seen = new Set();
  for (const file of files) {
    if (!licenseObject(file) || !licensePath(file.path) || !licenseHash(file.sha256) || seen.has(file.path)
      || file.path !== DECLARED_LICENSE_SOURCES_PATH && !file.path.startsWith('third_party/licenses/npm/')) throw new Error('Invalid copied author source path');
    seen.add(file.path);
    if (sha256(await ordinaryRelativeBytes(root, file.path, LICENSE_INVENTORY_LIMITS.textBytes)) !== file.sha256)
      throw new Error('Copied repository author source hash mismatch');
  }
}

/** Explicit reviewed source selection; filenames or SPDX declarations alone are not legal approval. */
export async function readDeclaredLicenseSources({ root, lockedPackages }) {
  let raw;
  try { raw = await bytes(join(root, DECLARED_LICENSE_SOURCES_PATH), LICENSE_INVENTORY_LIMITS.declaredSourceBytes); }
  catch (error) { if (error.code === 'ENOENT') return { manifest: null, packages: new Map() }; throw error; }
  const source = JSON.parse(utf8(raw)), packages = new Map();
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const text = (value, bound) => typeof value === 'string' && value.length > 0 && value.length <= bound;
  const localPath = value => text(value, 1024) && !value.startsWith('/') && !/[\\:]/.test(value) && !value.includes('\0')
    && !value.split('/').some(part => !part || part === '.' || part === '..');
  if (!object(source) || ![1, 2].includes(source.schemaVersion) || !Array.isArray(source.packages) || source.packages.length > LICENSE_INVENTORY_LIMITS.packages)
    throw new Error('Invalid bounded declared license sources');
  for (const row of source.packages) {
    if (!object(row) || !localPath(row.installedPath) || !text(row.name, 1024) || !text(row.version, 128))
      throw new Error('Invalid declared license source identity');
    const locked = lockedPackages.get(row.installedPath);
    if (!locked || row.name !== (locked.name ?? row.installedPath.split('node_modules/').at(-1)) || row.version !== locked.version)
      throw new Error('Declared license source identity does not match lockfile');
    if (packages.has(row.installedPath)) throw new Error('Duplicate declared license source identity');
    if (!Array.isArray(row.licenseFiles) || !row.licenseFiles.length || row.licenseFiles.length > LICENSE_INVENTORY_LIMITS.filesPerPackage)
      throw new Error('Invalid bounded declared license source files');
    const paths = new Set(); let authors = 0;
    for (const file of row.licenseFiles) {
      if (file?.origin !== undefined) {
        if (source.schemaVersion !== 2 || ++authors > 1) throw new Error('Invalid versioned repository author source');
        authorReference(row, file);
      }
      if (!object(file) || !localPath(file.path)) throw new Error('Invalid declared license source path');
      if (paths.has(file.path) || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256))
        throw new Error('Duplicate path or invalid declared license source hash');
      paths.add(file.path);
    }
    packages.set(row.installedPath, row);
  }
  return { manifest: { path: DECLARED_LICENSE_SOURCES_PATH, sha256: sha256(raw) }, packages };
}

/** Collect local locked-package legal bytes; declarations and text presence are not legal approval. Import is inert. */
export async function collectLicenseInventory({ root = resolve(import.meta.dirname, '..') } = {}) {
  root = resolve(root); ordinary(await lstat(root), true);
  const lockBytes = await bytes(join(root, 'package-lock.json'), LICENSE_INVENTORY_LIMITS.lockBytes);
  const lock = JSON.parse(utf8(lockBytes));
  if (!lock.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages)) throw new Error('Invalid locked package inventory');
  const entries = Object.entries(lock.packages).filter(([path, pkg]) => path.includes('node_modules/') && pkg?.version);
  if (entries.length > LICENSE_INVENTORY_LIMITS.packages) throw new Error('License inventory package bound exceeded');
  const lockedPackages = new Map(entries), declared = await readDeclaredLicenseSources({ root, lockedPackages });
  const packages = [], texts = new Map(); let total = 0, missingPackages = 0, packagesWithoutText = 0;
  for (const [path, pkg] of entries) {
    if (path.length > 1024 || path.startsWith('/') || path.includes('\\') || path.split('/').some(value => !value || value === '.' || value === '..')) throw new Error('Invalid locked package path');
    const name = pkg.name ?? path.split('node_modules/').at(-1);
    if (typeof name !== 'string' || typeof pkg.version !== 'string') throw new Error('Invalid locked package identity');
    const row = { name, version: pkg.version, license: pkg.license ?? 'UNKNOWN', installedPath: path, coverage: 'not-installed', licenseFiles: [] };
    const directory = await packageDirectory(root, path);
    if (!directory) missingPackages++;
    else {
      const installed = JSON.parse(utf8(await bytes(join(directory, 'package.json'), LICENSE_INVENTORY_LIMITS.packageJsonBytes)));
      if (installed.name !== name || installed.version !== pkg.version) throw new Error('Installed package identity does not match lockfile: ' + path);
      const selected = declared.packages.get(path)?.licenseFiles ?? [];
      const local = selected.filter(file => file.origin === undefined), authors = selected.filter(file => file.origin === 'repository-author-source');
      const legal = await collectLocalPackageLegalTexts(directory, local.map(file => file.path));
      for (const file of local) if (legal.files.find(value => value.path === file.path)?.sha256 !== file.sha256)
        throw new Error('Declared license source bytes do not match pinned hash');
      for (const file of authors) {
        const author = await readRepositoryAuthorLicenseSource(root, { name, version: pkg.version, installedPath: path }, file, pkg);
        legal.files.push(author.file); legal.texts.push(author.text);
      }
      for (const value of legal.texts) if (!texts.has(value.sha256)) {
        total += value.bytes; if (total > LICENSE_INVENTORY_LIMITS.textTotalBytes) throw new Error('License inventory total byte bound exceeded');
        texts.set(value.sha256, value);
      }
      row.licenseFiles = legal.files;
      row.coverage = authors.length ? 'repository-author-texts' : row.licenseFiles.length ? 'local-texts' : 'no-local-text'; if (!row.licenseFiles.length) packagesWithoutText++;
    }
    packages.push(row);
  }
  const after = await readDeclaredLicenseSources({ root, lockedPackages });
  if (after.manifest?.sha256 !== declared.manifest?.sha256) throw new Error('Declared license source manifest changed during collection');
  packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version) || a.installedPath.localeCompare(b.installedPath));
  return { schemaVersion: 1, generatedFrom: 'package-lock.json', lockSha256: sha256(lockBytes), declaredSources: declared.manifest, packages,
    licenseTexts: [...texts.values()].sort((a, b) => a.sha256.localeCompare(b.sha256)),
    coverage: { complete: missingPackages === 0 && packagesWithoutText === 0, lockedPackages: packages.length,
      missingPackages, packagesWithoutText, distinctTexts: texts.size, textBytes: total,
      scope: packages.some(row => row.coverage === 'repository-author-texts')
        ? 'Exact ordinary installed legal files and explicitly reviewed version-bound repository author texts, with distinct origin; missing optional targets, native/model terms and legal review remain separate.'
        : 'Exact ordinary local package legal files and locked declarations; missing optional targets, native/model terms and legal review remain separate.' } };
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('Usage: node tools/generate-license-inventory.mjs');
  const root = resolve(import.meta.dirname, '..'), inventory = await collectLicenseInventory({ root });
  const target = join(root, 'THIRD_PARTY_LICENSES.json'), temporary = join(dirname(target), '.101-license-inventory-' + randomUUID() + '.json');
  try { await writeFile(temporary, JSON.stringify(inventory, null, 2) + '\n', { flag: 'wx', mode: 0o644 }); await rename(temporary, target); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  console.log(JSON.stringify({ lockedPackages: inventory.packages.length, coverage: inventory.coverage }));
}
