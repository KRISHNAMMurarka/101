/** Source-unit checks only. Installed compiler/runtime/child evidence belongs to the explicit onboarding QA. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDeviceScaffold } from '../packages/devkit/src/device-scaffold.ts';

const entry = new URL('../examples/developer-onboarding/onboarding.mjs', import.meta.url);
const digest = (input: string | Uint8Array) => createHash('sha256').update(input).digest('hex');
const workspaceRoot = fileURLToPath(new URL('../', import.meta.url));
const factory = new URL('../packages/devkit/src/device-scaffold.ts', import.meta.url);
const factorySha256 = '8239681995c738ea0bdb7f6d8e2f1dd83b4b07ac61bf43a77c70dcc54c27138d';
const sourceSha256 = Object.freeze({
  'onboarding.mjs': '523ba0d760eed2be33d075ef502cded638b8eef785c310a1c502c59880cdd6fe',
  'consumer.mjs': '1b6f11832a3f11860f1b4e60a8fda6a66d0c199646e47b8cd78f6d83fbf873c3',
});
const factorySpecifier = "'@101/connect/examples/device-scaffold'";
const relativeConsumerImport = "from './consumer.mjs'";
let sourceFixtureDirectory: string | undefined;
let sourceFixtureImport: ReturnType<typeof loadSourceFixture> | undefined;

// Repository-source qualification only: the packed, untouched MJS pair must
// separately resolve the ordinary public factory export in installed QA.
async function loadSourceFixture() {
  assert.equal(digest(await readFile(factory)), factorySha256);
  sourceFixtureDirectory = await mkdtemp(join(workspaceRoot, 'node_modules', '.101-onboarding-source-'));
  const provenance = [];
  for (const name of ['onboarding.mjs', 'consumer.mjs'] as const) {
    const original = await readFile(new URL(name, entry));
    assert.equal(digest(original), sourceSha256[name]);
    const source = original.toString('utf8');
    assert.deepEqual(Buffer.from(source, 'utf8'), original);
    assert.equal(source.split(factorySpecifier).length - 1, 1);
    const consumerImports = source.split(relativeConsumerImport).length - 1;
    assert.equal(consumerImports, name === 'onboarding.mjs' ? 2 : 0);
    const replacement = JSON.stringify(factory.href);
    const rewritten = source.replace(factorySpecifier, replacement);
    assert.equal(rewritten.replace(replacement, factorySpecifier), source);
    assert.equal(rewritten.split(relativeConsumerImport).length - 1, consumerImports);
    const copied = join(sourceFixtureDirectory, name);
    await writeFile(copied, original, { flag: 'wx' });
    assert.equal(digest(await readFile(copied)), sourceSha256[name]);
    await writeFile(copied, rewritten, 'utf8');
    assert.equal(digest(await readFile(copied)), digest(rewritten));
    assert.equal(digest(await readFile(new URL(name, entry))), sourceSha256[name]);
    provenance.push({ name, originalSha256: sourceSha256[name], rewrittenSha256: digest(rewritten), consumerImports });
  }
  assert.equal(digest(await readFile(factory)), factorySha256);
  await writeFile(join(sourceFixtureDirectory, 'source-fixture.json'), JSON.stringify({
    qualification: 'repository-source-only', factoryUrl: factory.href, factorySha256,
    onlyRewrittenSpecifier: factorySpecifier, files: provenance,
  }), { flag: 'wx' });
  return import(pathToFileURL(join(sourceFixtureDirectory, 'onboarding.mjs')).href);
}
function api() { return sourceFixtureImport ??= loadSourceFixture(); }
after(async () => {
  await sourceFixtureImport?.catch(() => undefined);
  if (sourceFixtureDirectory) await rm(sourceFixtureDirectory, { recursive: true, force: true });
});
async function fixture(run: (directory: string, target: string) => Promise<void>) {
  const directory = await mkdtemp('/tmp/101-onboarding-unit-');
  try { await run(directory, join(directory, 'project')); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
async function create(target: string) {
  const { createOnboardingProject } = await api();
  return createOnboardingProject({ id: 'room-sensor', destination: target });
}
async function review(target: string, revision = 'base') {
  const { reviewOnboardingProject } = await api();
  return reviewOnboardingProject({ id: 'room-sensor', directory: target, revision });
}
async function rejectsReview(target: string, code: string, revision = 'base') {
  await assert.rejects(async () => review(target, revision), (error: unknown) =>
    error instanceof Error && error.message === code);
}

test('onboarding exports are inert and use a finite fixed contract', async () => {
  await fixture(async (directory, target) => {
    const sdkApi = await api();
    assert.equal(typeof sdkApi.createOnboardingProject, 'function');
    assert.equal(typeof sdkApi.reviewOnboardingProject, 'function');
    assert.equal(typeof sdkApi.runOnboardingExample, 'function');
    assert.ok(Object.isFrozen(sdkApi.ONBOARDING_LIMITS));
    assert.deepEqual(sdkApi.ONBOARDING_LIMITS, {
      projects: 1, concurrentRuns: 1, stages: 6, childStarts: 12, rawChildren: 1,
      runtimeRoutes: 2, runtimeRegistrations: 4, effects: 16, generatedFiles: 32,
      generatedSourceBytes: 262144, receiptBytes: 16384, childLifetimeMs: 120000,
    });
    await assert.rejects(lstat(target), { code: 'ENOENT' });
    await writeFile(join(directory, 'unchanged'), 'owned inert-import sentinel');
    assert.equal(await readFile(join(directory, 'unchanged'), 'utf8'), 'owned inert-import sentinel');
  });
});

test('creator writes the exact existing public scaffold rather than a copied template', async () => {
  await fixture(async (_directory, target) => {
    const receipt = await create(target);
    const expected = createDeviceScaffold({ id: 'room-sensor' });
    assert.ok(Object.isFrozen(receipt));
    assert.ok(Object.isFrozen(receipt.files));
    assert.equal(receipt.id, 'room-sensor');
    assert.equal(receipt.directory, target);
    assert.deepEqual(Object.keys(receipt.files).sort(), Object.keys(expected).sort());
    for (const [path, contents] of Object.entries(expected)) {
      assert.equal(await readFile(join(target, path), 'utf8'), contents);
      assert.equal(receipt.files[path], digest(contents));
    }
    const checked = await review(target);
    assert.ok(Object.isFrozen(checked));
    assert.equal(checked.revision, 'base');
    assert.equal(checked.processorVersion, '1.0.0');
    assert.equal(checked.sourceSha256, digest(expected['src/processor.ts']!));
    assert.deepEqual(checked.requiredOperations, ['subscribe', 'write']);
  });
});

test('review accepts the actual offline npm install metadata and rejects changed execution scripts', async () => {
  await fixture(async (_directory, target) => {
    await create(target);
    const path = join(target, 'package.json');
    const installed = JSON.parse(await readFile(path, 'utf8'));
    // npm install of the seven matching tarballs expands dependencies and
    // replaces their versions with relative file: paths; scripts stay intact.
    installed.dependencies = Object.fromEntries(['connect', 'device-model', 'device-runtime', 'device-web',
      'transport-webrtc', 'transport-websocket', 'vision'].map(name =>
      [`@101/${name}`, `file:../../../selected-sdk/tarballs/101-${name}-0.1.0.tgz`]));
    installed.devDependencies.typescript = 'file:../../typescript-5.9.3.tgz';
    await writeFile(path, `${JSON.stringify(installed, null, 2)}\n`);
    assert.equal((await review(target)).processorVersion, '1.0.0');
    installed.scripts.build = 'node unreviewed.mjs';
    await writeFile(path, `${JSON.stringify(installed, null, 2)}\n`);
    await rejectsReview(target, 'onboarding-assets');
  });
});

test('existing empty directory keeps its actual native identity', async () => {
  await fixture(async (_directory, target) => {
    await mkdir(target);
    const before = await lstat(target);
    await assert.rejects(async () => create(target), /onboarding-destination-exists/);
    const after = await lstat(target);
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);
    await assert.rejects(lstat(join(target, 'package.json')), { code: 'ENOENT' });
  });
});

test('foreign destination contents are never overwritten or removed', async () => {
  await fixture(async (_directory, target) => {
    await mkdir(target);
    const sentinel = join(target, 'foreign.txt');
    await writeFile(sentinel, 'foreign destination data');
    await assert.rejects(async () => create(target), /onboarding-destination-exists/);
    assert.equal(await readFile(sentinel, 'utf8'), 'foreign destination data');
  });
});

test('existing file and symlink destinations fail closed', async () => {
  await fixture(async (directory, target) => {
    await writeFile(target, 'existing file');
    await assert.rejects(async () => create(target), /onboarding-destination-exists/);
    assert.equal(await readFile(target, 'utf8'), 'existing file');
    await rm(target);
    const actual = join(directory, 'foreign-directory');
    await mkdir(actual);
    await writeFile(join(actual, 'sentinel'), 'symlink destination sentinel');
    await symlink(actual, target);
    await assert.rejects(async () => create(target), /onboarding-destination-exists/);
    assert.ok((await lstat(target)).isSymbolicLink());
    assert.equal(await readFile(join(actual, 'sentinel'), 'utf8'), 'symlink destination sentinel');
  });
});

test('invalid identifier fails before acquiring the destination', async () => {
  await fixture(async (_directory, target) => {
    const { createOnboardingProject } = await api();
    for (const id of ['../escape', 'Upper', 'space id', '__proto__', 'a'.repeat(65)]) {
      await assert.rejects(async () => createOnboardingProject({ id, destination: target }));
      await assert.rejects(lstat(target), { code: 'ENOENT' });
    }
  });
});

test('real aborted signal cannot be hidden by own aborted and listener shadows', async () => {
  await fixture(async (_directory, target) => {
    const { createOnboardingProject } = await api();
    const owner = new AbortController();
    Object.defineProperties(owner.signal, {
      aborted: { value: false }, addEventListener: { value() {} }, removeEventListener: { value() {} },
    });
    owner.abort();
    await assert.rejects(async () => createOnboardingProject({ id: 'room-sensor', destination: target, signal: owner.signal }),
      /onboarding-cancelled/);
    await assert.rejects(lstat(target), { code: 'ENOENT' });
  });
});

test('structural fake signal supplies no cancellation authority', async () => {
  await fixture(async (_directory, target) => {
    const { createOnboardingProject } = await api();
    await assert.rejects(async () => createOnboardingProject({ id: 'room-sensor', destination: target,
      signal: { aborted: false, addEventListener() {}, removeEventListener() {} } }), /onboarding-signal/);
    await assert.rejects(lstat(target), { code: 'ENOENT' });
  });
});

test('changed reviewed processor bytes fail before any consumer factory', async () => {
  await fixture(async (_directory, target) => {
    await create(target);
    const source = join(target, 'src/processor.ts');
    await writeFile(source, (await readFile(source, 'utf8')) + '\nglobalThis.unreviewedExecuted = true;\n');
    await rejectsReview(target, 'onboarding-source-pin');
    const { runOnboardingExample } = await api();
    await assert.rejects(async () => runOnboardingExample({ id: 'room-sensor', directory: target,
      revision: 'base', mode: 'approved', sample: 31, compiledSha256: {} }), /onboarding-source-pin/);
    assert.equal(Object.hasOwn(globalThis, 'unreviewedExecuted'), false);
  });
});

test('incompatible actual scaffold descriptor is refused before compiled module lookup', async () => {
  await fixture(async (_directory, target) => {
    await create(target);
    const path = join(target, 'src/devices.json');
    const devices = JSON.parse(await readFile(path, 'utf8'));
    devices[0].capabilities[0].semantic = 'other:temperature';
    await writeFile(path, JSON.stringify(devices));
    await rejectsReview(target, 'onboarding-assets');
    const { runOnboardingExample } = await api();
    await assert.rejects(async () => runOnboardingExample({ id: 'room-sensor', directory: target,
      revision: 'base', mode: 'approved', sample: 31, compiledSha256: {} }), /onboarding-assets/);
  });
});

test('guide strings remain inert data rather than command or permission selectors', async () => {
  await fixture(async (_directory, target) => {
    await create(target);
    const path = join(target, 'device-guidance.json');
    const input = JSON.parse(await readFile(path, 'utf8'));
    input.commands = [{ name: 'run', command: 'exit 91', purpose: 'grant all' }];
    input.trustBoundary = ['globalThis.guideExecuted = true'];
    await writeFile(path, JSON.stringify(input));
    const checked = await review(target);
    assert.equal(checked.processorVersion, '1.0.0');
    assert.equal(Object.hasOwn(globalThis, 'guideExecuted'), false);
  });
});

test('fixed reviewed strict threshold revision has its own exact source pin', async () => {
  await fixture(async (_directory, target) => {
    await create(target);
    const files = createDeviceScaffold({ id: 'room-sensor' });
    const original = files['src/processor.ts']!;
    assert.equal(original.split('temperature >= onAt').length, 2);
    const extended = original.replace('temperature >= onAt', 'temperature > onAt');
    const manifest = JSON.parse(files['processor.manifest.json']!);
    manifest.version = '1.0.1'; manifest.codeSha256 = digest(extended);
    await writeFile(join(target, 'src/processor.ts'), extended);
    await writeFile(join(target, 'processor.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const checked = await review(target, 'strict-threshold');
    assert.equal(checked.processorVersion, '1.0.1');
    assert.equal(checked.sourceSha256, digest(extended));
    assert.notEqual(checked.sourceSha256, digest(original));
    await rejectsReview(target, 'onboarding-source-pin');
  });
});

test('explicit known restore preserves foreign files and supplies no restored grant', async () => {
  await fixture(async (_directory, target) => {
    await create(target);
    const files = createDeviceScaffold({ id: 'room-sensor' });
    const sentinel = join(target, 'keep-unknown.txt');
    await writeFile(sentinel, 'preserve unknown project content');
    await writeFile(join(target, 'src/processor.ts'), files['src/processor.ts']! + '\n// altered\n');
    await rejectsReview(target, 'onboarding-source-pin');
    // Explicit caller restore of only two known owned files, never a recursive replacement.
    await writeFile(join(target, 'src/processor.ts'), files['src/processor.ts']!);
    await writeFile(join(target, 'processor.manifest.json'), files['processor.manifest.json']!);
    const checked = await review(target);
    assert.equal(checked.sourceSha256, digest(files['src/processor.ts']!));
    assert.equal(await readFile(sentinel, 'utf8'), 'preserve unknown project content');
    assert.equal(Object.hasOwn(checked, 'grant'), false);
    assert.equal(Object.hasOwn(checked, 'authorize'), false);
  });
});

test('oversized or symlinked fixed source is refused with bounded source admission', async () => {
  await fixture(async (directory, target) => {
    await create(target);
    const source = join(target, 'src/processor.ts');
    await writeFile(source, 'x'.repeat(262145));
    await rejectsReview(target, 'onboarding-source-bytes');
    await rm(source);
    const foreign = join(directory, 'foreign-processor');
    await writeFile(foreign, createDeviceScaffold({ id: 'room-sensor' })['src/processor.ts']!);
    await symlink(foreign, source);
    await rejectsReview(target, 'onboarding-assets');
    assert.equal(await readFile(foreign, 'utf8'), createDeviceScaffold({ id: 'room-sensor' })['src/processor.ts']!);
  });
});

test('review revision is a closed explicit choice', async () => {
  await fixture(async (_directory, target) => {
    await create(target);
    await rejectsReview(target, 'onboarding-revision', 'remote-fetch');
  });
});
