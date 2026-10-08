import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { matterFiles, matterFingerprints, matterHash, matterSourceClosure, prepareMatterExecution, captureMatterAcceptance, runMatterChild } from './qa-matter-ws-switch.mjs';
const names = ['connect', 'device-model', 'device-runtime', 'device-web', 'transport-webrtc', 'transport-websocket', 'vision'];
function installed(consumer) {
    const receiptPath = join(consumer, 'receipt.json'), dependencyReceiptPath = join(consumer, 'selected-node-connectors/receipt.json'), receipt = JSON.parse(readFileSync(receiptPath)), deps = JSON.parse(readFileSync(dependencyReceiptPath));
    assert.equal(receipt.status, 'pass');
    assert.equal(deps.status, 'pass');
    const manifestPath = realpathSync(receipt.manifest.path), manifest = JSON.parse(readFileSync(manifestPath));
    assert.equal(matterHash(readFileSync(manifestPath)), receipt.manifest.sha256);
    assert.equal(manifest.packages.length, 7);
    const paths = [];
    for (const name of names) {
        const record = manifest.packages.find(p => p.name === '@101/' + name);
        assert.ok(record);
        const directory = join(consumer, 'node_modules/@101', name);
        assert.equal(realpathSync(directory), directory);
        const all = matterFiles(directory);
        assert.equal(all.length, record.files.length);
        for (const f of record.files) {
            assert.ok(!f.path.startsWith('/') && !f.path.split('/').some(p => p === '..' || p === '.' || !p));
            const path = join(directory, f.path);
            assert.equal(matterHash(readFileSync(path)), f.sha256);
            paths.push(path);
        }
    }
    const resolver = createRequire(join(consumer, 'package.json')), ws = dirname(realpathSync(resolver.resolve('ws/package.json')));
    assert.equal(JSON.parse(readFileSync(join(ws, 'package.json'))).version, '8.21.0');
    return { receiptPath, dependencyReceiptPath, manifestPath, paths, ws, manifest, receipt };
}
function baseline(consumer) { const state = installed(consumer); return { state, read: () => ({ sdk: matterFingerprints(state.paths), dependency: matterFingerprints(matterFiles(state.ws)), receipts: matterFingerprints([state.receiptPath, state.dependencyReceiptPath, state.manifestPath]), source: matterSourceClosure() }) }; }
/** Integration owner only: actual ordinary installed @101/connect resolution. */
export async function qualifyInstalledMatter(consumerPath) { const consumer = realpathSync(consumerPath), root = realpathSync(resolve(import.meta.dirname, '..')); assert.ok(!consumer.startsWith(root + sep)); const { state, read } = baseline(consumer), before = read(), work = mkdtempSync(join(consumer, 'matter-ws-switch-')), execution = prepareMatterExecution({ work, installed: consumer }); const readClosure = () => ({ ...read(), copiedDependency: matterFingerprints(matterFiles(join(work, 'node_modules'))) }); const fence = captureMatterAcceptance({ artifactPaths: execution.artifactPaths, receiptPaths: [state.receiptPath, state.dependencyReceiptPath, state.manifestPath], readClosure }); const child = await runMatterChild(execution.runner); assert.equal(child.execution.result.status, 'pass'); const entry = fileURLToPath(child.execution.publicEntry); assert.ok(entry.startsWith(join(consumer, 'node_modules/@101/connect') + sep)); fence.verify(); assert.deepEqual(read(), before); const proof = { schemaVersion: 1, status: 'pass', work, publicResolution: entry, sdkPackages: 7, sdkFiles: state.paths.length, sdkManifest: state.receipt.manifest, artifacts: fence.artifacts, closure: fence.closure, child, scope: 'Ordinary unchanged installed public SDK with separately compiled gateway; original software native-wire stand-in only. Commissioning, CASE, native fabric/controller, Thread, hardware/capture timing and full A06 remain open.' }; const receiptPath = join(work, 'receipt.json'); writeFileSync(receiptPath, JSON.stringify(proof, null, 2) + '\n'); return { status: 'pass', receipt: receiptPath, result: child.execution.result }; }
/** Expected negative controls on uniquely owned copies. Authoritative SDK is read-only. */
export async function runMatterControlledCopyChecks(consumerPath, { outputRoot = '/tmp' } = {}) {
    const consumer = realpathSync(consumerPath), { state, read } = baseline(consumer), authoritative = read(), work = mkdtempSync(join(realpathSync(outputRoot), '101-matter-controls-'));
    mkdirSync(join(work, 'node_modules/@101'), { recursive: true });
    for (const name of names)
        cpSync(join(consumer, 'node_modules/@101', name), join(work, 'node_modules/@101', name), { recursive: true, dereference: false });
    const receiptCopy = join(work, 'sdk-receipt.json'), dependencyCopy = join(work, 'dependency-receipt.json');
    writeFileSync(receiptCopy, readFileSync(state.receiptPath));
    writeFileSync(dependencyCopy, readFileSync(state.dependencyReceiptPath));
    const execution = prepareMatterExecution({ work, installed: work }), readClosure = () => ({ ...read(), ownedSdkDependency: matterFingerprints(matterFiles(join(work, 'node_modules'))) }), fence = captureMatterAcceptance({ artifactPaths: execution.artifactPaths, receiptPaths: [receiptCopy, dependencyCopy, state.manifestPath], readClosure });
    const child = await runMatterChild(execution.runner);
    assert.equal(child.execution.result.status, 'pass');
    assert.ok(fileURLToPath(child.execution.publicEntry).startsWith(realpathSync(join(work, 'node_modules/@101/connect')) + sep));
    fence.verify();
    const sdkFile = matterFiles(join(work, 'node_modules/@101/connect')).find(p => p.endsWith('.js'));
    assert.ok(sdkFile);
    const targets = [['artifact', execution.artifactPaths.producer, /artifacts changed/], ['sdk-receipt', receiptCopy, /Receipt bytes changed/], ['dependency-receipt', dependencyCopy, /Receipt bytes changed/], ['ordinary-sdk', sdkFile, /closure changed/], ['dependency', join(work, 'node_modules/ws/lib/websocket.js'), /closure changed/]], mutations = [];
    for (const [name, target, pattern] of targets) {
        const original = readFileSync(target), mutated = Buffer.concat([original, Buffer.from('\n// owned post-caller mutation ' + name + '\n')]), retained = join(work, 'mutation-' + name + '.bin');
        writeFileSync(target, mutated);
        writeFileSync(retained, readFileSync(target));
        assert.throws(() => fence.verify(), pattern);
        mutations.push({ name, target, retained, originalSha256: matterHash(original), mutatedSha256: matterHash(readFileSync(retained)) });
        writeFileSync(target, original);
        assert.equal(matterHash(readFileSync(target)), matterHash(original));
        fence.verify();
    }
    assert.deepEqual(read(), authoritative, 'Authoritative SDK/receipt/dependency source changed');
    const proof = { schemaVersion: 1, status: 'pass', work, expectedNegatives: mutations.length, actualPublicCaller: true, actualChildClose: child.actualChildClose, naturalExitCode: child.naturalExitCode, artifacts: fence.artifacts, closure: fence.closure, authoritative, mutations, child, scope: 'Owned copied installed SDK after genuine ordinary public caller; expected post-caller mutation negatives only, not normal installed qualification or fabricated historical regressions.' };
    const receipt = join(work, 'receipt.json');
    writeFileSync(receipt, JSON.stringify(proof, null, 2) + '\n');
    return { status: 'pass', receipt, checks: mutations.length };
}
if (process.argv[1] && process.argv[1] !== '-' && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    try {
        assert.equal(process.argv.length, process.argv[2] === '--controlled-copy' ? 4 : 3);
        console.log(JSON.stringify(process.argv[2] === '--controlled-copy' ? await runMatterControlledCopyChecks(process.argv[3]) : await qualifyInstalledMatter(process.argv[2])));
    }
    catch (e) {
        console.error(e);
        process.exitCode = 1;
    }
}
