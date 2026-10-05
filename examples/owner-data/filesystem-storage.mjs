import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Selected private host directory. One locked owner envelope contains every managed collection and its barrier/audit. */
export function createOwnerDataFilesystemStorage(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (realpathSync(directory) !== resolve(directory) || !lstatSync(directory).isDirectory() || (lstatSync(directory).mode & 0o077) !== 0)
    throw new TypeError('owner-storage-directory');
  let closed = false;
  const path = owner => {
    if (closed || typeof owner !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(owner)) throw new TypeError('owner-storage-scope');
    return join(directory, createHash('sha256').update(owner).digest('hex') + '.json');
  };
  const read = file => {
    if (!existsSync(file)) return undefined;
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024 || (stat.mode & 0o077) !== 0) throw new TypeError('owner-storage-record');
    return JSON.parse(readFileSync(file, 'utf8'));
  };
  return Object.freeze({
    async transact(owner, mutation, guard) {
      const file = path(owner), lock = file + '.lock', temporary = file + '.' + randomUUID() + '.pending';
      if (typeof mutation !== 'function') throw new TypeError('owner-storage-mutation');
      // An orphan lock is preserved and fails closed; the host must review it, never blindly replay or steal it.
      mkdirSync(lock, { mode: 0o700 }); let descriptor;
      const current = () => {
        if (closed || guard?.signal.aborted || guard && guard.isCurrent() !== true || guard?.signal.aborted || closed)
          throw new Error('owner-storage-unavailable');
      };
      try {
        current(); const next = mutation(read(file));
        const state = Object.getOwnPropertyDescriptor(next, 'state'), result = Object.getOwnPropertyDescriptor(next, 'result');
        if (!state?.enumerable || !('value' in state) || !result?.enumerable || !('value' in result) || Reflect.ownKeys(next).length !== 2)
          throw new TypeError('owner-storage-mutation');
        const encoded = JSON.stringify(state.value);
        if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 2 * 1024 * 1024) throw new TypeError('owner-storage-size');
        current(); descriptor = openSync(temporary, 'wx', 0o600); writeFileSync(descriptor, encoded, 'utf8'); fsyncSync(descriptor);
        closeSync(descriptor); descriptor = undefined; current(); renameSync(temporary, file);
        const directoryDescriptor = openSync(directory, 'r');
        try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
        return result.value;
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
        if (existsSync(temporary)) unlinkSync(temporary);
        rmdirSync(lock);
      }
    },
    close() { closed = true; },
  });
}
