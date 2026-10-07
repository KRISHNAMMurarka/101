#!/usr/bin/env node
/** Explicit offline external tutorial. Importing this tool does not start a project or process. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sdkNames = ['@101/connect', '@101/device-model', '@101/device-runtime', '@101/device-web', '@101/transport-webrtc', '@101/transport-websocket', '@101/vision'];
const ownedPaths = ['examples/developer-onboarding/onboarding.mjs', 'examples/developer-onboarding/consumer.mjs',
  'tests/developer-onboarding.test.ts', 'tools/qa-developer-onboarding.mjs'];
const cap = { children: 12, raw: 1, output: 8 * 1024 * 1024, receipt: 16384, lifetime: 120000 };
const root = fileURLToPath(new URL('..', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fileHash = path => hash(readFileSync(path));
function inside(parent, child) { const rel = relative(parent, child); return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel); }
function boundedJson(path) {
  const facts = lstatSync(path);
  assert.ok(facts.isFile() && !facts.isSymbolicLink() && facts.size <= cap.output, 'Invalid bounded metadata file');
  return JSON.parse(readFileSync(path, 'utf8'));
}
function inventory(directory, base = directory) {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name), facts = lstatSync(path);
    assert.ok(!facts.isSymbolicLink() && inside(base, path), 'Installed package symlink/path escape');
    if (facts.isDirectory()) return inventory(path, base);
    assert.ok(facts.isFile() && facts.size <= cap.output, 'Unexpected installed file');
    return [{ path: relative(base, path).replaceAll('\\', '/'), size: facts.size, sha256: fileHash(path) }];
  }).sort((a, b) => a.path.localeCompare(b.path));
}
function auditInstalled(manifest, consumer, previous) {
  assert.deepEqual(manifest.packages.map(item => item.name).sort(), sdkNames);
  for (const item of manifest.packages) {
    assert.equal(fileHash(item.tarball), item.sha256, `Tarball changed: ${item.name}`);
    assert.equal(lstatSync(item.tarball).size, item.bytes);
    const directory = realpathSync(join(consumer, 'node_modules', item.name));
    assert.ok(inside(consumer, directory), 'Installed package outside clean consumer');
    assert.deepEqual(inventory(directory), [...item.files].sort((a, b) => a.path.localeCompare(b.path)), `Installed bytes changed: ${item.name}`);
  }
  const lock = boundedJson(join(consumer, 'package-lock.json'));
  // The ordinary SDK QA adds its one pinned external processor after auditing
  // the initial seven-package graph. Verify that exact producer output too.
  const extension = previous.checks.find(item => item.name === 'external-processor-offline-consumer');
  const additional = [];
  if (extension) {
    assert.equal(extension.status, 'pass');
    assert.equal(extension.package, '@example/temperature-band-processor');
    const directory = join(consumer, 'node_modules', extension.package);
    assert.ok(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink() && inside(consumer, realpathSync(directory)));
    const contents = inventory(directory);
    assert.deepEqual(contents.map(item => item.path).sort(), ['LICENSE', 'manifest.json', 'package.json', 'processor.mjs']);
    assert.equal(fileHash(join(directory, 'processor.mjs')), extension.codeSha256);
    assert.equal(boundedJson(join(directory, 'manifest.json')).codeSha256, extension.codeSha256);
    assert.equal(boundedJson(join(directory, 'package.json')).name, extension.package);
    additional.push(`node_modules/${extension.package}`);
  }
  assert.deepEqual(Object.keys(lock.packages).sort(), ['', ...sdkNames.map(name => `node_modules/${name}`), ...additional].sort());
}

/** A direct issued child stays reserved until the actual close event, including cancellation and spawn errors. */
function childRunner(work, commands, state) {
  return async function child(label, args, options = {}) {
    assert.equal(state.raw, 0, 'A prior native child has not closed');
    assert.ok(state.starts < cap.children, 'Direct child start budget exhausted');
    state.starts++; state.raw++;
    const env = { ...process.env, npm_config_registry: 'http://127.0.0.1:9',
      npm_config_cache: join(work, 'npm-cache'), npm_config_ignore_scripts: 'true' };
    delete env.NODE_OPTIONS; delete env.NODE_PATH;
    const output = [], errors = []; let bytes = 0, exit, signal, issued = false, killed = false, spawnError;
    let resolveClose; const closed = new Promise(resolvePromise => { resolveClose = resolvePromise; });
    let processChild;
    try {
      processChild = spawn(options.executable ?? process.execPath, args, { cwd: options.cwd ?? work,
        env, stdio: options.stopOnIssued ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['pipe', 'pipe', 'pipe'] });
      const retire = () => { killed = true; processChild.kill('SIGTERM'); };
      const append = (collection, data) => {
        bytes += data.length;
        if (bytes > cap.output) { retire(); return; }
        collection.push(data);
      };
      processChild.stdout.on('data', data => append(output, data));
      processChild.stderr.on('data', data => append(errors, data));
      processChild.once('error', error => { spawnError = error.code ?? error.name; });
      processChild.once('exit', (code, cause) => { exit = code; signal = cause; });
      processChild.once('close', () => { state.raw--; resolveClose(); });
      if (options.stopOnIssued) processChild.on('message', message => {
        if (message?.kind !== 'onboarding-owned-issued' || issued) return;
        issued = true; assert.equal(state.raw, 1); retire();
      });
      const timer = setTimeout(retire, Math.min(options.deadline ?? cap.lifetime, cap.lifetime));
      state.timers++;
      if (options.input) processChild.stdin.end(options.input); else processChild.stdin.end();
      try { await closed; }
      finally { clearTimeout(timer); state.timers--; }
    } catch (error) {
      if (!processChild) { state.raw--; resolveClose(); }
      else { processChild.kill('SIGTERM'); await closed; }
      throw error;
    }
    const stdout = Buffer.concat(output), stderr = Buffer.concat(errors);
    const logPath = join(work, `command-${commands.length + 1}.json`);
    writeFileSync(logPath, JSON.stringify({ label, args, cwd: options.cwd ?? work, exit, signal, spawnError,
      issued, killed, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), actualClose: true }) + '\n');
    commands.push({ label, exit, signal, issued, killed, actualClose: true, path: logPath, sha256: fileHash(logPath) });
    assert.ok(bytes <= cap.output, 'Child output bound exceeded');
    if (options.stopOnIssued) { assert.equal(issued, true); assert.equal(signal, 'SIGTERM'); }
    else assert.equal(exit, 0, `${label}: ${stderr.toString('utf8').slice(0, 1200) || spawnError || signal}`);
    return stdout;
  };
}

