#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argumentsList = process.argv.slice(2), child = argumentsList.includes('--child');
const workspace = argumentsList.includes('--workspace-exports');
const value = name => { const index = argumentsList.indexOf(name); return index < 0 ? undefined : argumentsList[index + 1]; };
const sdkRoot = value('--sdk-root');
let hooks;
let resolutionDirectory;
try {
if (workspace || sdkRoot) {
  let publicEntries;
  if (sdkRoot) {
    resolutionDirectory = mkdtempSync(join(resolve(sdkRoot), '.101-public-import-'));
    const resolver = join(resolutionDirectory, 'resolve.mjs');
    const names = ['@101/device-model', '@101/device-runtime', '@101/connect'];
    writeFileSync(resolver, 'export default {' + names.map(name => JSON.stringify(name) + ': import.meta.resolve(' + JSON.stringify(name) + ')').join(',') + '};\n');
    publicEntries = (await import(pathToFileURL(resolver).href)).default;
  }
  hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === '@101/device-model' || specifier === '@101/device-runtime' || specifier === '@101/connect') {
      const entry = publicEntries ? publicEntries[specifier] :
        new URL(`../packages/${specifier.slice(5)}/src/index.ts`, import.meta.url).href;
      return nextResolve(entry, context);
    }
    return nextResolve(specifier, context);
  } });
}
  if (argumentsList.includes('--cas-child')) {
    const { createExtensionFilesystemStorage } = await import('../examples/extension-installation/filesystem-storage.mjs');
    const storage = createExtensionFilesystemStorage(join(value('--fixture-dir'), 'cas-store'));
    try { console.log(JSON.stringify({ committed: await storage.compareAndSwap('101:processor-installation:cas-owner', undefined,
      JSON.stringify({ ownerId: 'cas-owner', contender: value('--contender') }), { signal: new AbortController().signal, isCurrent: () => true }) })); }
    finally { storage.close(); }
  } else if (child) {
    const { runExtensionInstallationExample } = await import('../examples/extension-installation/consumer.mjs');
    console.log(JSON.stringify(await runExtensionInstallationExample(value('--fixture-dir'), value('--phase'))));
  } else {
    const { createAssetReference, processorExtensionManifestSha256, processorExtensionSigningBytes } = await import('@101/device-model');
    const directory = realpathSync(mkdtempSync(join(tmpdir(), '101-reviewed-extension-')));
    try {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const base = JSON.parse(readFileSync(new URL('../examples/external-processor/manifest.json', import.meta.url), 'utf8'));
      const releases = [];
      for (const [index, path] of ['../examples/external-processor/processor.mjs', '../examples/extension-installation/temperature-band-v2.mjs'].entries()) {
        const source = new Uint8Array(readFileSync(new URL(path, import.meta.url)));
        const reference = await createAssetReference('example:reviewed-source', 'blob', source);
        if (index === 0) assert.equal(reference.sha256, base.codeSha256, 'immutable external v1 producer pin');
        const manifest = { ...base, version: index === 0 ? '1.0.0' : '2.0.0', codeSha256: reference.sha256 };
        const unsigned = { schemaVersion: 1, profile: 'reviewed-processor-extension/1', publisherId: 'example:local-publisher',
          packageId: manifest.id, version: manifest.version, sequence: index + 1, abi: '101:processor/1', runtimeVersion: '0.1.0',
          manifest, manifestSha256: await processorExtensionManifestSha256(manifest), source: reference, privileges: ['compute-local'], dependencies: [] };
        releases.push({ ...unsigned, signature: Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' },
          pair.privateKey, processorExtensionSigningBytes(unsigned))).toString('hex') });
      }
      writeFileSync(join(directory, 'provision.json'), JSON.stringify({ publisherKey: await crypto.subtle.exportKey('jwk', pair.publicKey), releases }), { mode: 0o600 });
      const phases = [];
      for (const phase of ['install', 'activate-and-close', 'reload', 'lifecycle']) {
        const args = [fileURLToPath(import.meta.url), '--child', '--fixture-dir', directory, '--phase', phase,
          ...(workspace ? ['--workspace-exports'] : []), ...(sdkRoot ? ['--sdk-root', sdkRoot] : [])];
        const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15_000 });
        assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
        phases.push(JSON.parse(result.stdout.trim()));
      }
      const docFiles = readFileSync(join(directory, 'provision.json'), 'utf8');
      assert.equal(docFiles.includes('"d":'), false, 'provision only contains the public key');
      const contenders = await Promise.all(['one', 'two'].map(contender => new Promise((resolveResult, reject) => {
        const processChild = spawn(process.execPath, [fileURLToPath(import.meta.url), '--cas-child', '--fixture-dir', directory, '--contender', contender],
          { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        const timer = setTimeout(() => { processChild.kill(); reject(new Error('disposable-CAS-timeout')); }, 10_000);
        processChild.stdout.on('data', chunk => { stdout += chunk; }); processChild.stderr.on('data', chunk => { stderr += chunk; });
        processChild.once('error', error => { clearTimeout(timer); reject(error); });
        processChild.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error(stderr)); else resolveResult(JSON.parse(stdout.trim())); });
      })));
      assert.equal(contenders.filter(result => result.committed).length, 1, 'exactly one separate process may atomically claim an absent owner document');
      rmSync(directory, { recursive: true, force: true });
      console.log(JSON.stringify({ result: 'pass', profile: 'reviewed-processor-extension/1', node: process.version,
        publicResolution: sdkRoot ? 'installed-packed-sdk' : workspace ? 'owned-worktree-public-barrels' : 'normal-package',
        cleanProcesses: phases.length, separateProcessAtomicCas: true, phases, implementationSha256: createHash('sha256')
          .update(readFileSync(new URL('../packages/device-runtime/src/processor-installation.ts', import.meta.url))).digest('hex'),
        disposableStorageRemoved: true }, null, 2));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
} finally { hooks?.deregister(); if (resolutionDirectory) rmSync(resolutionDirectory, { recursive: true, force: true }); }
