import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { createAssetReference, processorExtensionManifestSha256, processorExtensionSigningBytes } from '@101/device-model';

const project = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

test('activation evaluates only the exact source bytes verified before install', async t => {
  mkdirSync(join(project, 'release'), { recursive: true });
  const scratch = mkdtempSync(join(project, 'release', 'extension-source-binding-'));
  const extDir = join(scratch, 'examples', 'extension-installation');
  const processorDir = join(scratch, 'examples', 'external-processor');
  try {
    mkdirSync(extDir, { recursive: true }); mkdirSync(processorDir, { recursive: true });
    const actualConsumer = readFileSync(join(project, 'examples/extension-installation/consumer.mjs'));
    const originalText = actualConsumer.toString('utf8');
    const verifyAnchor = "  assert.equal(await verifyProcessorExtensionRelease(v2, source2, publicKey), true);\n";
    assert.equal(originalText.split(verifyAnchor).length, 2, 'verification anchor must be present exactly once');
    const injectedConsumer = originalText
      .replace("import { readFileSync } from 'node:fs';", "import { readFileSync, writeFileSync } from 'node:fs';")
      .replace(verifyAnchor,
`  assert.equal(await verifyProcessorExtensionRelease(v2, source2, publicKey), true);
  if (phase === 'activate-and-close') {
    const target = new URL('../external-processor/processor.mjs', import.meta.url);
    const prior = readFileSync(target);
    writeFileSync(target, Buffer.concat([Buffer.from('globalThis.__s13_test_replacement_loaded = true;\\n'), prior]));
  }
`);
    assert.notEqual(injectedConsumer, originalText, 'test interposition must be inserted into the copied caller');
    assert.ok(injectedConsumer.includes("if (phase === 'activate-and-close')"), 'interposition is limited to activation phase');
    writeFileSync(join(extDir, 'consumer.mjs'), injectedConsumer);
    copyFileSync(join(project, 'examples/extension-installation/filesystem-storage.mjs'), join(extDir, 'filesystem-storage.mjs'));
    copyFileSync(join(project, 'examples/extension-installation/temperature-band-v2.mjs'), join(extDir, 'temperature-band-v2.mjs'));
    copyFileSync(join(project, 'examples/external-processor/processor.mjs'), join(processorDir, 'processor.mjs'));
    copyFileSync(join(project, 'examples/external-processor/manifest.json'), join(processorDir, 'manifest.json'));

    const source1 = new Uint8Array(readFileSync(join(processorDir, 'processor.mjs')));
    const source2 = new Uint8Array(readFileSync(join(extDir, 'temperature-band-v2.mjs')));
    const base = JSON.parse(readFileSync(join(processorDir, 'manifest.json'), 'utf8'));
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const releases = [];
    for (const [index, source] of [source1, source2].entries()) {
      const reference = await createAssetReference('example:reviewed-source', 'blob', source);
      const version = index === 0 ? '1.0.0' : '2.0.0';
      const manifest = { ...base, version, codeSha256: reference.sha256 };
      const unsigned = { schemaVersion: 1, profile: 'reviewed-processor-extension/1', publisherId: 'example:local-publisher',
        packageId: manifest.id, version, sequence: index + 1, abi: '101:processor/1', runtimeVersion: '0.1.0', manifest,
        manifestSha256: await processorExtensionManifestSha256(manifest), source: reference, privileges: ['compute-local'], dependencies: [] };
      releases.push({ ...unsigned, signature: Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey,
        processorExtensionSigningBytes(unsigned))).toString('hex') });
    }
    const provision = JSON.stringify({ publisherKey: await crypto.subtle.exportKey('jwk', pair.publicKey), releases });
    writeFileSync(join(scratch, 'provision.json'), provision, { mode: 0o600 });
    const { runExtensionInstallationExample } = await import(pathToFileURL(join(extDir, 'consumer.mjs')).href);
    const installed = await runExtensionInstallationExample(scratch, 'install');
    assert.equal(installed.inactive, true);
    const activation = await runExtensionInstallationExample(scratch, 'activate-and-close');
    assert.equal(activation.realActivation, true);
    assert.equal(Reflect.get(globalThis, '__s13_test_replacement_loaded') === true, false, 'replacement module must not be evaluated after source verification');
    t.diagnostic(JSON.stringify({ activationSucceeded: true, replacementMarkerEvaluated: false, provisionSha256: sha(provision) }));
  } finally {
    Reflect.deleteProperty(globalThis, '__s13_test_replacement_loaded');
    rmSync(scratch, { recursive: true, force: true });
    assert.equal(existsSync(scratch), false, 'owned copied caller tree is removed after evidence retention');
  }
});
