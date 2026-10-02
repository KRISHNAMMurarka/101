#!/usr/bin/env node
/** Clean external checks of the local SDK tarballs; never publishes or uses a registry. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const names = ['@101/device-model', '@101/device-runtime', '@101/transport-webrtc', '@101/device-web', '@101/connect'];
const input = process.argv[2];
const work = mkdtempSync('/tmp/101-sdk-consumer-');
const receiptPath = join(work, 'receipt.json');
const logs = [];
const receipt = { schemaVersion: 1, mode: input === '--baseline' ? 'baseline' : 'distribution', startedAt: new Date().toISOString(), consumer: work, qaTool: { path: fileURLToPath(import.meta.url), sha256: hash(fileURLToPath(import.meta.url)) }, environment: { node: process.version }, checks: [] };

function redact(value) {
  return String(value)
    .replace(/("(?:keyId|publicKey|privateKey|signature|nonce|epoch|sessionId|applicationId|operationId|registrationId|deviceId|sdp)"\s*:\s*)"(?:[^"\\]|\\.)*"/g, '$1"[redacted]"')
    .replace(/\b[0-9a-fA-F]{32,}\b/g, '[redacted hex]')
    .replace(/(?:^|\n)(?:v=0|[aimc]=(?:fingerprint|ice-|candidate|IN IP|application|audio|video)[^\n]*)[^]*?(?=\n\n|$)/g, '\n[redacted SDP]');
}

function run(label, executable, args, cwd = work) {
  const env = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', npm_config_registry: 'http://127.0.0.1:9', npm_config_cache: join(work, '.npm-cache') };
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  logs.push({ label, executable, args, cwd, status: result.status, stdout: redact(result.stdout ?? ''), stderr: redact(result.stderr ?? ''), error: result.error?.message });
  assert.equal(result.status, 0, `${label} failed (${result.status ?? result.error?.code ?? 'unknown'}): ${redact(result.stderr || result.stdout || result.error?.message || '').slice(0, 1200)}`);
  return result.stdout;
}

function hash(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }

function within(parent, child) {
  const path = relative(parent, child);
  return path !== '..' && !path.startsWith('../') && !isAbsolute(path);
}

function files(directory, base = directory) {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name), stat = lstatSync(path);
    assert.ok(!stat.isSymbolicLink(), `Symlink forbidden in external consumer: ${path}`);
    assert.ok(within(realpathSync(work), realpathSync(path)), `Consumer file escaped its owned directory: ${path}`);
    if (stat.isDirectory()) return files(path, base);
    assert.ok(stat.isFile(), `Unexpected consumer filesystem entry: ${path}`);
    return [{ path: relative(base, path).replaceAll('\\', '/'), size: stat.size, sha256: hash(path) }];
  }).sort((a, b) => a.path.localeCompare(b.path));
}

function sourceBoundManifest(path) {
  const actualPath = realpathSync(resolve(path));
  const manifest = JSON.parse(readFileSync(actualPath, 'utf8'));
  assert.equal(manifest.schemaVersion, 1, 'Unsupported SDK manifest version');
  assert.ok(isAbsolute(manifest.outputDir), 'SDK outputDir must be absolute');
  const output = realpathSync(manifest.outputDir);
  assert.ok(within(realpathSync(join(root, 'release')), output), 'SDK artifacts must belong to the local release directory');
  assert.ok(within(output, actualPath), 'Manifest must be inside its owned output directory');
  assert.match(manifest.source?.tree ?? '', /^[0-9a-f]{40}$/, 'Manifest needs an immutable source tree');
  assert.ok(manifest.source.revision === null || /^[0-9a-f]{40}$/.test(manifest.source.revision), 'Manifest revision must be a canonical commit or null for a direct tree');
  if (manifest.source.revision !== null) {
    assert.equal(run('source-revision-tree', 'git', ['rev-parse', `${manifest.source.revision}^{tree}`], root).trim(), manifest.source.tree, 'Source revision does not identify the recorded tree');
  }
  assert.ok(Object.keys(manifest.source.sha256 ?? {}).length > 0, 'Manifest needs source hashes');
  for (const [path, digest] of Object.entries(manifest.source.sha256)) {
    assert.ok(path && !isAbsolute(path) && !path.split('/').includes('..'), 'Source hash path must be source-relative');
    assert.match(digest, /^[0-9a-f]{64}$/);
    const blob = spawnSync('git', ['cat-file', 'blob', `${manifest.source.tree}:${path}`], { cwd: root, timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(blob.status, 0, `Source hash path is absent from immutable tree: ${path}`);
    assert.equal(createHash('sha256').update(blob.stdout).digest('hex'), digest, `Immutable source hash mismatch: ${path}`);
  }
  assert.deepEqual(manifest.packages.map(item => item.name).sort(), [...names].sort(), 'Manifest must contain exactly the five general SDK packages');
  for (const item of manifest.packages) {
    assert.ok(isAbsolute(item.tarball) && isAbsolute(item.directory), 'Artifact paths must be absolute');
    assert.ok(within(output, realpathSync(item.tarball)) && within(output, realpathSync(item.directory)), 'Artifact escaped the owned output directory');
    assert.equal(hash(item.tarball), item.sha256, `Artifact hash mismatch: ${item.name}`);
    assert.equal(lstatSync(item.tarball).size, item.bytes, `Artifact byte count mismatch: ${item.name}`);
    assert.match(item.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    assert.ok(item.files.length > 0);
    const inventory = item.files.map(file => {
      assert.ok(file.path && !isAbsolute(file.path) && !file.path.split('/').includes('..') && !file.path.startsWith('package/'), 'Packed inventory must use tar-relative paths without package/');
      assert.match(file.sha256, /^[0-9a-f]{64}$/);
      assert.ok(Number.isSafeInteger(file.size) && file.size >= 0);
      return file.path;
    });
    assert.equal(new Set(inventory).size, inventory.length, `Duplicate packed path: ${item.name}`);
    const actual = run(`tar-inventory:${item.name}`, 'tar', ['-tzf', item.tarball]).trim().split('\n');
    assert.ok(actual.every(path => path.startsWith('package/') && !path.split('/').includes('..')), 'Tarball path escaped package/');
    assert.deepEqual(actual.filter(path => !path.endsWith('/')).map(path => path.slice('package/'.length)).sort(), inventory.sort(), `Tarball inventory mismatch: ${item.name}`);
  }
  receipt.manifest = { path: actualPath, sha256: hash(actualPath) };
  receipt.source = manifest.source;
  receipt.buildEnvironment = manifest.environment;
  receipt.packages = manifest.packages.map(({ name, version, tarball, sha256, bytes }) => ({ name, version, tarball, sha256, bytes }));
  receipt.checks.push({ name: 'source-and-tarball-manifest', status: 'pass' });
  return manifest;
}

function installAndAudit(manifest) {
  assert.ok(!within(realpathSync(root), realpathSync(work)), 'Consumer must be outside the repository');
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: '101-sdk-external-consumer', private: true, type: 'module' }, null, 2));
  receipt.environment.npm = run('npm-version', 'npm', ['--version']).trim();
  run('offline-install', 'npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', ...manifest.packages.map(item => item.tarball)]);
  const nodeModules = join(work, 'node_modules');
  const complete = files(nodeModules);
  assert.deepEqual(readdirSync(nodeModules).sort(), ['.package-lock.json', '@101'], 'Consumer installed undeclared top-level content');
  assert.deepEqual(readdirSync(join(nodeModules, '@101')).sort(), names.map(name => name.slice('@101/'.length)).sort(), 'Consumer must install exactly five packages');
  const lock = JSON.parse(readFileSync(join(work, 'package-lock.json'), 'utf8'));
  assert.deepEqual(Object.keys(lock.packages).sort(), ['', ...names.map(name => `node_modules/${name}`)].sort(), 'Lockfile contains undeclared or nested dependencies');
  const installed = new Map();
  for (const item of manifest.packages) {
    const directory = join(nodeModules, item.name);
    const inventory = files(directory);
    assert.deepEqual(inventory, [...item.files].sort((a, b) => a.path.localeCompare(b.path)), `Installed bytes differ from packed inventory: ${item.name}`);
    const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    assert.equal(pkg.name, item.name);
    assert.equal(pkg.version, item.version);
    assert.equal(pkg.type, 'module');
    assert.equal(pkg.license, 'MIT');
    assert.ok(!pkg.scripts || Object.keys(pkg.scripts).length === 0, `Distribution must not install scripts: ${item.name}`);
    assert.ok(!pkg.workspaces && !pkg.imports, `Workspace links and package aliases forbidden: ${item.name}`);
    assert.ok(!pkg.optionalDependencies && !pkg.peerDependencies, `Only the closed SDK dependency graph is permitted: ${item.name}`);
    for (const [dependency, version] of Object.entries(pkg.dependencies ?? {})) {
      const target = manifest.packages.find(other => other.name === dependency);
      assert.ok(target && version === target.version, `Undeclared/unversioned dependency: ${item.name} -> ${dependency}`);
    }
    const exports = pkg.exports;
    assert.ok(exports && typeof exports === 'object' && !Array.isArray(exports), `Distribution requires explicit public exports: ${item.name}`);
    const entry = exports['.'];
    assert.equal(entry?.types, './dist/index.d.ts');
    assert.equal(entry?.import ?? entry?.default, './dist/index.js');
    const allowed = ['.'];
    if (item.name === '@101/device-model' || item.name === '@101/connect') allowed.push('./schema/device-descriptor.json');
    if (item.name === '@101/connect') allowed.push(...['pointer', 'sensor-feedback', 'threshold', 'telemetry-batch', 'spatial-joints', 'rich-input', 'resource-documents', 'run'].map(name => `./examples/${name}`));
    assert.deepEqual(Object.keys(exports).sort(), allowed.sort(), `Unexpected public subpath: ${item.name}`);
    for (const [subpath, target] of Object.entries(exports)) {
      const targets = typeof target === 'string' ? [target] : Object.values(target);
      assert.ok(targets.length > 0 && targets.every(value => typeof value === 'string' && value.startsWith('./') && inventory.some(file => `./${file.path}` === value)), `Export target missing from packed inventory: ${item.name}${subpath}`);
      if (subpath.startsWith('./examples/')) {
        const name = subpath.slice('./examples/'.length);
        assert.equal(target.types, `./examples/${name}.d.ts`);
        assert.equal(target.import ?? target.default, `./examples/${name}.js`);
        assert.ok(inventory.some(file => file.path === `examples/${name}.ts`), `Documented source example absent: ${name}`);
      }
    }
    assert.ok(inventory.some(file => /(^|\/)LICENSE(?:\.md|\.txt)?$/i.test(file.path)), `License absent: ${item.name}`);
    assert.ok(inventory.some(file => /^README(?:\.md)?$/i.test(file.path)), `Public README absent: ${item.name}`);
    for (const file of inventory) {
      assert.ok(!file.path.split('/').some(part => ['src', 'node_modules', 'tests', '__tests__', 'receipts'].includes(part)) && !/\.test\.[cm]?[jt]s$/.test(file.path), `Private source/test content packed: ${item.name}/${file.path}`);
      assert.ok(!file.path.endsWith('.ts') || file.path.endsWith('.d.ts') || item.name === '@101/connect' && /^examples\/(pointer|sensor-feedback|threshold|telemetry-batch|spatial-joints|rich-input|resource-documents|run)\.ts$/.test(file.path), `Runtime TypeScript/source internals packed: ${item.name}/${file.path}`);
    }
    installed.set(item.name, { ...item, directory, pkg });
  }
  receipt.checks.push({ name: 'offline-install-closed-graph-and-exact-bytes', status: 'pass', packages: installed.size, files: complete.length, symlinks: 0, aliases: 0 });
  return installed;
}

const typeConsumer = String.raw`
import { createDeviceRuntime, PeerDataTransport, AuthenticatedResourcePeer, createReceiverInvitation, createEphemeralWebIdentity, webEndpointCrypto } from '@101/connect';
import type { DeviceDescriptor, DeviceRuntime, EndpointIdentity, ReceiverInvitation, AuthenticatedPeerOptions } from '@101/connect';
import { DeviceValidationError, createUnitConverter, createSpatialPoseConverter, parseDeviceDescriptor, parseUnitToken } from '@101/device-model';
import type { SpatialFrame, SpatialPoseConverter, SpatialPoseConverterOptions, UnitConverter, UnitConverterOptions } from '@101/device-model';
import { createDeviceRuntime as directRuntime } from '@101/device-runtime';
import { createEphemeralWebIdentity as directIdentity } from '@101/device-web';
import { PeerDataTransport as DirectTransport } from '@101/transport-webrtc';
import { createPointerPipeline, runPointerExample } from '@101/connect/examples/pointer';
import { createSensorFeedbackPipeline, runSensorFeedbackExample } from '@101/connect/examples/sensor-feedback';
import { createTemperatureThreshold } from '@101/connect/examples/threshold';
import { createTelemetryBatchPipeline, runTelemetryBatchExample, upgradeTelemetryBatchV1 } from '@101/connect/examples/telemetry-batch';
import { createSpatialJointPipeline, runSpatialJointExample } from '@101/connect/examples/spatial-joints';
import { createRichInputPipeline, runRichInputExample } from '@101/connect/examples/rich-input';
import { runResourceDocumentExample } from '@101/connect/examples/resource-documents';
import { createAssetReference, parseAssetReference } from '@101/device-model';
import type { AssetReference } from '@101/device-model';
import { chunkResource, readVerifiedResource } from '@101/device-runtime';
import type { ResourceChunk, ResourceReadRequest } from '@101/device-runtime';
import modelSchema from '@101/device-model/schema/device-descriptor.json' with { type: 'json' };
import facadeSchema from '@101/connect/schema/device-descriptor.json' with { type: 'json' };
// @ts-expect-error Private source paths are not part of the external API.
import '@101/connect/src/index.ts';
// @ts-expect-error Compiled internals are not public package subpaths.
import '@101/transport-webrtc/dist/peer.js';
const descriptor: DeviceDescriptor = parseDeviceDescriptor({ schemaVersion: 1, id: 'external-fixture', label: 'External fixture', revision: 1, adapter: { id: 'example:fixture', version: '1.0.0' }, runtime: { platform: 'embedded' }, capabilities: [] });
const runtime: DeviceRuntime = createDeviceRuntime({ now: () => 0, clockDomain: 'external-fixture', authorize: () => undefined });
const runtimeFactory: typeof createDeviceRuntime = directRuntime;
const identityFactory: typeof createEphemeralWebIdentity = directIdentity;
const peer: PeerDataTransport = new DirectTransport({ initiator: false });
const direct: DirectTransport = new PeerDataTransport({ initiator: false });
const identity: Promise<EndpointIdentity> = identityFactory();
const invitation: ReceiverInvitation = createReceiverInvitation({ applicationId: 'fixture', sessionId: 'fixture', now: 0, randomBytes: length => new Uint8Array(length) });
async function authenticated() {
  const options: AuthenticatedPeerOptions = { transport: direct, identity: await identity, crypto: webEndpointCrypto, epoch: invitation.epoch, applicationId: invitation.applicationId, sessionId: invitation.sessionId, role: 'receiver', now: () => 0 };
  return new AuthenticatedResourcePeer(options);
}
const pointer = createPointerPipeline({ width: 500, height: 1000 });
const sensor = createSensorFeedbackPipeline({ feedback: false });
const threshold = createTemperatureThreshold({ unit: 'Cel', onAt: 30, offAt: 28, revision: 1 });
const telemetry = createTelemetryBatchPipeline({ now: () => 1000 });
const migrated = upgradeTelemetryBatchV1([{ timestamp: 1000, residentBytes: 65536 }]);
const conversionOptions: UnitConverterOptions = { decimalPlaces: 0, maxAbsoluteError: 0.51 };
const conversion: UnitConverter = createUnitConverter({ type: 'scalar', unit: 'KiBy', min: 0, max: 1000000 },
  { type: 'scalar', unit: 'By', min: 0, max: 1024000000 }, conversionOptions);
const spatialFrame: SpatialFrame = { id: 'fixture:source', origin: 'fixture:room', unit: 'm', axes: ['right', 'up', 'forward'], handedness: 'right' };
const spatialOptions: SpatialPoseConverterOptions = { decimalPlaces: 2, maxAbsoluteError: 0.01 };
const spatialConversion: SpatialPoseConverter = createSpatialPoseConverter({ type: 'pose', frame: spatialFrame, extent: 1 },
  { type: 'pose', frame: { ...spatialFrame, id: 'fixture:target', unit: 'cm' }, extent: 100 }, spatialOptions);
const spatial = createSpatialJointPipeline({ now: () => 1000 });
spatial.runtime.close();
void [runSpatialJointExample().publication, spatialConversion.metadata.unitScale];
const richInput = createRichInputPipeline({ now: () => 1000 });
richInput.runtime.close();
void runRichInputExample().events;
const resourceBytes = new TextEncoder().encode('packed');
const resourceChunks: AsyncIterable<ResourceChunk> = chunkResource(resourceBytes, 3);
async function resourceConsumer(): Promise<Readonly<AssetReference>> {
  const reference = await createAssetReference('document:packed', 'text', resourceBytes);
  const request: ResourceReadRequest = { principalId: 'owner', applicationId: 'app', sessionId: 'session', reference };
  await readVerifiedResource({ ...request, chunks: resourceChunks, signal: new AbortController().signal,
    now: () => 1000, authorize: () => ({ expiresAt: 2000, maxBytes: 100 }) });
  void runResourceDocumentExample();
  return parseAssetReference(reference);
}
void resourceConsumer;
void [telemetry.publish(migrated), telemetry.publishResidentKiBy([{ timestamp: 1000, residentKiBy: 64.5 }]),
  runTelemetryBatchExample().residentBytes, conversion.convert(64.5), parseUnitToken('KiBy')];
void [descriptor, runtime, runtimeFactory, peer, DeviceValidationError, modelSchema.$schema, facadeSchema.$schema, authenticated, pointer.publish({ x: 0, y: 1 }), runPointerExample().position, sensor.publishTemperature(31), runSensorFeedbackExample().operations, threshold.evaluate(31)];
`;

function compileConsumer() {
  const compiler = realpathSync(join(root, 'node_modules/typescript/lib/tsc.js'));
  receipt.environment.typescript = run('typescript-version', process.execPath, [compiler, '--version']).trim();
  receipt.environment.typescriptExecutable = compiler;
  writeFileSync(join(work, 'consumer.ts'), typeConsumer);
  for (const [name, module, moduleResolution] of [['nodenext', 'NodeNext', 'NodeNext'], ['bundler', 'ESNext', 'Bundler']]) {
    const config = { compilerOptions: { strict: true, skipLibCheck: false, noEmit: true, noUncheckedSideEffectImports: true, target: 'ES2022', module, moduleResolution, resolveJsonModule: true, lib: ['ES2022', 'DOM', 'DOM.Iterable'], types: [] }, files: ['consumer.ts'] };
    const path = join(work, `tsconfig.${name}.json`);
    writeFileSync(path, JSON.stringify(config, null, 2));
    run(`strict-types:${name}`, process.execPath, [compiler, '--project', path]);
    receipt.checks.push({ name: `strict-types:${name}`, status: 'pass', skipLibCheck: false, pathAliases: false, consumerCompilerInstalled: false });
  }
}

const runtimeImports = String.raw`
import * as sdk from '@101/connect';
import * as model from '@101/device-model';
import * as runtime from '@101/device-runtime';
import * as web from '@101/device-web';
import { PeerDataTransport } from '@101/transport-webrtc';
import { runPointerExample } from '@101/connect/examples/pointer';
import { runSensorFeedbackExample } from '@101/connect/examples/sensor-feedback';
import { createTemperatureThreshold } from '@101/connect/examples/threshold';
import { createTelemetryBatchPipeline, runTelemetryBatchExample, upgradeTelemetryBatchV1 } from '@101/connect/examples/telemetry-batch';
import { runSpatialJointExample } from '@101/connect/examples/spatial-joints';
import { runRichInputExample } from '@101/connect/examples/rich-input';
import { runResourceDocumentExample } from '@101/connect/examples/resource-documents';
`;

const runtimeChecks = String.raw`
function check(value, message) { if (!value) throw new Error(message); }
export async function checkRuntime() {
  check(sdk.PeerDataTransport === PeerDataTransport && sdk.createDeviceRuntime === runtime.createDeviceRuntime && sdk.createUnitConverter === model.createUnitConverter && sdk.createSpatialPoseConverter === model.createSpatialPoseConverter && sdk.createAssetReference === model.createAssetReference && sdk.readVerifiedResource === runtime.readVerifiedResource && sdk.DeviceValidationError === model.DeviceValidationError && sdk.AuthenticatedResourcePeer === web.AuthenticatedResourcePeer, 'Public facade module identity differs from direct packages');
  const conversion = model.createUnitConverter({ type: 'scalar', unit: 'K', min: 200, max: 400 },
    { type: 'scalar', unit: 'Cel', min: -100, max: 150 }, { decimalPlaces: 2, maxAbsoluteError: 0.00501 });
  check(conversion.convert(303.15) === 30 && conversion.metadata.offset === -273.15, 'Packed affine unit conversion failed');
  check(model.parseUnitToken('KiBy') === 'KiBy', 'Packed unit token validation failed');
  let malformedUnitRejected = false;
  try { model.parseUnitToken(' KiBy'); } catch { malformedUnitRejected = true; }
  check(malformedUnitRejected, 'Packed ambiguous conversion unit was accepted');
  let incompatibleRejected = false;
  try { model.createUnitConverter({ type: 'scalar', unit: 'm', min: 0, max: 1 },
    { type: 'scalar', unit: 's', min: 0, max: 1 }, { decimalPlaces: 2, maxAbsoluteError: 0.01 }); }
  catch { incompatibleRejected = true; }
  check(incompatibleRejected, 'Packed incompatible dimensions were converted');
  const spatial = runSpatialJointExample();
  check(spatial.publication && spatial.joints.wrist.position.x === -100 && spatial.joints.index.position.x === -120 && spatial.provenance?.conversion?.mirrored === true, 'Packed spatial conversion example failed');
  const richInput = runRichInputExample();
  check(richInput.events === 12 && richInput.overflow === 0 && richInput.phases[6] === 'end' && richInput.phases[7] === 'commit' && richInput.wheelDeltas.join(',') === '-120,-80', 'Packed rich input event example failed');
  const resourceDocuments = await runResourceDocumentExample();
  check(resourceDocuments.kind === 'embedded-simulated-resource' && resourceDocuments.text === 'Hello from a bounded resource.' && resourceDocuments.documentTitle === '101 resource example' && resourceDocuments.denied && resourceDocuments.corrupted && resourceDocuments.cancelled, 'Packed resource document example failed');
  const pointer = runPointerExample();
  check(pointer.kind === 'embedded-simulation' && pointer.position.x === 200 && pointer.position.y === 400 && pointer.competing.ok === false && pointer.competing.reason === 'busy' && pointer.nextOwner.ok === true && pointer.released === 1, 'Packed pointer example behavior failed');
  const feedback = runSensorFeedbackExample(), unverified = runSensorFeedbackExample({ feedback: false });
  check(feedback.temperature === 31.25 && feedback.unit === 'Cel' && feedback.commands.length === 1 && feedback.commands[0].value === true && feedback.operations[0].state === 'observed' && unverified.operations[0].state === 'unverified', 'Packed sensor feedback evidence failed');
  const threshold = createTemperatureThreshold({ unit: 'Cel', onAt: 30, offAt: 28, revision: 1 });
  check(threshold.evaluate(31) === true && threshold.evaluate(29) === undefined && threshold.evaluate(27) === false, 'Packed threshold hysteresis failed');
  const batch = runTelemetryBatchExample();
  check(batch.kind === 'embedded-fixture' && batch.publication && batch.count === 2 && batch.residentBytes === 69632 && batch.quality === 'unverified', 'Packed structured batch consumer/migration failed');
  let fixtureNow = 1000;
  const pipeline = createTelemetryBatchPipeline({ now: () => fixtureNow });
  try {
    check(pipeline.publish(upgradeTelemetryBatchV1([{ timestamp: 1000, residentBytes: 65536 }])).ok, 'Packed batch publication failed');
    pipeline.runtime.flush(); check(pipeline.state().count === 1 && pipeline.state().residentBytes === 65536, 'Packed batch sink failed');
    fixtureNow = 1100;
    check(pipeline.publishResidentKiBy([{ timestamp: fixtureNow, residentKiBy: 64.5, quality: 'observed' }]).ok, 'Packed explicit KiBy publication failed');
    pipeline.runtime.flush(); check(pipeline.state().residentBytes === 66048 && pipeline.state().provenance?.conversion?.sourceUnit === 'KiBy', 'Packed unit conversion provenance failed');
    pipeline.connection.stop(); check(pipeline.state().count === 0 && pipeline.state().released === 1, 'Packed batch release failed');
  } finally { pipeline.runtime.close(); }
  const identity = await sdk.createEphemeralWebIdentity();
  const message = new TextEncoder().encode('101 external consumer verification');
  const signature = await identity.sign(message);
  check(signature.length === 64 && await identity.isCurrent() && await sdk.webEndpointCrypto.verify(identity.publicKey, message, signature), 'Packed WebCrypto identity signing failed');
  check(!await sdk.webEndpointCrypto.verify(identity.publicKey, new TextEncoder().encode('changed fixture'), signature), 'Changed message accepted by packed WebCrypto verification');
  const now = Date.now();
  const invitation = sdk.createReceiverInvitation({ applicationId: 'external-consumer', sessionId: 'ephemeral-fixture', now, randomBytes: sdk.webEndpointCrypto.randomBytes });
  const decoded = sdk.decodeReceiverInvitation(sdk.encodeReceiverInvitation(invitation), now);
  check(decoded.epoch === invitation.epoch && sdk.receiverInvitationCurrent(decoded, now) && !sdk.receiverInvitationCurrent(decoded, decoded.expiresAt), 'Packed receiver invitation lifecycle failed');
  let expiredRejected = false;
  try { sdk.decodeReceiverInvitation(sdk.encodeReceiverInvitation(invitation), invitation.expiresAt); } catch { expiredRejected = true; }
  check(expiredRejected, 'Expired packed invitation accepted');
  const transport = new PeerDataTransport({ initiator: false });
  const authenticated = new sdk.AuthenticatedResourcePeer({ transport, identity, crypto: sdk.webEndpointCrypto, epoch: invitation.epoch, applicationId: invitation.applicationId, sessionId: invitation.sessionId, role: 'receiver', now: () => now });
  check(sdk.authenticatedPeerScope(authenticated) === undefined && web.authenticatedPeerScope(authenticated) === undefined, 'Idle transport incorrectly has authenticated provenance');
  authenticated.stop();
  await transport.disconnect();
  return { embeddedPointer: true, embeddedSensorFeedback: true, threshold: true, structuredBatch: true, explicitBatchMigration: true, explicitUnitConversion: true, explicitSpatialConversion: true, richInputEvents: true, resourceDocuments: true, moduleIdentity: true, webCryptoSignVerify: true, invitationExpiry: true, directTransportAcceptedByFacade: true, physicalWebRTC: 'not-exercised' };
}
`;

function executeNode() {
  const source = runtimeImports + String.raw`
import { readFileSync } from 'node:fs';
` + runtimeChecks + String.raw`
const summary = await checkRuntime();
const observedAt = performance.now(), residentBytes = process.memoryUsage().rss;
const memory = createTelemetryBatchPipeline({ now: () => observedAt });
try {
  check(memory.publishResidentKiBy([{ timestamp: observedAt, residentKiBy: residentBytes / 1024, quality: 'observed' }]).ok, 'Actual Node process memory conversion failed admission');
  memory.runtime.flush(); check(memory.state().residentBytes === residentBytes && memory.state().quality === 'observed', 'Actual Node memory reading lost meaning');
  memory.connection.stop(); check(memory.state().count === 0, 'Actual Node telemetry state survived stop');
  summary.actualNodeMemoryBatch = true;
} finally { memory.runtime.close(); }
const modelSchema = JSON.parse(readFileSync(new URL(import.meta.resolve('@101/device-model/schema/device-descriptor.json')), 'utf8'));
const facadeSchema = JSON.parse(readFileSync(new URL(import.meta.resolve('@101/connect/schema/device-descriptor.json')), 'utf8'));
check(JSON.stringify(modelSchema) === JSON.stringify(facadeSchema) && JSON.stringify(modelSchema) === JSON.stringify(model.DEVICE_DESCRIPTOR_SCHEMA), 'Public packed schema assets differ from runtime schema');
for (const name of ['@101/device-model', '@101/device-runtime', '@101/transport-webrtc', '@101/device-web', '@101/connect']) {
  check(import.meta.resolve(name).endsWith('/dist/index.js'), 'Package root does not resolve to JavaScript');
  for (const suffix of ['/src/index.ts', '/dist/index.js', '/package.json']) {
    let rejected = false;
    try { await import(name + suffix); } catch (error) { rejected = error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'; }
    check(rejected, 'Private package subpath was not rejected: ' + name + suffix);
  }
}
const print = console.log;
let entryResult;
try { console.log = value => { entryResult = JSON.parse(value); }; await import('@101/connect/examples/run'); }
finally { console.log = print; }
check(entryResult?.pointer?.position?.x === 200 && entryResult?.sensorWithFeedback?.operations?.[0]?.state === 'observed' && entryResult?.sensorWithoutFeedback?.operations?.[0]?.state === 'unverified' && entryResult?.spatialJoints?.joints?.wrist?.position?.x === -100 && entryResult?.richInput?.events === 12 && entryResult?.resourceDocuments?.cancelled === true, 'Packed examples/run entry failed');
console.log(JSON.stringify({ ...summary, publicSchemas: true, privateSubpathsRejected: 15, packedRunEntry: true }));
`;
  const path = join(work, 'runtime-check.mjs');
  writeFileSync(path, source);
  const result = JSON.parse(run('packed-node-javascript', process.execPath, ['--no-experimental-strip-types', path]).trim());
  receipt.checks.push({ name: 'packed-node-javascript', status: 'pass', ...result });
}

async function executeBrowsers(installed) {
  const importMap = {};
  const served = new Map();
  for (const [name, item] of installed) {
    const base = `/packages/${name.slice('@101/'.length)}/`;
    for (const [subpath, target] of Object.entries(item.pkg.exports)) {
      const runtimeTarget = typeof target === 'string' ? target : target.import ?? target.default;
      importMap[name + (subpath === '.' ? '' : subpath.slice(1))] = base + runtimeTarget.slice(2);
    }
    for (const file of item.files.filter(file => /\.(js|json)$/.test(file.path))) {
      served.set(base + file.path, { path: join(item.directory, file.path), contentType: file.path.endsWith('.js') ? 'text/javascript' : 'application/json' });
    }
  }
  const fixture = runtimeImports + runtimeChecks + String.raw`
export async function checkBrowser() {
  check(globalThis.isSecureContext && !!globalThis.crypto?.subtle, 'Loopback browser WebCrypto is unavailable');
  const summary = await checkRuntime();
  for (const name of ['@101/connect/src/index.ts', '@101/transport-webrtc/dist/peer.js']) {
    let rejected = false;
    try { await import(name); } catch { rejected = true; }
    check(rejected, 'Private browser package subpath resolved');
  }
  const responses = await Promise.all([fetch('/packages/device-model/schema/device-descriptor.json'), fetch('/packages/connect/schema/device-descriptor.json')]);
  check(responses.every(response => response.ok), 'Packed browser schema asset request failed');
  const schemas = await Promise.all(responses.map(response => response.json()));
  check(JSON.stringify(schemas[0]) === JSON.stringify(schemas[1]) && schemas[0].$schema === model.DEVICE_DESCRIPTOR_SCHEMA.$schema, 'Packed browser schemas differ');
  const store = sdk.createWebCryptoIdentityStore();
  try {
    const persistent = await store.create(), loaded = await store.load();
    check(loaded?.keyId === persistent.keyId && await loaded.isCurrent(), 'Browser identity persistence roundtrip failed');
    const message = new TextEncoder().encode('101 stored external consumer verification');
    check(await sdk.webEndpointCrypto.verify(loaded.publicKey, message, await loaded.sign(message)), 'Stored browser identity signature failed');
    await store.remove(persistent.keyId);
    check(!await persistent.isCurrent() && await store.load() === undefined, 'Removed browser identity stayed current');
  } finally { store.close(); }
  return { ...summary, publicSchemas: true, privateSubpathsRejected: 2, indexedDBIdentityLifecycle: true };
}
`;
  writeFileSync(join(work, 'browser-check.mjs'), fixture);
  writeFileSync(join(work, 'browser-import-map.json'), JSON.stringify({ imports: importMap }, null, 2));
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Local SDK consumer verification</title><script type="importmap">${JSON.stringify({ imports: importMap })}</script></head><body>Local SDK consumer verification</body></html>`;
  const server = createServer((request, response) => {
    const remote = request.socket.remoteAddress;
    if (remote !== '127.0.0.1' && remote !== '::ffff:127.0.0.1' || request.method !== 'GET') {
      response.writeHead(403).end(); return;
    }
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (path === '/') response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
    else if (path === '/favicon.ico') response.writeHead(204).end();
    else if (path === '/browser-check.mjs') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(fixture);
    else if (served.has(path)) {
      const file = served.get(path);
      response.writeHead(200, { 'Content-Type': file.contentType }).end(readFileSync(file.path));
    } else response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseURL = `http://127.0.0.1:${address.port}`;
  receipt.browserServer = { owned: true, bind: '127.0.0.1', port: address.port, installedPackageFilesOnly: true, closed: false };
  let engines;
  try {
    engines = await import('playwright');
    receipt.environment.playwright = JSON.parse(readFileSync(join(root, 'node_modules/playwright/package.json'), 'utf8')).version;
    const results = [];
    for (const name of ['chromium', 'firefox', 'webkit']) {
      let browser, context;
      const errors = [];
      try {
        browser = await engines[name].launch({ headless: true, timeout: 30000 });
        context = await browser.newContext();
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(redact(error.message)));
        page.on('console', message => { if (message.type() === 'error') errors.push(redact(message.text())); });
        await page.route('**/*', route => {
          const url = new URL(route.request().url());
          if (url.origin !== baseURL) return route.abort('blockedbyclient');
          return route.continue();
        });
        const response = await page.goto(baseURL, { waitUntil: 'load', timeout: 30000 });
        assert.equal(response?.status(), 200);
        const summary = await page.evaluate(async () => {
          const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Packed browser runtime check timed out')), 30000));
          return Promise.race([import('/browser-check.mjs').then(module => module.checkBrowser()), timeout]);
        });
        assert.deepEqual(errors, [], 'Browser produced errors');
        results.push({ name: `packed-browser:${name}`, status: 'pass', version: browser.version(), ...summary });
      } catch (error) {
        results.push({ name: `packed-browser:${name}`, status: 'fail', version: browser?.version(), failure: { name: error.name, message: redact(error.message) }, errors });
      } finally {
        await context?.close();
        await browser?.close();
      }
    }
    receipt.checks.push(...results);
    assert.ok(results.every(result => result.status === 'pass'), `Packed browser qualification failed: ${results.filter(result => result.status !== 'pass').map(result => result.name).join(', ')}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    receipt.browserServer.closed = true;
  }
}

async function distribution(path) {
  const manifest = sourceBoundManifest(path);
  const installed = installAndAudit(manifest);
  compileConsumer();
  executeNode();
  await executeBrowsers(installed);
}

function baseline() {
  receipt.source = { revision: run('baseline-revision', 'git', ['rev-parse', 'HEAD'], root).trim(), tree: run('baseline-tree', 'git', ['rev-parse', 'HEAD^{tree}'], root).trim() };
  receipt.environment.npm = run('npm-version', 'npm', ['--version']).trim();
  const tarballs = names.map(name => {
    const directory = join(root, 'packages', name.slice('@101/'.length));
    const packed = JSON.parse(run(`baseline-pack:${name}`, 'npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', work], directory));
    assert.equal(packed.length, 1);
    const tarball = join(work, packed[0].filename);
    return { name, version: packed[0].version, tarball, sha256: hash(tarball) };
  });
  receipt.packages = tarballs;
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: '101-sdk-external-consumer', private: true, type: 'module' }, null, 2));
  run('baseline-offline-install', 'npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs.map(item => item.tarball)]);
  receipt.checks.push({ name: 'baseline-offline-install', status: 'pass' });
  run('baseline-no-typescript-runtime', process.execPath, ['--no-experimental-strip-types', '--input-type=module', '-e', "await import('@101/connect');"]);
  receipt.checks.push({ name: 'baseline-no-typescript-runtime', status: 'pass' });
}

try {
  assert.ok(input && process.argv.length === 3, 'Usage: node tools/qa-sdk-consumer.mjs <manifest.json|--baseline>');
  if (input === '--baseline') baseline();
  else await distribution(input);
  receipt.status = 'pass';
} catch (error) {
  receipt.status = 'fail';
  receipt.failure = { name: error.name, message: redact(error.message) };
  process.exitCode = 1;
} finally {
  receipt.finishedAt = new Date().toISOString();
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  writeFileSync(join(work, 'commands.json'), JSON.stringify(logs, null, 2) + '\n');
  console.log(JSON.stringify({ status: receipt.status, receipt: receiptPath, failure: receipt.failure }));
}
