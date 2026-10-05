import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readSync,
  realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Reviewed local host port: private directory, atomic owner document and cooperating-process CAS. */
export function createCatalogFilesystemStorage(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (realpathSync(directory) !== resolve(directory) || !lstatSync(directory).isDirectory() || (lstatSync(directory).mode & 0o077) !== 0)
    throw new TypeError('catalog-storage-directory');
  let closed = false;
  const path = key => {
    if (closed || typeof key !== 'string' || !/^101:package-catalog:[A-Za-z0-9._:%-]{1,384}$/.test(key)) throw new TypeError('catalog-storage-key');
    return join(directory, createHash('sha256').update(key).digest('hex') + '.json');
  };
  const read = key => {
    const file = path(key);
    if (!existsSync(file)) return undefined;
    const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024 || (stat.mode & 0o077) !== 0) throw new TypeError('catalog-storage-document');
      // The descriptor binds the inode. Read one bounded extra byte to reject concurrent growth.
      const bytes = Buffer.alloc(stat.size + 1); let length = 0;
      while (length < bytes.byteLength) {
        const count = readSync(descriptor, bytes, length, bytes.byteLength - length, null);
        if (count === 0) break; length += count;
      }
      if (length !== stat.size) throw new TypeError('catalog-storage-size');
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
    } finally { closeSync(descriptor); }
  };
  return Object.freeze({
    async read(key) { return read(key); },
    isCurrent(key, expected) { try { return read(key) === expected; } catch { return false; } },
    async compareAndSwap(key, expected, value, guard) {
      const file = path(key), lock = file + '.lock', temporary = file + '.' + randomUUID() + '.pending';
      if (typeof value !== 'string' || value.length > 4 * 1024 * 1024 || Buffer.byteLength(value) > 4 * 1024 * 1024)
        throw new TypeError('catalog-storage-size');
      try { mkdirSync(lock, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') return false; throw error; }
      let descriptor;
      const current = () => !closed && !guard.signal.aborted && guard.isCurrent() === true && !guard.signal.aborted && !closed;
      try {
        if (read(key) !== expected || !current()) return false;
        descriptor = openSync(temporary, 'wx', 0o600); writeFileSync(descriptor, value, 'utf8'); fsyncSync(descriptor);
        closeSync(descriptor); descriptor = undefined;
        if (read(key) !== expected || !current()) return false;
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
