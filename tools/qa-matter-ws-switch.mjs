import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, lstatSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
export const matterOwnedFiles = Object.freeze(['packages/hub-server/src/matter-ws-switch.ts', 'packages/hub-server/src/matter-ws-switch.test.ts', 'examples/matter-ws-switch/producer.mjs', 'examples/matter-ws-switch/consumer.mjs', 'tools/qa-matter-ws-switch.mjs', 'tools/qa-installed-matter-ws-switch.mjs']);
export const matterHash = bytes => createHash('sha256').update(bytes).digest('hex');
export function matterFiles(directory) { return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(e => { const p = join(directory, e.name); assert.ok(!lstatSync(p).isSymbolicLink(), 'ordinary owned closure only'); assert.ok(e.isDirectory() || e.isFile()); return e.isDirectory() ? matterFiles(p) : [p]; }); }
export const matterFingerprints = paths => Object.fromEntries([...new Set(paths)].sort().map(p => [realpathSync(p), matterHash(readFileSync(p))]));
export function matterSourceClosure() {
    const root = resolve(import.meta.dirname, '..'), resolver = createRequire(import.meta.url), sdkRoot = dirname(dirname(dirname(realpathSync(resolver.resolve('@101/connect')))));
    const paths = matterOwnedFiles.map(p => join(root, p));
    for (const name of ['connect', 'device-model', 'device-runtime', 'device-web', 'transport-webrtc', 'transport-websocket', 'vision'])
        paths.push(...matterFiles(join(sdkRoot, name, 'src')), join(sdkRoot, name, 'package.json'));
    for (const name of ['ws', 'typescript'])
        paths.push(...matterFiles(dirname(realpathSync(resolver.resolve(name + '/package.json')))));
    paths.push(realpathSync(process.execPath));
    return matterFingerprints(paths);
}
export function captureMatterAcceptance({ artifactPaths, receiptPaths = [], readClosure }) { const artifacts = matterFingerprints(Object.values(artifactPaths)), receipts = matterFingerprints(receiptPaths), closure = readClosure(); return Object.freeze({ artifacts, receipts, closure, verify() { assert.deepEqual(matterFingerprints(Object.values(artifactPaths)), artifacts, 'Copied executed artifacts changed'); assert.deepEqual(matterFingerprints(receiptPaths), receipts, 'Receipt bytes changed'); assert.deepEqual(readClosure(), closure, 'Executed closure changed'); return true; } }); }
/** Spawn ownership is adopted synchronously, before IPC readiness or caller assertions. */
export async function runMatterChild(runnerPath) {
    const child = fork(runnerPath, [], { execArgv: [], env: { NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stdout = '', stderr = '', timer, escalation;
    child.stdout.on('data', b => { stdout += b; assert.ok(stdout.length < 2 * 1024 * 1024); });
    child.stderr.on('data', b => { stderr = (stderr + b).slice(-8192); });
    const exit = new Promise((res, rej) => { child.once('error', rej); child.once('exit', (code, signal) => res({ code, signal })); });
    const close = new Promise(res => child.once('close', res));
    void exit.catch(() => { });
    let primary, outcomes;
    try {
        outcomes = await Promise.race([Promise.allSettled([exit, close]), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('Matter caller native close timeout')), 12000); })]);
        const errors = outcomes.filter(r => r.status === 'rejected').map(r => r.reason);
        if (errors.length)
            throw new AggregateError(errors, 'Matter caller child failed');
        assert.equal(outcomes[0].value.code, 0, stderr);
        assert.equal(outcomes[0].value.signal, null, stderr);
        return { childPid: child.pid, actualChildClose: true, naturalExitCode: 0, execution: JSON.parse(stdout.trim()) };
    }
    catch (e) {
        primary = e;
        throw e;
    }
    finally {
        if (timer)
            clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM');
            escalation = setTimeout(() => { if (child.exitCode === null && child.signalCode === null)
                child.kill('SIGKILL'); }, 1000);
        }
        const settled = await Promise.allSettled([exit, close]);
        if (escalation)
            clearTimeout(escalation);
        if (!primary)
            assert.ok(settled.every(r => r.status === 'fulfilled'));
    }
}
export function prepareMatterExecution({ work, installed }) {
    const root = resolve(import.meta.dirname, '..'), resolver = createRequire(import.meta.url);
    mkdirSync(join(work, 'node_modules'), { recursive: true });
    const sourceBytes = Object.fromEntries(matterOwnedFiles.map(p => [p, readFileSync(join(root, p))]));
    const artifactPaths = {};
    for (const [i, p] of matterOwnedFiles.entries()) {
        const copy = join(work, 'source-' + i + '.bin');
        writeFileSync(copy, sourceBytes[p]);
        artifactPaths[p] = copy;
    }
    const provider = join(work, 'matter-ws-switch.mjs'), caller = join(work, 'consumer.mjs'), producer = join(work, 'producer.mjs'), runner = join(work, 'run.mjs'), resolvePath = join(work, 'resolve.mjs');
    writeFileSync(provider, ts.transpileModule(sourceBytes[matterOwnedFiles[0]].toString(), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: true } }).outputText);
    const original = "'../../packages/hub-server/src/matter-ws-switch.ts'", callerBytes = sourceBytes[matterOwnedFiles[3]].toString();
    assert.equal(callerBytes.split(original).length, 2);
    writeFileSync(caller, callerBytes.replace(original, "'./matter-ws-switch.mjs'"));
    writeFileSync(producer, sourceBytes[matterOwnedFiles[2]]);
    const wsOriginal = dirname(realpathSync(resolver.resolve('ws/package.json')));
    cpSync(wsOriginal, join(work, 'node_modules/ws'), { recursive: true, dereference: false });
    const sdkRoot = dirname(dirname(dirname(realpathSync(resolver.resolve('@101/connect')))));
    if (!installed)
        for (const name of ['connect', 'device-model', 'device-runtime', 'device-web', 'transport-webrtc', 'transport-websocket', 'vision']) {
            const target = join(work, 'node_modules/@101', name), source = join(sdkRoot, name);
            mkdirSync(join(target, 'src'), { recursive: true });
            const metadata = JSON.parse(readFileSync(join(source, 'package.json')));
            metadata.exports = './src/index.js';
            writeFileSync(join(target, 'package.json'), JSON.stringify(metadata) + '\n');
            for (const path of matterFiles(join(source, 'src'))) {
                const rel = path.slice(join(source, 'src').length + 1), to = join(target, 'src', rel.replace(/\.ts$/, '.js'));
                mkdirSync(dirname(to), { recursive: true });
                writeFileSync(to, path.endsWith('.ts') ? ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: true } }).outputText : readFileSync(path));
            }
        }
    writeFileSync(resolvePath, "export const entry=import.meta.resolve('@101/connect');\n");
    writeFileSync(runner, "import {runMatterWsSwitchConsumer} from './consumer.mjs';import {entry} from './resolve.mjs';const result=await runMatterWsSwitchConsumer();console.log(JSON.stringify({publicEntry:entry,result}));\n");
    for (const [name, path] of Object.entries({ provider, caller, producer, runner, resolvePath }))
        artifactPaths[name] = path;
    return { artifactPaths, runner, wsOriginal };
}
export async function runMatterWsSwitchQa({ outputRoot = '/tmp' } = {}) { const sourceBefore = matterSourceClosure(), work = mkdtempSync(join(realpathSync(outputRoot), '101-matter-source-')), execution = prepareMatterExecution({ work }); const readClosure = () => ({ source: matterSourceClosure(), copiedDependencies: matterFingerprints(matterFiles(join(work, 'node_modules'))) }); const fence = captureMatterAcceptance({ artifactPaths: execution.artifactPaths, readClosure }); const child = await runMatterChild(execution.runner); assert.equal(child.execution.result.status, 'pass'); fence.verify(); const receipt = { schemaVersion: 1, status: 'pass', work, sourceSha256: sourceBefore, artifacts: fence.artifacts, closure: fence.closure, child, scope: 'Original native-format software stand-in and source public SDK; no native Matter server, fabric authentication, commissioning, CASE, Thread, capture-clock, hardware or full A06 proof.' }; writeFileSync(join(work, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); return receipt; }
if (process.argv[1] && process.argv[1] !== '-' && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    try {
        console.log(JSON.stringify(await runMatterWsSwitchQa()));
    }
    catch (e) {
        console.error(e);
        process.exitCode = 1;
    }
}
