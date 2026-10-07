/** Fixed reviewed local software consumer. No install, process, capture or route starts on import. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDeviceScaffold } from '@101/connect/examples/device-scaffold';
import { createDeviceRuntime, createProcessorRegistry, parseDeviceDescriptor, parseProcessorManifest,
  parseRecipe, resolveRecipe } from '@101/connect';

export const ONBOARDING_LIMITS = Object.freeze({
  projects: 1, concurrentRuns: 1, stages: 6, childStarts: 12, rawChildren: 1,
  runtimeRoutes: 2, runtimeRegistrations: 4, effects: 16, generatedFiles: 32,
  generatedSourceBytes: 262144, receiptBytes: 16384, childLifetimeMs: 120000,
});
const assets = ['package.json', 'tsconfig.json', 'src/devices.json', 'src/recipe.json',
  'src/connector.ts', 'src/processor.ts', 'processor.manifest.json', 'scripts/validate.mjs'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
let running = false;
function fail(code) { throw new Error(code); }
function plain(input, fields) {
  if (!input || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) fail('onboarding-options');
  const descriptors = Object.getOwnPropertyDescriptors(input), output = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !fields.includes(key) || !Object.hasOwn(descriptors[key], 'value')) fail('onboarding-options');
    output[key] = descriptors[key].value;
  }
  return output;
}
function choose(input, fields) {
  const chosen = plain(input, fields);
  // The exact factory validates the project ID; declarations do not select executable paths.
  const expected = createDeviceScaffold({ id: chosen.id });
  if (typeof chosen.directory !== 'string' || !isAbsolute(chosen.directory) || chosen.directory.length > 4096 ||
      chosen.directory.includes('\0')) fail('onboarding-directory');
  const revision = chosen.revision ?? 'base';
  if (!['base', 'strict-threshold'].includes(revision)) fail('onboarding-revision');
  return { chosen, expected, revision };
}
async function readBounded(directory, path, remaining = ONBOARDING_LIMITS.generatedSourceBytes) {
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) fail('onboarding-assets');
  const parts = path.split('/');
  if (parts.length > 1) {
    const parent = await lstat(join(directory, parts[0]));
    if (!parent.isDirectory() || parent.isSymbolicLink()) fail('onboarding-assets');
  }
  const file = join(directory, path), before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) fail('onboarding-assets');
  if (before.size > remaining) fail('onboarding-source-bytes');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const facts = await handle.stat();
    if (facts.dev !== before.dev || facts.ino !== before.ino) fail('onboarding-assets');
    const buffer = Buffer.alloc(remaining + 1); let bytes = 0;
    for (let work = 0; work < 32; work++) {
      const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      bytes += read.bytesRead;
      if (bytes > remaining) fail('onboarding-source-bytes');
      if (read.bytesRead === 0) return buffer.subarray(0, bytes);
    }
    fail('onboarding-source-bytes');
  } finally { await handle.close(); }
}
function reviewedPackage(bytes, expected) {
  if (digest(bytes) === digest(expected)) return;
  const installed = JSON.parse(bytes), baseline = JSON.parse(expected);
  const { dependencies, devDependencies, ...metadata } = installed;
  delete baseline.dependencies; delete baseline.devDependencies;
  if (JSON.stringify(metadata) !== JSON.stringify(baseline)) fail('onboarding-assets');
  const names = ['@101/connect', '@101/device-model', '@101/device-runtime', '@101/device-web',
    '@101/transport-webrtc', '@101/transport-websocket', '@101/vision'];
  const localTarball = value => typeof value === 'string' && value.length <= 4096 && /^file:[^\0\r\n]+\.tgz$/.test(value);
  if (!dependencies || Object.keys(dependencies).sort().join('\0') !== names.join('\0') ||
      !Object.values(dependencies).every(localTarball) || !devDependencies ||
      Object.keys(devDependencies).join('\0') !== 'typescript' || !localTarball(devDependencies.typescript)) fail('onboarding-assets');
  // These inert local install paths do not establish trust in installed code.
  // The host separately binds the actual SDK/compiler bytes before execution.
}
async function reviewed(input) {
  const { chosen, expected, revision } = choose(input, ['id', 'directory', 'revision']);
  const files = {};
  let remaining = ONBOARDING_LIMITS.generatedSourceBytes;
  try {
    for (const path of assets) { files[path] = await readBounded(chosen.directory, path, remaining); remaining -= files[path].length; }
    const source = expected['src/processor.ts'];
    const reviewedSource = revision === 'base' ? source : source.replace('temperature >= onAt', 'temperature > onAt');
    if (digest(files['src/processor.ts']) !== digest(reviewedSource)) fail('onboarding-source-pin');
    const expectedManifest = JSON.parse(expected['processor.manifest.json']);
    if (revision === 'strict-threshold') { expectedManifest.version = '1.0.1'; expectedManifest.codeSha256 = digest(reviewedSource); }
    const manifest = parseProcessorManifest(JSON.parse(files['processor.manifest.json']));
    if (JSON.stringify(manifest) !== JSON.stringify(parseProcessorManifest(expectedManifest))) fail('onboarding-source-pin');
    const declarations = JSON.parse(files['src/devices.json']);
    if (!Array.isArray(declarations) || declarations.length !== 2) fail('onboarding-assets');
    const devices = declarations.map(parseDeviceDescriptor);
    const recipe = parseRecipe(JSON.parse(files['src/recipe.json']));
    const baseline = JSON.parse(expected['src/devices.json']).map(parseDeviceDescriptor);
    if (JSON.stringify(devices) !== JSON.stringify(baseline) ||
        JSON.stringify(recipe) !== JSON.stringify(parseRecipe(JSON.parse(expected['src/recipe.json'])))) fail('onboarding-assets');
    reviewedPackage(files['package.json'], expected['package.json']);
    for (const path of ['src/connector.ts', 'scripts/validate.mjs', 'tsconfig.json'])
      if (digest(files[path]) !== digest(expected[path])) fail('onboarding-assets');
    const resolution = resolveRecipe(recipe, { devices, processors: [manifest], selections: {
      sensor: { deviceId: `${chosen.id}-sensor`, capability: 'temperature' },
      display: { deviceId: `${chosen.id}-display`, capability: 'temperature' },
    } });
    if (!resolution.ok) fail('onboarding-assets');
    const requiredOperations = resolution.value.requiredOperations.map(item => item.operation);
    if (requiredOperations.join('\0') !== 'subscribe\0write') fail('onboarding-assets');
    return { files, manifest, devices, chosen, summary: Object.freeze({ id: chosen.id, revision,
      sourceSha256: digest(files['src/processor.ts']), processorId: manifest.id, processorVersion: manifest.version,
      requiredOperations: Object.freeze(requiredOperations) }) };
  } catch (error) {
    if (['onboarding-source-pin', 'onboarding-source-bytes'].includes(error.message)) throw error;
    fail('onboarding-assets');
  }
}

/** Bounded inert declaration/source review. A successful review contains no operation grant. */
export async function reviewOnboardingProject(input) { return (await reviewed(input)).summary; }