async function bindSource(child, manifest, callerTree) {
  assert.match(callerTree, /^[0-9a-f]{40}$/); assert.match(manifest.source.tree, /^[0-9a-f]{40}$/);
  const source = Object.entries(manifest.source.sha256).sort(([a], [b]) => a.localeCompare(b));
  assert.ok(source.length > 0 && source.length <= 512);
  const requests = [...source.map(([path, digest]) => ({ path, digest, tree: manifest.source.tree })),
    ...ownedPaths.map(path => ({ path, digest: fileHash(join(root, path)), tree: callerTree }))];
  for (const { path, digest } of requests) {
    assert.ok(path && !isAbsolute(path) && !path.split('/').includes('..') && !/[\r\n\0]/.test(path));
    assert.match(digest, /^[0-9a-f]{64}$/);
  }
  // One bounded native batch, never hundreds of Git forks before the ordinary Node child.
  const raw = await child('immutable-source-batch', ['cat-file', '--batch'], { executable: '/usr/bin/git', cwd: root,
    input: requests.map(item => `${item.tree}:${item.path}\n`).join(''), deadline: 10000 });
  let offset = 0;
  for (const item of requests) {
    const newline = raw.indexOf(10, offset); assert.ok(newline >= offset);
    const header = raw.subarray(offset, newline).toString('ascii').match(/^[0-9a-f]{40} blob (\d+)$/);
    assert.ok(header); const size = Number(header[1]);
    assert.ok(Number.isSafeInteger(size) && size >= 0 && size <= cap.output);
    const data = raw.subarray(newline + 1, newline + 1 + size);
    assert.equal(data.length, size); assert.equal(hash(data), item.digest, `Immutable source mismatch: ${item.path}`);
    assert.equal(fileHash(join(root, item.path)), item.digest, `Current source mismatch: ${item.path}`);
    assert.equal(raw[newline + 1 + size], 10); offset = newline + 2 + size;
  }
  assert.equal(offset, raw.length);
  return Object.fromEntries(ownedPaths.map(path => [path, fileHash(join(root, path))]));
}

