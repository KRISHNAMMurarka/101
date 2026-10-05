import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Selected local host profile: private directory, one atomic owner document, no downloaded executables. */
export function createExtensionFilesystemStorage(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (realpathSync(directory) !== resolve(directory) || !lstatSync(directory).isDirectory() ||
    (lstatSync(directory).mode & 0o077) !== 0) throw new TypeError('extension-storage-directory');
  let closed = false;
  const path = key => {
    if (closed || typeof key !== 'string' || !/^101:processor-installation:[A-Za-z0-9._:%-]{1,384}$/.test(key))
      throw new TypeError('extension-storage-key');
    return join(directory, createHash('sha256').update(key).digest('hex') + '.json');
  };
  const read = key => {
    const file = path(key);
    if (!existsSync(file)) return undefined;
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024 || (stat.mode & 0o077) !== 0)
      throw new TypeError('extension-storage-document');
    return readFileSync(file, 'utf8');
  };
  return Object.freeze({
    async read(key) { return read(key); },
    isCurrent(key, expected) { try { return read(key) === expected; } catch { return false; } },
    async compareAndSwap(key, expected, value, guard) {
      const file = path(key), lock = file + '.lock', temporary = file + '.' + randomUUID() + '.pending';
      if (typeof value !== 'string' || Buffer.byteLength(value) > 4 * 1024 * 1024) throw new TypeError('extension-storage-size');
      try { mkdirSync(lock, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') return false; throw error; }
      let descriptor;
      try {
        if (read(key) !== expected || guard.signal.aborted || !guard.isCurrent() || guard.signal.aborted || closed) return false;
        descriptor = openSync(temporary, 'wx', 0o600); writeFileSync(descriptor, value, 'utf8'); fsyncSync(descriptor);
        closeSync(descriptor); descriptor = undefined;
        if (read(key) !== expected || guard.signal.aborted || !guard.isCurrent() || guard.signal.aborted || closed) return false;
        renameSync(temporary, file);
        const directoryDescriptor = openSync(directory, 'r');
        try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
        return true;
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
        if (existsSync(temporary)) unlinkSync(temporary);
        rmdirSync(lock);
      }
    },
    close() { closed = true; },
  });
}