/** Explicit current software action; each call registers a new runtime/route and finally retires it. */
export async function runOnboardingExample(input) {
  if (running) fail('onboarding-busy');
  running = true;
  let runtime, route, processor, reading, beforeStop, released = 0, effects = 0, factoryCalls = 0, denied = false;
  try {
    const options = plain(input, ['id', 'directory', 'revision', 'compiledSha256', 'mode', 'sample']);
    const project = await reviewed({ id: options.id, directory: options.directory, revision: options.revision });
    const mode = options.mode ?? 'denied';
    if (!['approved', 'denied'].includes(mode)) fail('onboarding-mode');
    if (typeof options.sample !== 'number' || !Number.isFinite(options.sample) || options.sample < -40 || options.sample > 125) fail('onboarding-sample');
    const compiled = plain(options.compiledSha256, ['sourceSha256', 'manifestSha256', 'connector.js', 'processor.js']);
    if (Object.keys(compiled).length !== 4 || Object.values(compiled).some(value => typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) ||
        compiled.sourceSha256 !== project.summary.sourceSha256 || compiled.manifestSha256 !== digest(project.files['processor.manifest.json'])) fail('onboarding-compiled-pin');
    const connectorBytes = await readBounded(join(options.directory, 'dist'), 'connector.js');
    const processorBytes = await readBounded(join(options.directory, 'dist'), 'processor.js');
    if (digest(connectorBytes) !== compiled['connector.js'] || digest(processorBytes) !== compiled['processor.js']) fail('onboarding-compiled-pin');
    for (const name of ['devices.json', 'recipe.json']) {
      const emitted = await readBounded(join(options.directory, 'dist'), name);
      if (JSON.stringify(JSON.parse(emitted)) !== JSON.stringify(JSON.parse(project.files[`src/${name}`]))) fail('onboarding-compiled-pin');
    }
    // Exact source bytes and these output digests are a trusted host/compiler binding, not permission from a manifest.
    const connector = await import(pathToFileURL(join(options.directory, 'dist/connector.js')).href + `?pin=${compiled['connector.js']}`);
    const implementation = await import(pathToFileURL(join(options.directory, 'dist/processor.js')).href + `?pin=${compiled['processor.js']}`);
    if (typeof connector.isAuthorizedRequest !== 'function' || typeof implementation.createThreshold !== 'function') fail('onboarding-compiled-pin');
    const unchanged = await reviewed({ id: options.id, directory: options.directory, revision: options.revision });
    if (unchanged.summary.sourceSha256 !== project.summary.sourceSha256 ||
        digest(unchanged.files['processor.manifest.json']) !== compiled.manifestSha256) fail('onboarding-source-pin');
    let source, sink;
    const now = () => performance.now();
    const deadline = now() + 10000;
    runtime = createDeviceRuntime({ now, clockDomain: `onboarding-js:${process.pid}:${randomUUID()}`,
      maxRoutes: ONBOARDING_LIMITS.runtimeRoutes, maxRegistrations: ONBOARDING_LIMITS.runtimeRegistrations,
      maxPendingDeliveries: 1,
      authorize(request) {
        if (mode !== 'approved' || !connector.isAuthorizedRequest(request, source?.id, sink?.id)) return undefined;
        return { expiresAt: deadline, maxAgeMs: 1000, maxHz: 10 };
      },
    });
    source = runtime.registerSource({ device: project.devices[0], capability: 'temperature' });
    sink = runtime.registerSink({ device: project.devices[1], capability: 'temperature',
      apply(observation, context) {
        if (context.signal.aborted || !context.isCurrent()) return;
        if (effects >= ONBOARDING_LIMITS.effects || typeof observation.value !== 'number') fail('onboarding-effect');
        reading = observation.value; effects++;
      }, release() { reading = undefined; released++; },
    });
    for (const handle of [source, sink]) if (!runtime.setReadiness(handle, 'available').ok) fail('onboarding-readiness');
    route = runtime.route({ from: source, to: sink, principalId: 'owner', applicationId: options.id,
      sessionId: 'demo', sourceOperation: 'subscribe', leaseMs: 10000 });
    const started = route.start();
    if (!started.ok) {
      if (started.reason !== 'denied' || mode !== 'denied') fail('onboarding-route');
      denied = true;
    } else {
      const registry = createProcessorRegistry();
      await registry.registerTrusted({ manifest: project.manifest, source: project.files['src/processor.ts'],
        factory: configuration => { factoryCalls++; return implementation.createThreshold(configuration); } });
      if (!route.limits() || route.status().state !== 'active') fail('onboarding-route');
      processor = registry.resolve({ id: project.manifest.id, version: project.manifest.version,
        codeSha256: project.manifest.codeSha256, configuration: { onAt: 30, offAt: 28 } });
      const admitted = runtime.publish(source, options.sample);
      if (!admitted.ok || admitted.value.accepted !== 1) fail('onboarding-publication');
      runtime.flush();
      if (reading === undefined || effects !== 1) fail('onboarding-effect');
      const result = processor.process({ temperature: reading });
      if (typeof result?.switch !== 'boolean') fail('onboarding-effect');
      beforeStop = { reading, switchOn: result.switch };
    }
  } finally {
    try {
      if (processor) processor.reset();
    } finally {
      if (route) { route.stop('tutorial-stop'); if (route.whenSettled) await route.whenSettled(); }
      if (runtime) runtime.close();
      running = false;
    }
  }
  return Object.freeze({ ...(beforeStop ?? {}), denied, effects, factoryCalls,
    afterStop: Object.freeze({ hasReading: reading !== undefined, released }),
    routesClosed: route?.status().state === 'closed', runtimeClosed: true,
    meaning: 'Authored local Celsius/display/threshold software effect; no physical sensor, actuator or recovered authority.' });
}
