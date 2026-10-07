// Read-only local SDK contents QA. This does not compile, install, import or execute SDK payloads.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const names = ['@101/device-model', '@101/device-runtime', '@101/transport-webrtc', '@101/transport-websocket', '@101/device-web', '@101/vision', '@101/connect'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sha = /^[0-9a-f]{64}$/, tree = /^[0-9a-f]{40}$/;
const maximum = 1024 * 1024;
const reasons = new Set(['ok', 'invalid-arguments', 'unsupported-schema', 'artifact-integrity', 'source-identity', 'tool-identity', 'inventory-mismatch', 'undeclared-file', 'private-file', 'private-content', 'unsafe-archive', 'archive-corrupt', 'limit-exceeded', 'output-exists', 'unsafe-file', 'unavailable']);

function regular(path, bound) {
  const before = lstatSync(path);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.size <= bound);
  const bytes = readFileSync(path), after = lstatSync(path);
  assert.equal(bytes.length, before.size);
  for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(after[key], before[key]);
  return bytes;
}

function options(args) {
  assert.ok(args.length % 2 === 0 && args.length <= 40);
  const result = { workspaceRoots: [], expectedResult: 'pass' }, seen = new Set();
  const flags = new Map([
    ['--manifest', 'manifest'], ['--manifest-sha256', 'manifestSha256'], ['--artifact-root', 'artifactRoot'],
    ['--source-tree', 'sourceTree'], ['--audit-tool-sha256', 'auditToolSha256'], ['--python', 'python'],
    ['--output-root', 'outputRoot'], ['--prefix-receipt', 'prefixReceipt'], ['--prefix-sha256', 'prefixSha256'],
    ['--producer-receipt', 'producerReceipt'], ['--producer-receipt-sha256', 'producerReceiptSha256'],
    ['--expect-result', 'expectedResult'], ['--expect-reason', 'expectedReason'],
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    assert.ok(typeof value === 'string' && value.length > 0 && value.length <= 2048 && !Array.from(value).some(character => character.charCodeAt(0) < 32));
    if (flag === '--workspace-root') { assert.ok(isAbsolute(value)); result.workspaceRoots.push(value); continue; }
    const name = flags.get(flag); assert.ok(name && !seen.has(name)); seen.add(name); result[name] = value;
  }
  assert.ok(result.manifest && result.artifactRoot && result.python);
  assert.match(result.manifestSha256, sha); assert.match(result.sourceTree, tree); assert.match(result.auditToolSha256, sha);
  assert.ok(result.workspaceRoots.length >= 1 && result.workspaceRoots.length <= 4);
  assert.ok(['pass', 'fail'].includes(result.expectedResult));
  assert.ok(!result.expectedReason || reasons.has(result.expectedReason));
  for (const [path, digest] of [['prefixReceipt', 'prefixSha256'], ['producerReceipt', 'producerReceiptSha256']]) {
    assert.equal(Boolean(result[path]), Boolean(result[digest])); if (result[digest]) assert.match(result[digest], sha);
  }
  return result;
}

export function runSdkContentsQa(args) {
  const selected = options(args), logicalBase = resolve(selected.artifactRoot);
  assert.ok(lstatSync(logicalBase).isDirectory() && !lstatSync(logicalBase).isSymbolicLink());
  const base = realpathSync(logicalBase), manifestPath = realpathSync(resolve(selected.manifest));
  assert.equal(dirname(manifestPath), base);
  const bytes = regular(manifestPath, maximum); assert.equal(hash(bytes), selected.manifestSha256);
  const manifest = JSON.parse(bytes); assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.source.tree, selected.sourceTree);
  assert.ok(isAbsolute(manifest.outputDir));
  assert.deepEqual(manifest.packages.map(item => item.name).sort(), [...names].sort());
  const identities = [];
  for (const item of manifest.packages) {
    assert.match(item.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    const expected = `tarballs/${item.name.slice(1).replace('/', '-')}-${item.version}.tgz`;
    assert.equal(relative(manifest.outputDir, item.tarball).replaceAll('\\', '/'), expected);
    assert.equal(relative(manifest.outputDir, item.directory).replaceAll('\\', '/'), `packages/${item.name.slice(5)}`);
    const tarball = join(base, expected);
    assert.ok(tarball.startsWith(base + sep) && realpathSync(tarball) === tarball);
    const archive = regular(tarball, 2 * maximum); assert.equal(hash(archive), item.sha256); assert.equal(archive.length, item.bytes);
    assert.ok(Array.isArray(item.files) && item.files.length > 0 && item.files.length <= 256);
    identities.push({ name: item.name, tarballSha256: item.sha256, bytes: archive.length, files: item.files.length });
  }
  const linked = {};
  for (const [path, digest] of [['prefixReceipt', 'prefixSha256'], ['producerReceipt', 'producerReceiptSha256']]) {
    if (selected[path]) { const data = regular(resolve(selected[path]), maximum); assert.equal(hash(data), selected[digest]); linked[digest] = hash(data); }
  }
  const logicalOutput = selected.outputRoot ? resolve(selected.outputRoot) : mkdtempSync(join(tmpdir(), '101-sdk-content-qa-'));
  if (selected.outputRoot) mkdirSync(logicalOutput, { recursive: false });
  const output = realpathSync(logicalOutput), tool = fileURLToPath(new URL('./audit-sdk-contents.py', import.meta.url));
  const auditOutput = join(output, 'content-audit.json');
  const childArgs = ['-I', '-S', '-B', tool, '--manifest', manifestPath, '--manifest-sha256', selected.manifestSha256,
    '--artifact-root', base, '--source-tree', selected.sourceTree, '--audit-tool-sha256', selected.auditToolSha256, '--output', auditOutput];
  for (const root of selected.workspaceRoots) childArgs.push('--workspace-root', root);
  const child = spawnSync(selected.python, childArgs, { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: maximum,
    env: { ...process.env, PYTHONPATH: undefined, PYTHONHOME: undefined } });
  const stdout = child.stdout ?? '', stderr = child.stderr ?? '';
  writeFileSync(join(output, 'audit.stdout'), stdout, { flag: 'wx' }); writeFileSync(join(output, 'audit.stderr'), stderr, { flag: 'wx' });
  const childIssued = Number.isInteger(child.pid) && child.pid > 0;
  const childSettled = !childIssued || child.status !== null || child.signal !== null;
  let audit = null;
  if (existsSync(auditOutput)) { try { audit = JSON.parse(regular(auditOutput, maximum)); } catch { audit = null; } }
  const valid = audit?.schemaVersion === 1 && audit?.auditProfile === 'sdk-content-audit/1'
    && audit?.sdkManifestSha256 === selected.manifestSha256 && audit?.sourceTree === selected.sourceTree
    && audit?.toolSha256 === selected.auditToolSha256 && ['pass', 'fail'].includes(audit?.result) && reasons.has(audit?.reason);
  const matches = valid && audit.result === selected.expectedResult && (!selected.expectedReason || audit.reason === selected.expectedReason)
    && child.status === (selected.expectedResult === 'pass' ? 0 : 1) && child.signal === null && !child.error;
  const receipt = { schemaVersion: 1, qaProfile: 'sdk-content-qa/1', result: matches && childSettled ? 'pass' : 'fail',
    reason: !existsSync(tool) ? 'audit-command-unavailable' : matches ? 'expected-audit-verdict' : 'audit-verdict-mismatch',
    sdkManifestSha256: selected.manifestSha256, sourceTree: selected.sourceTree, auditToolSha256: selected.auditToolSha256,
    outerManifestBound: true, artifacts: identities, ...linked, prefixArchiveChecksRunHere: false, producerRunsHere: false,
    childIssued, childSettled, rawChildrenAtReturn: childSettled ? 0 : 1, childExitCode: child.status, childSignal: child.signal,
    childErrorCode: !child.error ? null : ['ENOENT', 'EACCES', 'ETIMEDOUT', 'ENOBUFS', 'EINVAL'].includes(child.error.code) ? child.error.code : 'unknown',
    stdoutSha256: hash(stdout), stderrSha256: hash(stderr), auditReceiptSha256: valid ? hash(regular(auditOutput, maximum)) : null,
    auditResult: valid ? audit.result : null, auditReason: valid ? audit.reason : null,
    productPayloadExecution: false, decoderOrAbiQualification: false, releaseAccepted: false };
  writeFileSync(join(output, 'qa-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' }); return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const receipt = runSdkContentsQa(process.argv.slice(2)); console.log(JSON.stringify(receipt)); if (receipt.result !== 'pass') process.exitCode = 1; }
  catch { console.log(JSON.stringify({ schemaVersion: 1, qaProfile: 'sdk-content-qa/1', result: 'fail', reason: 'qa-prerequisite-failed', productPayloadExecution: false, releaseAccepted: false })); process.exitCode = 1; }
}
