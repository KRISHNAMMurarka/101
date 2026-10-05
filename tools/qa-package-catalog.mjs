#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2), value = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const workspace = args.includes('--workspace-exports'), sdkRoot = value('--sdk-root'), sdkManifest = value('--sdk-manifest');
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
let hooks, resolutionDirectory;
try {
  assert.ok(workspace !== Boolean(sdkRoot), 'Choose owned workspace exports or an installed packed SDK');
  const names = ['@101/device-model', '@101/device-runtime', '@101/connect'];
  let entries;
  if (sdkRoot) {
    assert.ok(sdkManifest, 'Packed proof needs the immutable SDK build manifest');
    const consumer = realpathSync(resolve(sdkRoot)), manifest = JSON.parse(readFileSync(resolve(sdkManifest), 'utf8'));
    resolutionDirectory = mkdtempSync(join(consumer, '.101-catalog-public-'));
    const resolver = join(resolutionDirectory, 'resolve.mjs');
    writeFileSync(resolver, 'export default {' + names.map(name => JSON.stringify(name) + ':import.meta.resolve(' + JSON.stringify(name) + ')').join(',') + '};\n');
    entries = (await import(pathToFileURL(resolver).href)).default;
    for (const name of names) {
      const directory = join(consumer, 'node_modules', ...name.split('/'));
      assert.ok(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(), 'Packed packages must be ordinary installed directories');
      assert.ok(realpathSync(fileURLToPath(entries[name])).startsWith(realpathSync(directory) + sep), 'Public import must resolve inside the selected consumer');
      const record = manifest.packages.find(item => item.name === name);
      assert.ok(record, 'Package is absent from the immutable pack');
      for (const path of ['dist/index.js', ...(name === '@101/connect' ? [] : ['dist/package-catalog.js'])]) {
        assert.equal(hash(join(directory, path)), record.files.find(file => file.path === path)?.sha256, 'Installed public producer differs from the pack');
      }
    }
    for (const path of ['packages/device-model/src/package-catalog.ts', 'packages/device-runtime/src/package-catalog.ts'])
      assert.equal(hash(new URL('../' + path, import.meta.url)), manifest.source.sha256[path], 'Catalog source differs from the immutable SDK pack');
  }
  hooks = registerHooks({ resolve(specifier, context, next) {
    return next(names.includes(specifier) ? entries?.[specifier] ?? new URL(`../packages/${specifier.slice(5)}/src/index.ts`, import.meta.url).href : specifier, context);
  } });
  const passthrough = [...(workspace ? ['--workspace-exports'] : []), ...(sdkRoot ? ['--sdk-root', sdkRoot, '--sdk-manifest', sdkManifest] : [])];
  if (args.includes('--cas-child')) {
    const { createCatalogFilesystemStorage } = await import('../examples/package-catalog/filesystem-storage.mjs');
    const storage = createCatalogFilesystemStorage(join(value('--fixture-dir'), 'cas-store'));
    try { console.log(JSON.stringify({ committed: await storage.compareAndSwap('101:package-catalog:cas-owner', undefined,
      JSON.stringify({ contender: value('--contender') }), { signal: new AbortController().signal, isCurrent: () => true }) })); }
    finally { storage.close(); }
  } else if (args.includes('--child')) {
    const input = readFileSync(0); assert.ok(input.byteLength <= 64 * 1024, 'Host provisioning input is bounded');
    const provision = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input));
    const { runPackageCatalogExample, runPackageCatalogRestart } = await import('../examples/package-catalog/consumer.mjs');
    const phase = value('--phase');
    const outcome = phase === 'restart' ? await runPackageCatalogRestart(value('--fixture-dir'), provision)
      : await runPackageCatalogExample(value('--fixture-dir'), phase, provision);
    console.log(JSON.stringify(outcome));
  } else {
    const own = ['packages/device-model/src/package-catalog.ts', 'packages/device-model/src/package-catalog.test.ts',
      'packages/device-runtime/src/package-catalog.ts', 'packages/device-runtime/src/package-catalog.test.ts',
      'examples/package-catalog/consumer.mjs', 'examples/package-catalog/filesystem-storage.mjs', 'tools/qa-package-catalog.mjs'];
    const sourceSha256 = Object.fromEntries(own.map(path => [path, hash(new URL('../' + path, import.meta.url))]));
    const directory = realpathSync(mkdtempSync(join(tmpdir(), '101-package-catalog-')));
    try {
      const keys = async () => {
        const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
        return { publicKey: await crypto.subtle.exportKey('jwk', pair.publicKey), privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey) };
      };
      const [publisher, reviewer, owner] = await Promise.all([keys(), keys(), keys()]);
      const provision = { publisher, reviewer, owner, minimumRevision: 0 };
      let minimumRevision = 0, oldSnapshot;
      const phases = [];
      for (const phase of ['submit', 'review', 'restart', 'negatives']) {
        const input = { ...provision, minimumRevision, ...(phase === 'negatives' ? { oldSnapshot } : {}) };
        if (phase === 'restart') for (const name of ['publisher', 'reviewer', 'owner']) input[name] = { publicKey: provision[name].publicKey };
        const outcome = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', '--fixture-dir', directory, '--phase', phase, ...passthrough],
          { input: JSON.stringify(input), encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 });
        assert.equal(outcome.status, 0, outcome.stderr || outcome.stdout || outcome.error?.message);
        const result = JSON.parse(outcome.stdout.trim()); phases.push(result);
        // This checkpoint is parent-owned provisioned authority, carried to a clean process outside the restored document.
        minimumRevision = Math.max(minimumRevision, result.revision);
        if (phase === 'submit') oldSnapshot = readFileSync(join(directory, 'store', createHash('sha256').update(result.storageKey).digest('hex') + '.json'), 'utf8');
      }
      const contenders = await Promise.all(['one', 'two'].map(contender => new Promise((resolveResult, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--cas-child', '--fixture-dir', directory, '--contender', contender, ...passthrough],
          { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error('owned-catalog-CAS-timeout')); }, 10_000);
        child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 16 * 1024) child.kill(); });
        child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 16 * 1024) child.kill(); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => {
          clearTimeout(timer); if (code !== 0) reject(new Error(stderr || 'owned-CAS-failure'));
          else try { resolveResult(JSON.parse(stdout.trim())); } catch (error) { reject(error); }
        });
      })));
      assert.equal(contenders.filter(result => result.committed).length, 1, 'one separate process wins the absent-document CAS');
      for (const [path, pin] of Object.entries(sourceSha256)) assert.equal(hash(new URL('../' + path, import.meta.url)), pin);
      rmSync(directory, { recursive: true, force: true });
      console.log(JSON.stringify({ result: 'pass', profile: 'local-reviewed-processor-catalog/1', node: process.version,
        publicResolution: sdkRoot ? 'installed-packed-sdk' : 'owned-worktree-public-barrels', cleanProcesses: phases.length,
        separatelyProvisionedMinimumRevision: minimumRevision, externalCheckpointRollbackExcluded: true,
        separateProcessAtomicCas: true, noPublicationOrResourceAuthority: true, disposableStorageRemoved: true, phases, sourceSha256 }, null, 2));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
} finally { hooks?.deregister(); if (resolutionDirectory) rmSync(resolutionDirectory, { recursive: true, force: true }); }
