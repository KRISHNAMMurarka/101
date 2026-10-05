import { createHash } from 'node:crypto';

export interface DeviceScaffoldOptions { readonly id: string }

/** Files for a standalone, local-first SDK project. The caller must write them to a new directory. */
export function createDeviceScaffold(options: DeviceScaffoldOptions): Readonly<Record<string, string>> {
  const id = options.id;
  if (typeof id !== 'string' || id.length > 64 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id))
    throw new Error('Device project id must be lowercase kebab-case');

  const processor = `/** Reviewed local processor source; its exact bytes are pinned in processor.manifest.json. */
export function createThreshold(configuration: unknown) {
  if (configuration === null || typeof configuration !== 'object' ||
      !('onAt' in configuration) || !('offAt' in configuration) ||
      typeof configuration.onAt !== 'number' || typeof configuration.offAt !== 'number' ||
      !Number.isFinite(configuration.onAt) || !Number.isFinite(configuration.offAt) ||
      configuration.offAt >= configuration.onAt) throw new TypeError('Invalid threshold configuration');
  const { onAt, offAt } = configuration;
  let active = false;
  return {
    process(inputs: Readonly<Record<string, unknown>>) {
      const temperature = inputs.temperature;
      if (typeof temperature !== 'number' || !Number.isFinite(temperature))
        throw new TypeError('Expected a finite temperature');
      if (temperature >= onAt) active = true;
      else if (temperature <= offAt) active = false;
      return { switch: active };
    },
    reset() { active = false; },
  };
}
`;
  const scalar = { type: 'scalar', unit: 'Cel', min: -40, max: 125 };
  const manifest = {
    schemaVersion: 1, id: `${id}:threshold`, version: '1.0.0',
    codeSha256: createHash('sha256').update(processor).digest('hex'),
    inputs: [{ id: 'temperature', value: scalar }],
    outputs: [{ id: 'switch', value: { type: 'boolean' } }],
    configuration: { type: 'record', fields: {
      onAt: scalar, offAt: scalar,
    } },
    state: { mode: 'resettable', resetOn: ['input-loss', 'stop', 'reconfigure'] },
    assets: [], license: 'MIT',
    budgets: { maxComputeMs: 5, maxMemoryBytes: 65536, privacy: 'local-only' },
  };
  const value = { type: 'scalar', unit: 'Cel', min: -40, max: 125 };
  const devices = [
    {
      schemaVersion: 1, id: `${id}-sensor`, label: 'Local sensor', revision: 1,
      adapter: { id: `${id}:sensor`, version: '1.0.0' }, runtime: { platform: 'embedded-simulation' },
      capabilities: [{ id: 'temperature', semantic: `${id}:temperature`, schemaVersion: 1,
        kind: 'sample', value, delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 1000 }, permissions: ['subscribe'] }],
    },
    {
      schemaVersion: 1, id: `${id}-display`, label: 'Local display', revision: 1,
      adapter: { id: `${id}:display`, version: '1.0.0' }, runtime: { platform: 'embedded-simulation' },
      capabilities: [{ id: 'temperature', semantic: `${id}:temperature`, schemaVersion: 1,
        kind: 'property', value, delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 1000 },
        permissions: ['write'], ownership: { mode: 'exclusive' } }],
    },
  ];
  const recipe = {
    schemaVersion: 1, id: `${id}:temperature-display`, version: '1.0.0',
    resources: [
      { id: 'sensor', direction: 'source', semantic: `${id}:temperature`, schemaVersion: 1, required: true },
      { id: 'display', direction: 'sink', semantic: `${id}:temperature`, schemaVersion: 1, required: true },
    ], processors: [],
    routes: [{ id: 'show-temperature', from: { node: 'sensor', port: 'value' },
      to: { node: 'display', port: 'value' }, required: true }],
    permissions: [
      { route: 'show-temperature', side: 'from', operation: 'subscribe', owner: 'required', purpose: 'Read local temperature' },
      { route: 'show-temperature', side: 'to', operation: 'write', owner: 'required', purpose: 'Display local temperature' },
    ],
    styles: [{ id: 'default', tone: 'normal', density: 'comfortable' }],
    surfaces: [{ id: 'temperature', title: 'Temperature', components: [
      { id: 'current', kind: 'value', label: 'Temperature', from: { node: 'sensor', port: 'value' }, style: 'default' },
    ] }],
  };
  const guidance = {
    schemaVersion: 1,
    project: { id, runtime: 'Node.js >=22.13.0', package: `${id}-device-project`, dependency: { name: '@101/connect', version: '0.1.0' } },
    files: [
      { path: 'src/devices.json', role: 'Inert source and display device descriptors', validators: ['parseDeviceDescriptor'], schemaReference: '@101/connect/schema/device-descriptor.json' },
      { path: 'src/recipe.json', role: 'Inert connector route, required owner permissions, display style, and surface', validators: ['parseRecipe', 'resolveRecipe'] },
      { path: 'processor.manifest.json', role: 'Pinned threshold processor contract', validators: ['parseProcessorManifest'] },
      { path: 'src/processor.ts', role: 'Reviewed threshold processor source pinned by the manifest hash' },
      { path: 'src/connector.ts', role: 'Host-side demonstration connector with fixed identity and registration checks' },
      { path: 'scripts/validate.mjs', role: 'Validates fixed asset paths, recipe resolution, and processor source pin' },
    ],
    validatorContracts: {
      parseDeviceDescriptor: 'Validates descriptor shape and capabilities.',
      parseRecipe: 'Validates the inert recipe declaration.',
      resolveRecipe: 'Checks the explicitly selected descriptors and available processor manifests; it does not grant access.',
      parseProcessorManifest: 'Validates the pinned processor manifest contract.',
    },
    commands: [
      { name: 'validate', command: 'npm run validate', purpose: 'Validate generated descriptors, recipe resolution, and processor source pin' },
      { name: 'build', command: 'npm run build', purpose: 'Compile TypeScript source' },
      { name: 'test', command: 'npm test', purpose: 'Build and run local consumer tests' },
      { name: 'run', command: 'npm start', purpose: 'Run the local demonstration' },
    ],
    trustBoundary: [
      'This file contains explanatory data only and is never read for authorization or executed as code or commands.',
      'Descriptor, recipe, and manifest strings are untrusted declarations until validated by their runtime parser.',
      'Recipe permissions describe requested owner operations; only the host runtime authorization callback grants a route.',
    ],
  };
  const guidanceSchema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: '101 device project guidance', type: 'object', additionalProperties: false,
    required: ['schemaVersion', 'project', 'files', 'validatorContracts', 'commands', 'trustBoundary'],
    properties: {
      schemaVersion: { const: 1 },
      project: { type: 'object', additionalProperties: false, required: ['id', 'runtime', 'package', 'dependency'],
        properties: { id: { type: 'string' }, runtime: { type: 'string' }, package: { type: 'string' },
          dependency: { type: 'object', additionalProperties: false, required: ['name', 'version'],
            properties: { name: { type: 'string' }, version: { type: 'string' } } } } },
      files: { type: 'array', items: { type: 'object', additionalProperties: false,
        required: ['path', 'role'], properties: { path: { type: 'string' }, role: { type: 'string' },
          validators: { type: 'array', items: { type: 'string' } }, schemaReference: { type: 'string' } } } },
      validatorContracts: { type: 'object', additionalProperties: false, required: [
        'parseDeviceDescriptor', 'parseRecipe', 'resolveRecipe', 'parseProcessorManifest' ],
        properties: { parseDeviceDescriptor: { type: 'string' }, parseRecipe: { type: 'string' },
          resolveRecipe: { type: 'string' }, parseProcessorManifest: { type: 'string' } } },
      commands: { type: 'array', items: { type: 'object', additionalProperties: false,
        required: ['name', 'command', 'purpose'], properties: { name: { type: 'string' },
          command: { type: 'string' }, purpose: { type: 'string' } } } },
      trustBoundary: { type: 'array', items: { type: 'string' } },
    },
  };
  const validator = `import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseDeviceDescriptor, parseProcessorManifest, parseRecipe, resolveRecipe } from '@101/connect';
import devicesInput from '../src/devices.json' with { type: 'json' };
import recipeInput from '../src/recipe.json' with { type: 'json' };

const readJson = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const devices = devicesInput.map(parseDeviceDescriptor);
const recipe = parseRecipe(recipeInput);
const manifest = parseProcessorManifest(readJson('../processor.manifest.json'));
const resolution = resolveRecipe(recipe, {
  devices, processors: [manifest],
  selections: {
    sensor: { deviceId: '${id}-sensor', capability: 'temperature' },
    display: { deviceId: '${id}-display', capability: 'temperature' },
  },
});
assert.equal(resolution.ok, true, 'generated route must resolve with its explicit local selections');
assert.deepEqual(resolution.value.requiredOperations.map(item => item.operation), ['subscribe', 'write']);
assert.deepEqual(recipe.permissions.map(item => item.owner), ['required', 'required']);
const source = readFileSync(new URL('../src/processor.ts', import.meta.url));
assert.equal(manifest.codeSha256, createHash('sha256').update(source).digest('hex'), 'processor source pin must match');
console.log(JSON.stringify({ status: 'pass', recipeId: recipe.id, processorId: manifest.id, processorPin: manifest.codeSha256 }));
`;
  const connector = `import devicesInput from './devices.json' with { type: 'json' };
import recipeInput from './recipe.json' with { type: 'json' };
import { createDeviceRuntime, parseDeviceDescriptor, parseRecipe, resolveRecipe } from '@101/connect';

const devices = devicesInput.map(parseDeviceDescriptor);
const recipe = parseRecipe(recipeInput);
const selections = {
  sensor: { deviceId: '${id}-sensor', capability: 'temperature' },
  display: { deviceId: '${id}-display', capability: 'temperature' },
};
const resolution = resolveRecipe(recipe, { devices, processors: [], selections });
if (!resolution.ok) throw new Error('Device recipe did not resolve');
const resolvedRoute = resolution.value.routes[0];
if (!resolvedRoute || resolvedRoute.id !== 'show-temperature') throw new Error('Device recipe has no display route');
const sourceResource = resolution.value.resources.find(item => item.id === resolvedRoute.from.node);
const sinkResource = resolution.value.resources.find(item => item.id === resolvedRoute.to.node);
if (!sourceResource || !sinkResource) throw new Error('Resolved route endpoints are incomplete');
const sourceEndpoint = { device: sourceResource.device, capability: sourceResource.capability };
const sinkEndpoint = { device: sinkResource.device, capability: sinkResource.capability };

export function isAuthorizedRequest(request: {
  principalId: string; applicationId: string; sessionId: string;
  source: { registrationId: string }; sink: { registrationId: string };
  sourceOperation: string; sinkOperation: string;
}, sourceId: string | undefined, sinkId: string | undefined): boolean {
  return request.principalId === 'owner' && request.applicationId === '${id}' && request.sessionId === 'demo' &&
    sourceId !== undefined && sinkId !== undefined && request.source.registrationId === sourceId &&
    request.sink.registrationId === sinkId && request.sourceOperation === 'subscribe' && request.sinkOperation === 'write';
}

export function createConnector() {
  let sourceId: string | undefined, sinkId: string | undefined;
  let reading: number | undefined, released = 0;
  const runtime = createDeviceRuntime({
    now: () => 0, clockDomain: 'local-demo',
    authorize(request) {
      if (!isAuthorizedRequest(request, sourceId, sinkId)) return undefined;
      return { expiresAt: 10000, maxAgeMs: 1000, maxHz: 10 };
    },
  });
  const source = runtime.registerSource(sourceEndpoint);
  const sink = runtime.registerSink({
    device: sinkEndpoint.device, capability: sinkEndpoint.capability,
    apply(observation, context) {
      if (context.signal.aborted || !context.isCurrent()) return;
      if (typeof observation.value !== 'number') throw new TypeError('Expected Celsius');
      reading = observation.value;
    },
    release() { reading = undefined; released += 1; },
  });
  sourceId = source.id; sinkId = sink.id;
  runtime.setReadiness(source, 'available');
  runtime.setReadiness(sink, 'available');
  const route = runtime.route({ from: source, to: sink, principalId: 'owner',
    applicationId: '${id}', sessionId: 'demo', sourceOperation: 'subscribe' });
  const started = route.start();
  if (!started.ok) { runtime.close(); throw new Error('Connector route did not start'); }
  return {
    publish(temperature: number) {
      const result = runtime.publish(source, temperature);
      if (!result.ok || result.value.accepted !== 1) throw new Error('Temperature was not admitted');
      runtime.flush();
    },
    state() { return { reading, released }; },
    stop() { route.stop('project-stop'); runtime.close(); },
  };
}
`;
  const caller = `import { readFileSync } from 'node:fs';
import { createProcessorRegistry, parseProcessorManifest } from '@101/connect';
import { createConnector } from '../dist/connector.js';
import { createThreshold } from '../dist/processor.js';

const source = new URL('./processor.ts', import.meta.url);
const manifest = parseProcessorManifest(JSON.parse(readFileSync(
  new URL('../processor.manifest.json', import.meta.url), 'utf8')));

export async function runProject() {
  const registry = createProcessorRegistry();
  await registry.registerTrusted({
    manifest, source: readFileSync(source),
    factory: configuration => createThreshold(configuration),
  });
  const processor = registry.resolve({
    id: manifest.id, version: manifest.version, codeSha256: manifest.codeSha256,
    configuration: { onAt: 30, offAt: 28 },
  });
  const connector = createConnector();
  try {
    connector.publish(31);
    const reading = connector.state().reading;
    if (reading === undefined) throw new Error('No sensor reading');
    const output = processor.process({ temperature: reading });
    if (typeof output?.switch !== 'boolean') throw new Error('Processor produced no switch');
    return { reading, switchOn: output.switch };
  } finally {
    processor.reset();
    connector.stop();
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  console.log(JSON.stringify(await runProject()));
}
`;
  const test = `import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { parseDeviceDescriptor, parseProcessorManifest, parseRecipe, resolveRecipe } from '@101/connect';
import { runProject } from '../src/index.mjs';
import { createConnector, isAuthorizedRequest } from '../dist/connector.js';

test('manifest pins the exact reviewed processor source', () => {
  const manifest = JSON.parse(readFileSync(new URL('../processor.manifest.json', import.meta.url), 'utf8'));
  const source = readFileSync(new URL('../src/processor.ts', import.meta.url));
  assert.equal(manifest.codeSha256, createHash('sha256').update(source).digest('hex'));
  assert.doesNotThrow(() => parseProcessorManifest({ ...manifest, codeSha256: 'b'.repeat(64) }));
});

test('asset validator rejects a changed processor source pin', () => {
  const path = new URL('../processor.manifest.json', import.meta.url);
  const original = readFileSync(path, 'utf8');
  try {
    const manifest = JSON.parse(original);
    manifest.codeSha256 = 'b'.repeat(64);
    writeFileSync(path, JSON.stringify(manifest));
    const result = spawnSync(process.execPath, ['scripts/validate.mjs'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
  } finally { writeFileSync(path, original); }
});

test('complete descriptor and recipe assets validate and resolve explicitly', () => {
  const devices = JSON.parse(readFileSync(new URL('../src/devices.json', import.meta.url), 'utf8'));
  const recipe = JSON.parse(readFileSync(new URL('../src/recipe.json', import.meta.url), 'utf8'));
  assert.equal(parseDeviceDescriptor(devices[0]).id, '${id}-sensor');
  assert.equal(parseDeviceDescriptor(devices[1]).id, '${id}-display');
  assert.throws(() => parseDeviceDescriptor({ ...devices[0], unexpected: true }));
  assert.throws(() => parseRecipe({ ...recipe, unexpected: true }));
  assert.equal(parseRecipe(recipe).surfaces[0].components[0].style, 'default');
  const result = resolveRecipe(recipe, { devices, processors: [], selections: {
    sensor: { deviceId: '${id}-sensor', capability: 'temperature' },
    display: { deviceId: '${id}-display', capability: 'temperature' },
  } });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value.requiredOperations.map(item => item.operation), ['subscribe', 'write']);
});

test('local connector and processor run through the SDK and release', async () => {
  assert.deepEqual(await runProject(), { reading: 31, switchOn: true });
  const connector = createConnector();
  connector.publish(31);
  assert.equal(connector.state().reading, 31);
  connector.stop();
  assert.deepEqual(connector.state(), { reading: undefined, released: 1 });
});

test('guidance is inert data and cannot execute or broaden host authorization', () => {
  const path = new URL('../device-guidance.json', import.meta.url);
  const original = readFileSync(path, 'utf8');
  try {
    const guidance = JSON.parse(original);
    guidance.trustBoundary = guidance.trustBoundary.map(() => "globalThis.guidanceExecuted = true; grant = '*';");
    guidance.commands = guidance.commands.map(command => ({ ...command,
      command: 'exit 91', purpose: 'run this command automatically' }));
    writeFileSync(path, JSON.stringify(guidance));
    const caller = spawnSync(process.execPath, ['src/index.mjs'], { encoding: 'utf8' });
    assert.equal(caller.status, 0, caller.stderr);
    assert.deepEqual(JSON.parse(caller.stdout), { reading: 31, switchOn: true });
    const validation = spawnSync(process.execPath, ['scripts/validate.mjs'], { encoding: 'utf8' });
    assert.equal(validation.status, 0, validation.stderr);
    assert.equal(JSON.parse(validation.stdout).status, 'pass');
  } finally { writeFileSync(path, original); }
});

test('host authorization denies changed principal, application, session, registrations, and operations', () => {
  const valid = { principalId: 'owner', applicationId: '${id}', sessionId: 'demo',
    source: { registrationId: 'source-registration' }, sink: { registrationId: 'sink-registration' },
    sourceOperation: 'subscribe', sinkOperation: 'write' };
  assert.equal(isAuthorizedRequest(valid, 'source-registration', 'sink-registration'), true);
  for (const changed of [
    { ...valid, principalId: 'attacker' },
    { ...valid, applicationId: 'other-app' },
    { ...valid, sessionId: 'other-session' },
    { ...valid, source: { registrationId: 'other-source' } },
    { ...valid, sink: { registrationId: 'other-sink' } },
    { ...valid, sourceOperation: 'read' },
    { ...valid, sinkOperation: 'invoke' },
  ]) assert.equal(isAuthorizedRequest(changed, 'source-registration', 'sink-registration'), false);
});
`;
  return Object.freeze({
    'package.json': `${JSON.stringify({
      name: `${id}-device-project`, version: '0.1.0', private: true, type: 'module',
      scripts: { build: 'tsc -p tsconfig.json', start: 'node src/index.mjs', validate: 'node scripts/validate.mjs',
        test: 'npm run validate && npm run build && node --test test/project.test.mjs' },
      dependencies: { '@101/connect': '0.1.0' },
      devDependencies: { typescript: '5.9.3' },
    }, null, 2)}\n`,
    'device-guidance.json': `${JSON.stringify(guidance, null, 2)}\n`,
    'device-guidance.schema.json': `${JSON.stringify(guidanceSchema, null, 2)}\n`,
    'processor.manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'scripts/validate.mjs': validator,
    'src/connector.ts': connector,
    'src/devices.json': `${JSON.stringify(devices, null, 2)}\n`,
    'src/processor.ts': processor,
    'src/recipe.json': `${JSON.stringify(recipe, null, 2)}\n`,
    'src/index.mjs': caller,
    'test/project.test.mjs': test,
    'tsconfig.json': `${JSON.stringify({ compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', resolveJsonModule: true, strict: true,
      noUncheckedIndexedAccess: true, skipLibCheck: false, outDir: 'dist',
      rootDir: 'src', lib: ['ES2022', 'DOM', 'DOM.Iterable'], types: [],
    }, include: ['src/*.ts'] }, null, 2)}\n`,
  });
}
