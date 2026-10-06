import { constants } from 'node:fs';
import { lstat, open, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LICENSE_INVENTORY_LIMITS = Object.freeze({ packages: 2048, lockBytes: 2097152,
  packageJsonBytes: 65536, textBytes: 131072, filesPerPackage: 64, textTotalBytes: 16777216, directoryDepth: 2 });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const rootText = /^(?:LICEN[CS]E|COPYING|COPYRIGHT|NOTICE)(?:[._-].*)?$/i;
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

/** Collect local locked-package legal bytes; declarations and text presence are not legal approval. Import is inert. */
export async function collectLicenseInventory({ root = resolve(import.meta.dirname, '..') } = {}) {
  root = resolve(root); ordinary(await lstat(root), true);
  const lockBytes = await bytes(join(root, 'package-lock.json'), LICENSE_INVENTORY_LIMITS.lockBytes);
  const lock = JSON.parse(utf8(lockBytes));
  if (!lock.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages)) throw new Error('Invalid locked package inventory');
  const entries = Object.entries(lock.packages).filter(([path, pkg]) => path.includes('node_modules/') && pkg?.version);
  if (entries.length > LICENSE_INVENTORY_LIMITS.packages) throw new Error('License inventory package bound exceeded');
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
      for (const file of await legalFiles(directory)) {
        const value = await bytes(file, LICENSE_INVENTORY_LIMITS.textBytes);
        if (!value.length) throw new Error('Empty local license text: ' + path);
        const text = utf8(value), hash = sha256(value);
        if (!texts.has(hash)) {
          total += value.length; if (total > LICENSE_INVENTORY_LIMITS.textTotalBytes) throw new Error('License inventory total byte bound exceeded');
          texts.set(hash, { sha256: hash, bytes: value.length, text });
        }
        row.licenseFiles.push({ path: relative(directory, file).split(sep).join('/'), sha256: hash });
      }
      row.coverage = row.licenseFiles.length ? 'local-texts' : 'no-local-text'; if (!row.licenseFiles.length) packagesWithoutText++;
    }
    packages.push(row);
  }
  packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version) || a.installedPath.localeCompare(b.installedPath));
  return { schemaVersion: 1, generatedFrom: 'package-lock.json', lockSha256: sha256(lockBytes), packages,
    licenseTexts: [...texts.values()].sort((a, b) => a.sha256.localeCompare(b.sha256)),
    coverage: { complete: missingPackages === 0 && packagesWithoutText === 0, lockedPackages: packages.length,
      missingPackages, packagesWithoutText, distinctTexts: texts.size, textBytes: total,
      scope: 'Exact ordinary local package legal files and locked declarations; missing optional targets, native/model terms and legal review remain separate.' } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('Usage: node tools/generate-license-inventory.mjs');
  const root = resolve(import.meta.dirname, '..'), inventory = await collectLicenseInventory({ root });
  const target = join(root, 'THIRD_PARTY_LICENSES.json'), temporary = join(dirname(target), '.101-license-inventory-' + randomUUID() + '.json');
  try { await writeFile(temporary, JSON.stringify(inventory, null, 2) + '\n', { flag: 'wx', mode: 0o644 }); await rename(temporary, target); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  console.log(JSON.stringify({ lockedPackages: inventory.packages.length, coverage: inventory.coverage }));
}