function writeDriver(path, contents) { writeFileSync(path, contents, { encoding: 'utf8', flag: 'wx' }); }
function jsonOutput(bytes) { const lines = bytes.toString('utf8').trim().split('\n'); return JSON.parse(lines.at(-1)); }
function compiledPins(project) {
  return { sourceSha256: fileHash(join(project, 'src/processor.ts')),
    manifestSha256: fileHash(join(project, 'processor.manifest.json')),
    'connector.js': fileHash(join(project, 'dist/connector.js')), 'processor.js': fileHash(join(project, 'dist/processor.js')) };
}

async function main() {
  const [mode, manifestInput, consumerInput, compilerInput, callerTree] = process.argv.slice(2);
  assert.ok(mode === '--installed' && process.argv.length === 7,
    'Usage: node tools/qa-developer-onboarding.mjs --installed <manifest> <clean-consumer> <typescript-tarball> <immutable-caller-tree>');
  const work = mkdtempSync('/tmp/101-developer-onboarding-');
  const commands = [], state = { starts: 0, raw: 0, timers: 0 };
  const child = childRunner(work, commands, state);
  const receipt = { schemaVersion: 1, status: 'pending', mode: 'installed', work,
    environment: { node: process.version, executable: process.execPath, nodeOptions: 'unset', nodePath: 'unset' },
    checks: [], cleanup: { directChildrenClosed: false, timers: 0, projectRetainedForEvidence: true } };
  const receiptPath = join(work, 'receipt.json');
  let manifest, consumer;
  try {
    assert.equal(process.env.NODE_OPTIONS, undefined); assert.equal(process.env.NODE_PATH, undefined);
    const manifestPath = realpathSync(resolve(manifestInput)); manifest = boundedJson(manifestPath);
    assert.equal(manifest.schemaVersion, 1);
    consumer = realpathSync(resolve(consumerInput)); assert.ok(!inside(realpathSync(root), consumer));
    const previous = boundedJson(join(consumer, 'receipt.json'));
    assert.equal(previous.status, 'pass'); assert.equal(previous.manifest.sha256, fileHash(manifestPath));
    auditInstalled(manifest, consumer, previous);
    const compilerTarball = realpathSync(resolve(compilerInput));
    assert.ok(lstatSync(compilerTarball).isFile() && lstatSync(compilerTarball).size <= cap.output);
    receipt.artifacts = { manifest: { path: manifestPath, sha256: fileHash(manifestPath) },
      consumer: { path: consumer, receiptSha256: fileHash(join(consumer, 'receipt.json')) },
      compiler: { path: compilerTarball, sha256: fileHash(compilerTarball) }, producerTree: manifest.source.tree, callerTree };
    receipt.sourcePins = await bindSource(child, manifest, callerTree);
    receipt.checks.push({ stage: 'install', status: 'pass', sdkPackages: 7,
      installedFiles: manifest.packages.reduce((count, item) => count + item.files.length, 0),
      scope: 'Actual supplied clean consumer receipt and every manifest/tarball/installed SDK byte; not a new pack or published install.' });

    const bootstrap = join(work, 'bootstrap'); mkdirSync(bootstrap);
    writeFileSync(join(bootstrap, 'package.json'), '{"private":true,"type":"module"}\n');
    symlinkSync(join(consumer, 'node_modules'), join(bootstrap, 'node_modules'));
    const project = join(work, 'room-sensor');
    const createScript = join(bootstrap, 'create.mjs');
    writeDriver(createScript, `import assert from 'node:assert/strict';
import { createDeviceScaffold } from '@101/connect/examples/device-scaffold';
import { createOnboardingProject, reviewOnboardingProject } from '@101/connect/examples/onboarding';
const files = createDeviceScaffold({ id: 'room-sensor' });
const result = await createOnboardingProject({ id: 'room-sensor', destination: ${JSON.stringify(project)} });
assert.deepEqual(Object.keys(result.files).sort(), Object.keys(files).sort());
const review = await reviewOnboardingProject({ id: 'room-sensor', directory: result.directory, revision: 'base' });
console.log(JSON.stringify({ status: 'pass', files: result.files, review,
 resolutions: ['@101/connect', '@101/connect/examples/device-scaffold', '@101/connect/examples/onboarding'].map(name => [name, import.meta.resolve(name)]) }));
`);
    const created = jsonOutput(await child('create-public-scaffold', [createScript]));
    for (const [, url] of created.resolutions) assert.ok(inside(join(consumer, 'node_modules'), realpathSync(fileURLToPath(url))));
    assert.equal(created.status, 'pass'); receipt.checks.push({ stage: 'create', status: 'pass', files: created.files });
    const originalSource = readFileSync(join(project, 'src/processor.ts'));
    const originalManifest = readFileSync(join(project, 'processor.manifest.json'));
    const npm = realpathSync(join(dirname(dirname(process.execPath)), 'lib/node_modules/npm/bin/npm-cli.js'));
    receipt.artifacts.npm = { path: npm, sha256: fileHash(npm) };
    await child('offline-project-install', [npm, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
      ...manifest.packages.map(item => item.tarball), compilerTarball], { cwd: project });
    for (const item of manifest.packages) assert.deepEqual(inventory(join(project, 'node_modules', item.name)), [...item.files].sort((a, b) => a.path.localeCompare(b.path)));
    const compiler = join(project, 'node_modules/typescript/bin/tsc');
    assert.equal(boundedJson(join(project, 'node_modules/typescript/package.json')).name, 'typescript');
    assert.equal(boundedJson(join(project, 'node_modules/typescript/package.json')).version, '5.9.3');
    receipt.artifacts.installedCompiler = { path: compiler, sha256: fileHash(compiler),
      version: boundedJson(join(project, 'node_modules/typescript/package.json')).version };
    const compilerBindings = [];
    const compile = async label => {
      const before = { sourceSha256: fileHash(join(project, 'src/processor.ts')), manifestSha256: fileHash(join(project, 'processor.manifest.json')) };
      assert.equal(fileHash(compiler), receipt.artifacts.installedCompiler.sha256);
      await child(label, [compiler, '-p', 'tsconfig.json', '--noUncheckedIndexedAccess', 'true'], { cwd: project });
      const bound = compiledPins(project);
      assert.equal(bound.sourceSha256, before.sourceSha256); assert.equal(bound.manifestSha256, before.manifestSha256);
      assert.equal(fileHash(compiler), receipt.artifacts.installedCompiler.sha256);
      compilerBindings.push({ label, before, emitted: bound, compilerSha256: fileHash(compiler) });
      return bound;
    };
    const basePins = await compile('compile-base');

    const driver = join(project, 'onboarding-check.mjs');
    writeDriver(driver, `import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createDeviceScaffold } from '@101/connect/examples/device-scaffold';
import { runOnboardingExample } from '@101/connect/examples/onboarding';
const [revision, serializedPins, action] = process.argv.slice(2);
const compiledSha256 = JSON.parse(serializedPins), directory = process.cwd();
const options = { id: 'room-sensor', directory, revision, compiledSha256 };
const denied = await runOnboardingExample({ ...options, mode: 'denied', sample: 31 });
assert.equal(denied.denied, true); assert.equal(denied.effects, 0); assert.equal(denied.factoryCalls, 0);
const boundary = await runOnboardingExample({ ...options, mode: 'approved', sample: 30 });
const high = await runOnboardingExample({ ...options, mode: 'approved', sample: 31 });
assert.equal(boundary.reading, 30); assert.equal(boundary.switchOn, revision === 'base');
assert.equal(high.reading, 31); assert.equal(high.switchOn, true);
for (const result of [boundary, high]) { assert.deepEqual(result.afterStop, { hasReading: false, released: 1 });
 assert.equal(result.routesClosed, true); assert.equal(result.runtimeClosed, true); assert.equal(result.effects, 1); }
let recovery;
if (action === 'recover') {
 const source = readFileSync('src/processor.ts'), manifest = readFileSync('processor.manifest.json');
 writeFileSync('src/processor.ts', Buffer.concat([source, Buffer.from('\\n// altered after review\\n')]));
 await assert.rejects(() => runOnboardingExample({ ...options, mode: 'approved', sample: 31 }), /onboarding-source-pin/);
 writeFileSync('src/processor.ts', source); writeFileSync('processor.manifest.json', manifest);
 const devices = readFileSync('src/devices.json');
 const incompatible = JSON.parse(devices); incompatible[0].capabilities[0].semantic = 'other:temperature';
 writeFileSync('src/devices.json', JSON.stringify(incompatible));
 await assert.rejects(() => runOnboardingExample({ ...options, mode: 'approved', sample: 31 }), /onboarding-assets/);
 writeFileSync('src/devices.json', devices);
 writeFileSync('keep-unknown.txt', 'owned foreign-content preservation sentinel');
 const known = createDeviceScaffold({ id: 'room-sensor' });
 // Explicit selected restore, not an automatic fallback after rejection.
 writeFileSync('src/processor.ts', known['src/processor.ts']); writeFileSync('processor.manifest.json', known['processor.manifest.json']);
 await assert.rejects(() => runOnboardingExample({ ...options, revision: 'base', mode: 'approved', sample: 31 }), /onboarding-compiled-pin/);
 recovery = { tamperBeforeFactory: true, incompatibleBeforeFactory: true, explicitRestore: true, oldCompilationDenied: true,
 sourceSha256: createHash('sha256').update(known['src/processor.ts']).digest('hex') };
}
console.log(JSON.stringify({ denied, boundary, high, recovery }));
`);
    const base = jsonOutput(await child('connect-public-consumer', [driver, 'base', JSON.stringify(basePins)], { cwd: project }));
    receipt.checks.push({ stage: 'connect', status: 'pass', result: base, compiledPins: basePins });
    const validation = jsonOutput(await child('test-generated-validator', ['scripts/validate.mjs'], { cwd: project }));
    assert.equal(validation.status, 'pass');
    await child('test-generated-project', ['--test', 'test/project.test.mjs'], { cwd: project });
    receipt.checks.push({ stage: 'test', status: 'pass', validation,
      scope: 'Real fixed generated tests include their existing non-detached Node test/negative subchildren; the one raw slot bounds direct QA dispatch, not a process-tree sandbox.' });

    assert.equal(originalSource.toString('utf8').split('temperature >= onAt').length, 2);
    const extendedSource = originalSource.toString('utf8').replace('temperature >= onAt', 'temperature > onAt');
    const extendedManifest = JSON.parse(originalManifest); extendedManifest.version = '1.0.1'; extendedManifest.codeSha256 = hash(extendedSource);
    writeFileSync(join(project, 'src/processor.ts'), extendedSource);
    writeFileSync(join(project, 'processor.manifest.json'), JSON.stringify(extendedManifest, null, 2) + '\n');
    const extendedPins = await compile('compile-reviewed-extension');
    const extended = jsonOutput(await child('extend-and-explicit-recovery', [driver, 'strict-threshold', JSON.stringify(extendedPins), 'recover'], { cwd: project }));
    assert.equal(extended.boundary.switchOn, false);
    receipt.checks.push({ stage: 'extend', status: 'pass', result: extended, compiledPins: extendedPins });
    assert.equal(fileHash(join(project, 'src/processor.ts')), hash(originalSource));
    assert.equal(fileHash(join(project, 'processor.manifest.json')), hash(originalManifest));
    const restoredPins = await compile('compile-explicit-restore');
    const restored = jsonOutput(await child('recover-fresh-approved-consumer', [driver, 'base', JSON.stringify(restoredPins)], { cwd: project }));
    assert.equal(restored.boundary.switchOn, true);
    assert.equal(readFileSync(join(project, 'keep-unknown.txt'), 'utf8'), 'owned foreign-content preservation sentinel');
    receipt.checks.push({ stage: 'recover', status: 'pass', result: restored, compiledPins: restoredPins, unknownFilePreserved: true });

    const rawProbe = join(project, 'owned-stop.mjs');
    writeDriver(rawProbe, `import { readFileSync } from 'node:fs';
import { createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
const devices = JSON.parse(readFileSync('src/devices.json', 'utf8')).map(parseDeviceDescriptor);
let source, sink; const runtime = createDeviceRuntime({ authorize(request) {
 if (request.principalId !== 'owner' || request.applicationId !== 'room-sensor' || request.sessionId !== 'demo' ||
 request.source.registrationId !== source?.id || request.sink.registrationId !== sink?.id ||
 request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write') return undefined;
 return { expiresAt: performance.now() + 30000, maxAgeMs: 1000, maxHz: 10 };
}, now: () => performance.now() });
source = runtime.registerSource({ device: devices[0], capability: 'temperature' });
sink = runtime.registerSink({ device: devices[1], capability: 'temperature', apply(_value, context) {
 if (!context.isCurrent() || context.signal.aborted) throw new Error('obsolete raw fixture');
 process.send({ kind: 'onboarding-owned-issued' }); return new Promise(() => {});
}, release() {} });
runtime.setReadiness(source, 'available'); runtime.setReadiness(sink, 'available');
const route = runtime.route({ from: source, to: sink, principalId: 'owner', applicationId: 'room-sensor', sessionId: 'demo', leaseMs: 1000 });
if (!route.start().ok || !runtime.publish(source, 31).ok) throw new Error('owned raw fixture not admitted');
runtime.flush(); setInterval(() => {}, 1000);
`);
    await child('stop-issued-owned-native-child', [rawProbe], { cwd: project, stopOnIssued: true });
    receipt.rawSettlement = { issuedLocalSoftwareSinkWork: true, terminatedChildClosed: true,
      rawReservationUntilActualClose: true, cancelledIssuedEffect: 'unverified',
      scope: 'Owned native Node child and local software effect; termination is not a target acknowledgement or physical safe state.' };
    receipt.compilerBindings = compilerBindings;
    assert.equal(receipt.checks.length, 6); assert.equal(state.raw, 0); assert.equal(state.timers, 0);
    auditInstalled(manifest, consumer, previous);
    assert.equal(fileHash(compilerTarball), receipt.artifacts.compiler.sha256);
    for (const [path, sha256] of Object.entries(manifest.source.sha256)) assert.equal(fileHash(join(root, path)), sha256);
    for (const [path, sha256] of Object.entries(receipt.sourcePins)) assert.equal(fileHash(join(root, path)), sha256);
    receipt.status = 'pass';
  } catch (error) {
    receipt.status = 'fail'; receipt.failure = { name: error.name, message: String(error.message).slice(0, 1200) };
    process.exitCode = 1;
  } finally {
    receipt.cleanup.directChildrenClosed = state.raw === 0;
    receipt.cleanup.timers = state.timers;
    receipt.childStarts = state.starts; receipt.commands = commands;
    receipt.truth = 'Selected offline software tutorial; no hardware/matrix/account/publication promotion. Direct-child close is actual; wider native effects and process-tree sandboxing are unqualified.';
    const serialized = JSON.stringify(receipt) + '\n';
    assert.ok(Buffer.byteLength(serialized) <= cap.receipt, 'Receipt budget exceeded');
    writeFileSync(receiptPath, serialized);
    // Keep this exact owned project and logs for source/output provenance; no deletion of unknown files.
    console.log(JSON.stringify({ status: receipt.status, receipt: receiptPath, sha256: fileHash(receiptPath), cleanup: receipt.cleanup }));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
