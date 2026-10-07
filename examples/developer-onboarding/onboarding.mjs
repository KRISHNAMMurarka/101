/** Node-only explicit creator. Imports are inert; resource authority stays in the existing public runtime. */
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, rmdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createDeviceScaffold } from '@101/connect/examples/device-scaffold';
import { ONBOARDING_LIMITS } from './consumer.mjs';
export { ONBOARDING_LIMITS, reviewOnboardingProject, runOnboardingExample } from './consumer.mjs';

const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
let creating = false;
function fail(code) { throw new Error(code); }
function options(input) {
  if (!input || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) fail('onboarding-options');
  const descriptors = Object.getOwnPropertyDescriptors(input), output = {};
  if (Reflect.ownKeys(descriptors).some(key => !['id', 'destination', 'signal'].includes(key))) fail('onboarding-options');
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!Object.hasOwn(descriptor, 'value')) fail('onboarding-options');
    output[key] = descriptor.value;
  }
  if (typeof output.destination !== 'string' || !isAbsolute(output.destination) ||
      output.destination.length > 4096 || output.destination.includes('\0')) fail('onboarding-destination');
  if (output.signal !== undefined) {
    try { aborted.call(output.signal); } catch { fail('onboarding-signal'); }
  }
  return output;
}
function current(signal) { if (signal !== undefined && aborted.call(signal)) fail('onboarding-cancelled'); }
function same(a, b) { return a?.dev === b?.dev && a?.ino === b?.ino; }

/** Exact existing factory, exclusively new destination. No directory replacement or recursive failure cleanup. */
export async function createOnboardingProject(input) {
  if (creating) fail('onboarding-busy');
  creating = true;
  let target, identity; const filesCreated = [], directories = new Map();
  try {
    const chosen = options(input);
    const files = createDeviceScaffold({ id: chosen.id });
    const entries = Object.entries(files), total = entries.reduce((bytes, [, contents]) => bytes + Buffer.byteLength(contents), 0);
    if (entries.length > ONBOARDING_LIMITS.generatedFiles || total > ONBOARDING_LIMITS.generatedSourceBytes) fail('onboarding-source-bytes');
    target = resolve(chosen.destination);
    current(chosen.signal);
    try { await mkdir(target, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') fail('onboarding-destination-exists'); throw error; }
    identity = await lstat(target);
    if (!identity.isDirectory() || identity.isSymbolicLink()) fail('onboarding-destination');
    directories.set(target, identity);
    const hashes = {};
    for (const [path, contents] of entries) {
      if (!path || isAbsolute(path) || path.split('/').some(part => part === '..' || part === '' || part === '.') || path.includes('\\')) fail('onboarding-assets');
      current(chosen.signal);
      if (!same(identity, await lstat(target))) fail('onboarding-destination');
      const full = join(target, path), parent = dirname(full);
      if (parent !== target && !directories.has(parent)) {
        // All current factory files have at most one child directory; do not follow a future arbitrary tree.
        if (relative(target, parent).split('/').length !== 1) fail('onboarding-assets');
        await mkdir(parent, { mode: 0o700 });
        const facts = await lstat(parent);
        if (!facts.isDirectory() || facts.isSymbolicLink()) fail('onboarding-assets');
        directories.set(parent, facts);
      }
      current(chosen.signal);
      const handle = await open(full, 'wx', 0o600);
      try {
        const facts = await handle.stat();
        const item = { path: full, facts, sha256: digest(contents), complete: false };
        filesCreated.push(item);
        current(chosen.signal);
        await handle.writeFile(contents, 'utf8'); item.complete = true;
        hashes[path] = item.sha256;
      } finally { await handle.close(); }
      current(chosen.signal);
    }
    current(chosen.signal);
    return Object.freeze({ id: chosen.id, directory: target, files: Object.freeze(hashes) });
  } catch (error) {
    // Preserve modified/unknown entries. Only empty still-owned directories and exact created files may go.
    if (target && identity) {
      for (const item of [...filesCreated].reverse()) {
        try {
          const facts = await lstat(item.path);
          if (!item.complete || !facts.isFile() || facts.isSymbolicLink() || !same(facts, item.facts) ||
              facts.size > ONBOARDING_LIMITS.generatedSourceBytes) continue;
          const handle = await open(item.path, 'r');
          let bytes;
          try {
            const buffer = Buffer.alloc(facts.size + 1);
            const read = await handle.read(buffer, 0, buffer.length, 0);
            bytes = buffer.subarray(0, read.bytesRead);
          } finally { await handle.close(); }
          if (digest(bytes) === item.sha256) await unlink(item.path);
        } catch { /* Uncertain or changed filesystem ownership is preserved, never recursively erased. */ }
      }
      for (const [path, facts] of [...directories].reverse()) {
        try { if (same(await lstat(path), facts)) await rmdir(path); }
        catch { /* Nonempty/changed directories remain for an explicit caller decision. */ }
      }
    }
    throw error;
  } finally { creating = false; }
}
