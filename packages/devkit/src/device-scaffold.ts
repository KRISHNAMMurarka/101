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
  const connector = `import { createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';

const value = { type: 'scalar', unit: 'Cel', min: -40, max: 125 } as const;
const sourceDevice = parseDeviceDescriptor({
  schemaVersion: 1, id: '${id}-sensor', label: 'Local sensor', revision: 1,
  adapter: { id: '${id}:sensor', version: '1.0.0' },
  runtime: { platform: 'embedded-simulation' },
  capabilities: [{
    id: 'temperature', semantic: '${id}:temperature', schemaVersion: 1,
    kind: 'sample', value,
    delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 1000 },
    permissions: ['subscribe'],
  }],
});
const sinkDevice = parseDeviceDescriptor({
  schemaVersion: 1, id: '${id}-display', label: 'Local display', revision: 1,
  adapter: { id: '${id}:display', version: '1.0.0' },
  runtime: { platform: 'embedded-simulation' },
  capabilities: [{
    id: 'temperature', semantic: '${id}:temperature', schemaVersion: 1,
    kind: 'property', value,
    delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 1000 },
    permissions: ['write'], ownership: { mode: 'exclusive' },
  }],
});

export function createConnector() {
  let sourceId: string | undefined, sinkId: string | undefined;
  let reading: number | undefined, released = 0;
  const runtime = createDeviceRuntime({
    now: () => 0, clockDomain: 'local-demo',
    authorize(request) {
      if (request.principalId !== 'owner' || request.applicationId !== '${id}' ||
          request.sessionId !== 'demo' || request.source.registrationId !== sourceId ||
          request.sink.registrationId !== sinkId ||
          request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write')
        return undefined;
      return { expiresAt: 10000, maxAgeMs: 1000, maxHz: 10 };
    },
  });
  const source = runtime.registerSource({ device: sourceDevice, capability: 'temperature' });
  const sink = runtime.registerSink({
    device: sinkDevice, capability: 'temperature',
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
  const route = runtime.route({
    from: source, to: sink, principalId: 'owner',
    applicationId: '${id}', sessionId: 'demo',
  });
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
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runProject } from '../src/index.mjs';
import { createConnector } from '../dist/connector.js';

test('manifest pins the exact reviewed processor source', () => {
  const manifest = JSON.parse(readFileSync(new URL('../processor.manifest.json', import.meta.url), 'utf8'));
  const source = readFileSync(new URL('../src/processor.ts', import.meta.url));
  assert.equal(manifest.codeSha256, createHash('sha256').update(source).digest('hex'));
});

test('local connector and processor run through the SDK and release', async () => {
  assert.deepEqual(await runProject(), { reading: 31, switchOn: true });
  const connector = createConnector();
  connector.publish(31);
  assert.equal(connector.state().reading, 31);
  connector.stop();
  assert.deepEqual(connector.state(), { reading: undefined, released: 1 });
});
`;
  return Object.freeze({
    'package.json': `${JSON.stringify({
      name: `${id}-device-project`, version: '0.1.0', private: true, type: 'module',
      scripts: { build: 'tsc -p tsconfig.json', start: 'node src/index.mjs',
        test: 'npm run build && node --test test/project.test.mjs' },
      dependencies: { '@101/connect': '0.1.0' },
      devDependencies: { typescript: '5.9.3' },
    }, null, 2)}\n`,
    'processor.manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'src/connector.ts': connector,
    'src/processor.ts': processor,
    'src/index.mjs': caller,
    'test/project.test.mjs': test,
    'tsconfig.json': `${JSON.stringify({ compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
      noUncheckedIndexedAccess: true, skipLibCheck: false, outDir: 'dist',
      rootDir: 'src', lib: ['ES2022', 'DOM', 'DOM.Iterable'], types: [],
    }, include: ['src/*.ts'] }, null, 2)}\n`,
  });
}
