#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync, lstatSync, realpathSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const root = resolve(import.meta.dirname, '..'), args = process.argv.slice(2), hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.ok(args.length === 1 && args[0] === '--source' || args.length === 2 && args[0] === '--sdk-root' && args[1] && !args[1].startsWith('--'));
const ownedPaths = ['examples/coordinator/disposable-stack.mjs', 'tests/disposable-stack.test.ts', 'tools/disposable-stack.mjs', 'tools/qa-disposable-stack.mjs'];
const dependencies = ['packages/hub-server/src/loopback-relay.ts', 'packages/hub-server/src/loopback-relay.test.ts', 'examples/coordinator/loopback-relay.ts', 'tools/qa-loopback-relay.mjs',
  'packages/hub-server/src/index.ts', 'packages/hub-server/package.json', 'package-lock.json', 'packages/hub-server/src/operator-configuration.ts',
  'packages/hub-server/src/https-coordinator.ts', 'packages/hub-server/src/private-directory.ts', 'tools/qa-https-coordinator.mjs'];
const pins = Object.fromEntries([...ownedPaths, ...dependencies].map(path => [path, hash(readFileSync(join(root, path)))]));
const sdkNames = ['connect', 'device-model', 'device-runtime', 'device-web', 'transport-webrtc', 'transport-websocket', 'vision'];
const sourceNames = ['hub-server', 'pairing', 'protocol', 'input'];
const sourceEntries = Object.fromEntries(sourceNames.map(name => ['@101/' + name, pathToFileURL(join(root, 'packages', name, 'src/index.ts')).href]));
const wsEntry = createRequire(import.meta.url).resolve('ws'), wsRoot = resolve(wsEntry, '..');
const wsPackage = JSON.parse(readFileSync(join(wsRoot, 'package.json'), 'utf8')); assert.equal(wsPackage.version, '8.21.0');
function inventory(directory, prefix = '') {
  const value = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name), key = prefix + entry.name; assert.equal(entry.isSymbolicLink(), false);
    if (entry.isDirectory()) Object.assign(value, inventory(path, key + '/')); else { assert.ok(entry.isFile()); value[key] = hash(readFileSync(path)); }
    assert.ok(Object.keys(value).length <= 64);
  } return value;
}
const nativePins = inventory(wsRoot);
let external, sdkProof, target = join(root, 'tools/disposable-stack.mjs'), consumerPins;
const environment = { ...process.env }; delete environment.NODE_OPTIONS; delete environment.NODE_PATH;
const checks = [], childReceipts = [], sourceClosure = {};
async function noListener(endpoint) {
  const url = new URL(endpoint); assert.equal(url.hostname, '127.0.0.1');
  await new Promise((resolveProbe, reject) => {
    const socket = connect({ host: '127.0.0.1', port: Number(url.port) }); socket.setTimeout(1000, () => { socket.destroy(); reject(Error('Listener probe deadline')); });
    socket.once('connect', () => { socket.destroy(); reject(Error('Owned listener remained open')); });
    socket.once('error', error => error.code === 'ECONNREFUSED' ? resolveProbe() : reject(error));
  });
}
async function child(argument, cancelOnReady = false) {
  const directory = mkdtempSync(join(tmpdir(), '101-disposable-stack-qa-')); writeFileSync(join(directory, 'untouched-sentinel'), 'unrelated owner bytes\n', { mode: 0o600 });
  const processChild = spawn(process.execPath, [target, argument], { cwd: external ?? root, env: { ...environment, TMPDIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
  const events = []; let remaining = '', errors = '', failure, sent = false, outputBytes = 0;
  const watchdog = setTimeout(() => { failure ??= Error('Owned child exceeded QA watchdog'); processChild.kill('SIGTERM'); }, 30000);
  processChild.stdout.on('data', chunk => {
    try {
      outputBytes += chunk.byteLength; assert.ok(outputBytes <= 32768); remaining += chunk;
      while (remaining.includes('\n')) {
        const index = remaining.indexOf('\n'), line = remaining.slice(0, index); remaining = remaining.slice(index + 1);
        const event = JSON.parse(line); assert.ok(events.length < 8); events.push(event);
        if (event.event === 'ready') {
          for (const endpoint of [event.coordinator, event.gateway]) assert.equal(new URL(endpoint).hostname, '127.0.0.1');
          assert.equal(event.grants, 0); assert.equal(event.gatewayPlaintextTrust, true); assert.ok(event.remainingServiceMs >= 0 && event.remainingServiceMs <= 15000);
          const fixtures = readdirSync(directory).filter(name => name !== 'untouched-sentinel'); assert.equal(fixtures.length, 1); assert.match(fixtures[0], /^101-coordinator-tls-/);
          const fixture = join(directory, fixtures[0]); assert.equal(statSync(fixture).mode & 0o777, 0o700);
          for (const name of readdirSync(fixture).filter(name => name.endsWith('.key'))) assert.equal(statSync(join(fixture, name)).mode & 0o077, 0);
          if (cancelOnReady && !sent) { sent = true; processChild.kill('SIGTERM'); }
        }
        if (event.event === 'consumer-closure') Object.assign(sourceClosure, event.sha256);
      }
    } catch (error) { failure ??= error; processChild.kill('SIGTERM'); }
  });
  processChild.stderr.on('data', chunk => { errors += chunk; if (Buffer.byteLength(errors) > 32768) { failure ??= Error('Unbounded owned child errors'); processChild.kill('SIGTERM'); } });
  try {
    const exit = await new Promise((resolveExit, reject) => { processChild.once('error', reject); processChild.once('close', (code, signal) => resolveExit({ code, signal })); });
    if (failure) throw failure;
    assert.deepEqual(exit, { code: argument === '--invalid' ? 2 : 0, signal: null }); assert.equal(remaining, '');
    assert.deepEqual(readdirSync(directory), ['untouched-sentinel']); assert.equal(readFileSync(join(directory, 'untouched-sentinel'), 'utf8'), 'unrelated owner bytes\n');
    if (argument !== '--invalid') {
      assert.equal(errors, ''); const removed = events.find(value => value.event === 'removed'); assert.ok(removed?.temporaryCredentialsRemoved); assert.equal(removed.nativeContexts, 0);
      for (const endpoint of removed.endpoints) await noListener(endpoint);
      for (const forbidden of ['PRIVATE KEY', 'BEGIN CERTIFICATE', 'hostToken', 'joinToken', 'peerToken', 'certificatePem', 'privateKeyPem']) assert.equal(JSON.stringify(events).includes(forbidden), false);
    }
    return { argument, events, exit, sentinelUnchanged: true, ownedFixtureRootsRemoved: true, outputBytes };
  } finally {
    clearTimeout(watchdog);
    if (processChild.exitCode === null && processChild.signalCode === null) { const closed = new Promise(resolveClose => processChild.once('close', resolveClose)); processChild.kill('SIGTERM'); await closed; }
    assert.deepEqual(readdirSync(directory), ['untouched-sentinel']); rmSync(directory, { recursive: true });
  }
}
try {
  if (args[0] === '--sdk-root') {
    const consumer = realpathSync(resolve(args[1])); assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-sdk-consumer-'))); assert.equal(lstatSync(join(consumer, 'node_modules')).isSymbolicLink(), false);
    const receipt = JSON.parse(readFileSync(join(consumer, 'receipt.json'), 'utf8')); assert.equal(receipt.status, 'pass'); const manifestBytes = readFileSync(receipt.manifest.path);
    assert.equal(hash(manifestBytes), receipt.manifest.sha256); const manifest = JSON.parse(manifestBytes); assert.equal(manifest.source.tree, receipt.source.tree); assert.deepEqual(manifest.source.sha256, receipt.source.sha256);
    assert.equal(manifest.packages.length, 7); const sourcePins = Object.entries(manifest.source.sha256); assert.ok(sourcePins.length > 0 && sourcePins.length <= 256);
    for (const [path, pin] of sourcePins) assert.equal(hash(readFileSync(join(root, path))), pin, path);
    let files = 0;
    for (const name of sdkNames) {
      const item = manifest.packages.find(value => value.name === '@101/' + name); assert.ok(item && item.files.length && item.files.length <= 1024);
      const directory = join(consumer, 'node_modules', item.name); assert.equal(realpathSync(directory), directory); assert.equal(lstatSync(directory).isSymbolicLink(), false);
      for (const entry of item.files) { const path = resolve(directory, entry.path); assert.ok(path.startsWith(directory + '/')); assert.equal(realpathSync(path), path); assert.ok(lstatSync(path).isFile()); assert.equal(hash(readFileSync(path)), entry.sha256); files++; }
    }
    external = mkdtempSync(join(consumer, 'disposable-stack-consumer-')); const resolver = join(external, 'resolve.mjs');
    writeFileSync(resolver, 'export default {' + sdkNames.map(name => JSON.stringify('@101/' + name) + ':import.meta.resolve(' + JSON.stringify('@101/' + name) + ')').join(',') + '};\n');
    const entries = (await import(pathToFileURL(resolver).href)).default; rmSync(resolver);
    for (const name of sdkNames) assert.equal(entries['@101/' + name], pathToFileURL(join(consumer, 'node_modules/@101', name, 'dist/index.js')).href);
    target = join(external, 'caller.mjs');
    writeFileSync(target, `import { registerHooks } from 'node:module';\nimport { createHash } from 'node:crypto';\nimport { readFileSync } from 'node:fs';\nimport { fileURLToPath } from 'node:url';\nconst entries=${JSON.stringify({ ...sourceEntries, ...entries })}, root=${JSON.stringify(root)}, sha256={};\nconst hooks=registerHooks({resolve(specifier,context,next){const value=next(entries[specifier]??specifier,context);if(value.url.startsWith('file:')){const path=fileURLToPath(value.url);if(path.startsWith(root+'/')&&!path.includes('/node_modules/')&&/\\.(ts|mjs)$/.test(path)){if(Object.keys(sha256).length>=256&&!Object.hasOwn(sha256,path.slice(root.length+1)))throw Error('Closure quota');sha256[path.slice(root.length+1)]=createHash('sha256').update(readFileSync(path)).digest('hex');}}return value;}});\nconst args=process.argv.slice(2),owner=new AbortController(),cancel=()=>owner.abort();\nif(args.length!==1||!['--exercise','--serve'].includes(args[0])){console.error('Select exercise or serve.');process.exitCode=2;}else{process.once('SIGINT',cancel);process.once('SIGTERM',cancel);try{const {runDisposableStack}=await import(${JSON.stringify(pathToFileURL(join(root, 'examples/coordinator/disposable-stack.mjs')).href)});const receipt=await runDisposableStack({mode:args[0].slice(2),signal:owner.signal,onEvent:value=>console.log(JSON.stringify(value))});if(args[0]==='--exercise'&&receipt.result==='pass'&&!owner.signal.aborted)console.log(JSON.stringify({event:'exercised',proof:receipt}));console.log(JSON.stringify({event:'consumer-closure',sha256}));}catch{console.error('Disposable stack failed.');process.exitCode=1;}finally{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}}hooks.deregister();\n`);
    consumerPins = { caller: target, sha256: hash(readFileSync(target)) };
    sdkProof = { path: receipt.manifest.path, sha256: receipt.manifest.sha256, tree: manifest.source.tree, packages: 7, productionSourcePins: sourcePins.length, packedFiles: files, receipt: join(consumer, 'receipt.json') };
  }
  const exercise = await child('--exercise'); childReceipts.push(exercise); const proof = exercise.events.find(value => value.event === 'exercised')?.proof;
  assert.equal(proof?.result, 'pass'); assert.equal(proof.actualControllerGenerations, 2); assert.equal(proof.actualSoftwareEffects, 4); assert.ok(proof.sinkReleases >= 3 && proof.checks.length <= 32);
  checks.push('simultaneously live actual mTLS coordinator/directory/gateway; independent grants/denials/revocation/current typed effects and fresh-owner recovery');
  const cancelled = await child('--serve', true); childReceipts.push(cancelled); assert.equal(cancelled.events.find(value => value.event === 'removed').reason, 'cancelled');
  assert.equal(cancelled.events.some(value => value.event === 'exercised'), false); checks.push('SIGTERM retires both native listeners and actual client work before exact newly owned PKI removal');
  const expired = await child('--serve'); childReceipts.push(expired); assert.equal(expired.events.find(value => value.event === 'removed').reason, 'expired');
  checks.push('remaining overall15s native budget expires both components; no replacement or success');
  const invalid = await child('--invalid'); childReceipts.push(invalid); assert.equal(invalid.events.length, 0); checks.push('closed CLI rejects input before native bind or fixture allocation');
  for (const [path, pin] of Object.entries(pins)) assert.equal(hash(readFileSync(join(root, path))), pin, path);
  for (const [path, pin] of Object.entries(sourceClosure)) assert.equal(hash(readFileSync(join(root, path))), pin, path);
  console.log(JSON.stringify({ schemaVersion: 1, result: 'pass', profile: 'disposable-coordinator-directory-gateway/1', node: process.version,
    publicResolution: args[0] === '--source' ? 'owned-real-public-source-barrels' : 'new-hub-and-harness-source-with-ordinary-byte-verified-installed-seven-package-sdk',
    installedHubClaim: false, sourceSha256: pins, resolvedSourceSha256: sourceClosure, ...(sdkProof ? { sdk: sdkProof, externalConsumer: consumerPins } : {}),
    nativeLibrary: { version: wsPackage.version, sha256: nativePins }, checks, childReceipts, ownedNativeContexts: 0,
    scope: { storage: 'ephemeral', gatewayPlaintextTrust: true, resourceGrantsFromConfigurationOrDirectoryOrRelay: false, physicalQualification: false,
      remoteInternetTurnServiceInstallPersistentOrSigkillQualification: false, fixtureProvisioningSeparateFromNativeServiceBudget: true } }, null, 2));
} finally {
  // Keep exact external caller/receipt provenance, never modify borrowed packages.
  if (external && consumerPins) assert.equal(hash(readFileSync(consumerPins.caller)), consumerPins.sha256);
}
