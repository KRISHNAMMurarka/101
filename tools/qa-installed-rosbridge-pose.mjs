import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { fileHash, installedSdk, ordinaryFiles } from './build-pointer-bindings.mjs';
assert.equal(process.argv.length, 3, 'Pass existing verified offline SDK consumer directory');
assert.ok(!process.execArgv.some(v => v.includes('import') || v.includes('loader')), 'Installed caller uses ordinary public ESM resolution');
const root = resolve(import.meta.dirname, '..'), consumerDirectory = resolve(process.argv[2]), receiptPath = join(consumerDirectory, 'receipt.json'), originalReceipt = readFileSync(receiptPath), receipt = JSON.parse(originalReceipt);
const sdk = installedSdk(consumerDirectory, receipt.manifest.path);
const sdkFingerprints = () => Object.fromEntries(sdk.manifest.packages.flatMap(record => record.files.map(file => [record.name + '/' + file.path, fileHash(join(sdk.directory, 'node_modules', record.name, file.path))])));
const initialSdkFingerprints = sdkFingerprints();
assert.equal(receipt.status, 'pass');
assert.equal(sdk.manifestSha256, receipt.manifest.sha256);
assert.ok(!sdk.directory.startsWith(root + '/'));
const sources = ['packages/hub-server/src/rosbridge-pose-connector.ts', 'packages/hub-server/src/rosbridge-pose-connector.test.ts', 'examples/rosbridge-pose/peer.mjs', 'examples/rosbridge-pose/consumer.mjs', 'tools/qa-rosbridge-pose.mjs', 'tools/qa-installed-rosbridge-pose.mjs'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex'), sourceBytes = Object.fromEntries(sources.map(p => [p, readFileSync(join(root, p))])), sourceSha256 = Object.fromEntries(sources.map(p => [p, sha(sourceBytes[p])]));
const work = mkdtempSync(join(sdk.directory, 'rosbridge-pose-connector-')), artifactPaths = {};
for (const [i, p] of sources.entries()) {
    const copy = join(work, `source-${i}.bin`);
    writeFileSync(copy, sourceBytes[p]);
    artifactPaths[p] = copy;
}
const copiedSourceSha256 = Object.fromEntries(sources.map(p => [p, fileHash(artifactPaths[p])]));
assert.deepEqual(copiedSourceSha256, sourceSha256);
// Existing host transport dependency stays separate from the seven installed SDK packages.
const require = createRequire(import.meta.url), wsRoot = dirname(require.resolve('ws/package.json'));
assert.equal(JSON.parse(readFileSync(join(wsRoot, 'package.json'))).version, '8.21.0');
const wsFiles = ordinaryFiles(wsRoot), wsSourceSha256 = {};
for (const from of wsFiles) {
    assert.equal(lstatSync(from).isSymbolicLink(), false);
    const name = relative(wsRoot, from), to = join(work, 'node_modules/ws', name);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    artifactPaths['host-ws/' + name] = to;
    wsSourceSha256[name] = fileHash(from);
    assert.equal(fileHash(to), wsSourceSha256[name]);
}
const connectorPath = join(work, 'connector.mjs'), callerPath = join(work, 'consumer.mjs'), peerPath = join(work, 'peer.mjs'), resolverPath = join(work, 'resolve.mjs');
writeFileSync(connectorPath, ts.transpileModule(sourceBytes[sources[0]].toString(), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
const caller = sourceBytes['examples/rosbridge-pose/consumer.mjs'].toString(), needle = "'../../packages/hub-server/src/rosbridge-pose-connector.ts'";
assert.equal(caller.split(needle).length, 2);
writeFileSync(callerPath, caller.replace(needle, "'./connector.mjs'"));
writeFileSync(peerPath, sourceBytes['examples/rosbridge-pose/peer.mjs']);
writeFileSync(resolverPath, "export const entry=import.meta.resolve('@101/connect');export * from '@101/connect';\n");
Object.assign(artifactPaths, { connectorPath, callerPath, peerPath, resolverPath });
const closurePaths = { helper: join(root, 'tools/build-pointer-bindings.mjs'), compiler: require.resolve('typescript'), compilerPackage: require.resolve('typescript/package.json'), sdkReceipt: receiptPath, sdkManifest: receipt.manifest.path };
const closureSha256 = Object.fromEntries(Object.entries(closurePaths).map(([k, p]) => [k, fileHash(p)])), artifactSha256 = Object.fromEntries(Object.entries(artifactPaths).map(([k, p]) => [k, fileHash(p)]));
function verifyClosure() {
    assert.equal(sha(readFileSync(receiptPath)), sha(originalReceipt));
    const finalReceipt = JSON.parse(readFileSync(receiptPath));
    assert.equal(finalReceipt.manifest.path, receipt.manifest.path);
    const finalSdk = installedSdk(consumerDirectory, finalReceipt.manifest.path);
    assert.equal(finalSdk.manifestSha256, sdk.manifestSha256);
    assert.deepEqual(sdkFingerprints(), initialSdkFingerprints);
    for (const [p, hash] of Object.entries(sourceSha256))
        assert.equal(fileHash(join(root, p)), hash);
    for (const [k, p] of Object.entries(closurePaths))
        assert.equal(fileHash(p), closureSha256[k]);
    for (const [name, hash] of Object.entries(wsSourceSha256))
        assert.equal(fileHash(join(wsRoot, name)), hash);
    const final = Object.fromEntries(Object.entries(artifactPaths).map(([k, p]) => [k, fileHash(p)]));
    assert.deepEqual(final, artifactSha256);
    return final;
}
process.env.WS_NO_BUFFER_UTIL = '1';
process.env.WS_NO_UTF_8_VALIDATE = '1';
const installed = await import(pathToFileURL(resolverPath));
assert.ok(installed.entry.startsWith(pathToFileURL(join(sdk.directory, 'node_modules/@101/connect') + '/').href));
assert.ok(installed.entry.endsWith('/dist/index.js'));
const { runRosbridgePoseConsumer } = await import(pathToFileURL(callerPath)), result = await runRosbridgePoseConsumer();
assert.equal(result.publicDelivered, 1);
assert.equal(result.status.rawSockets, 0);
const finalArtifactSha256 = verifyClosure();
// Actual post-caller mutation of an executed, uniquely owned copied peer must fail final closure.
const exactPeer = readFileSync(peerPath);
writeFileSync(peerPath, Buffer.concat([exactPeer, Buffer.from('\n// owned post-caller closure mutation\n')]));
const mutationSha256 = fileHash(peerPath);
assert.throws(verifyClosure, error => {
    assert.equal(error.code, 'ERR_ASSERTION');
    assert.equal(error.actual.peerPath, mutationSha256);
    assert.equal(error.expected.peerPath, artifactSha256.peerPath);
    return true;
});
const mutationProof = { status: 'rejected', path: peerPath, sha256: mutationSha256, afterActualCaller: true };
writeFileSync(join(work, 'mutation-peer.bin'), readFileSync(peerPath));
writeFileSync(peerPath, exactPeer);
verifyClosure();
const proof = { schemaVersion: 1, status: 'pass', softwareOnly: true, actualRos: false, actualDds: false, hardware: false, supportRows: [], sourceSha256, copiedSourceSha256, artifactPaths, artifactSha256, finalArtifactSha256, hostDependency: { name: 'ws', version: '8.21.0', sourceRoot: wsRoot, sourceSha256: wsSourceSha256, optionalNativeAddons: false }, closurePaths, closureSha256, installedPublicEntry: installed.entry, sdkManifest: receipt.manifest, sdkManifestSha256: sdk.manifestSha256, finalSdkManifestSha256: sdk.manifestSha256, mutationProof, initialSdkFingerprints, finalSdkFingerprints: sdkFingerprints(), result };
const proofPath = join(work, 'receipt.json');
writeFileSync(proofPath, JSON.stringify(proof, null, 2) + '\n');
console.log(JSON.stringify({ status: 'pass', receipt: proofPath, result }));
