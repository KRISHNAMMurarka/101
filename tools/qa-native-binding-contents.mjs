// Local content QA only. This never builds, extracts, imports or executes bindings.
// A root-owned real tar/JAR prefix is retained separately and may be pinned here.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const languages = ['swift', 'kotlin', 'c'];
const shaPattern = /^[0-9a-f]{64}$/;
const maximumBytes = 1024 * 1024;
const auditReasons = new Set(['ok', 'invalid-arguments', 'unsupported-schema', 'artifact-integrity',
  'inventory-mismatch', 'metadata-invalid', 'undeclared-file', 'forbidden-metadata', 'private-file',
  'private-content', 'unsafe-archive', 'archive-corrupt', 'unsupported-compression', 'limit-exceeded',
  'output-exists', 'unsafe-file', 'unavailable']);

function regular(path, maximum) {
  const info = lstatSync(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= maximum);
  return readFileSync(path);
}

function options(args) {
  const result = { workspaceRoots: [], expectedResult: 'pass' };
  const seen = new Set();
  const names = new Map([
    ['--manifest', 'manifest'], ['--manifest-sha256', 'manifestSha256'],
    ['--artifact-root', 'artifactRoot'], ['--python', 'python'], ['--output-root', 'outputRoot'],
    ['--prefix-receipt', 'prefixReceipt'], ['--prefix-sha256', 'prefixSha256'],
    ['--expect-result', 'expectedResult'], ['--expect-reason', 'expectedReason'],
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    assert.ok(typeof value === 'string' && value.length > 0 && value.length <= 2048 && !value.includes('\0'));
    if (flag === '--workspace-root') {
      assert.ok(isAbsolute(value)); result.workspaceRoots.push(value); continue;
    }
    const name = names.get(flag);
    assert.ok(name && !seen.has(name)); seen.add(name);
    result[name] = value;
  }
  assert.ok(result.manifest && result.artifactRoot && result.python && shaPattern.test(result.manifestSha256));
  assert.ok(result.workspaceRoots.length >= 1 && result.workspaceRoots.length <= 4);
  assert.ok(result.expectedResult === 'pass' || result.expectedResult === 'fail');
  assert.ok(!result.expectedReason || auditReasons.has(result.expectedReason));
  assert.equal(Boolean(result.prefixReceipt), Boolean(result.prefixSha256));
  if (result.prefixSha256) assert.match(result.prefixSha256, shaPattern);
  return result;
}

export function runNativeBindingContentsQa(args) {
  const selected = options(args);
  const logicalBase = resolve(selected.artifactRoot), logicalManifest = resolve(selected.manifest);
  assert.ok(lstatSync(logicalBase).isDirectory() && !lstatSync(logicalBase).isSymbolicLink());
  const base = realpathSync(logicalBase), manifestBytes = regular(logicalManifest, maximumBytes);
  const manifestPath = realpathSync(logicalManifest);
  assert.equal(dirname(manifestPath), base);
  assert.equal(hash(manifestBytes), selected.manifestSha256);
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.profile, 'normalized-pointer-bindings/1');
  assert.equal(manifest.version, '1.0.0'); assert.equal(manifest.authority, 'inert-codec-only');
  assert.ok(Array.isArray(manifest.artifacts) && manifest.artifacts.length === 3);
  const identities = [];
  for (const language of languages) {
    const records = manifest.artifacts.filter(record => record.language === language);
    assert.equal(records.length, 1);
    const record = records[0];
    assert.equal(record.directory, language); assert.ok(Array.isArray(record.files) && record.files.length <= 64);
    assert.equal(record.tarball.path, `tarballs/one01-pointer-${language}-1.0.0.tgz`);
    const tarball = join(base, record.tarball.path);
    assert.ok(tarball.startsWith(base + sep));
    assert.equal(realpathSync(tarball), tarball, 'Interior artifact symlinks are refused');
    const bytes = regular(tarball, 2 * maximumBytes);
    assert.equal(bytes.length, record.tarball.bytes); assert.equal(hash(bytes), record.tarball.sha256);
    identities.push({ language, files: record.files.length, tarballSha256: hash(bytes), bytes: bytes.length });
  }
  let prefixReceiptSha256 = null;
  if (selected.prefixReceipt) {
    // This binds a caller-retained prefix receipt, not a new tar/JAR verification.
    // No fields are copied from it, so private diagnostics cannot enter this report.
    const bytes = regular(resolve(selected.prefixReceipt), maximumBytes);
    assert.equal(hash(bytes), selected.prefixSha256);
    prefixReceiptSha256 = hash(bytes);
  }
  const logicalOutput = selected.outputRoot ? resolve(selected.outputRoot) : mkdtempSync(join(tmpdir(), '101-native-content-qa-'));
  if (selected.outputRoot) mkdirSync(logicalOutput, { recursive: false });
  const output = realpathSync(logicalOutput);
  const tool = fileURLToPath(new URL('./audit-native-binding-contents.py', import.meta.url));
  const auditOutput = join(output, 'content-audit.json');
  const childArgs = ['-I', '-S', '-B', tool, '--manifest', manifestPath, '--manifest-sha256', selected.manifestSha256,
    '--artifact-root', base, '--output', auditOutput];
  for (const root of selected.workspaceRoots) childArgs.push('--workspace-root', root);
  const child = spawnSync(selected.python, childArgs, {
    encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: maximumBytes,
    env: { ...process.env, PYTHONPATH: undefined, PYTHONHOME: undefined },
  });
  const stdout = child.stdout ?? '', stderr = child.stderr ?? '';
  writeFileSync(join(output, 'audit.stdout'), stdout, { flag: 'wx' });
  writeFileSync(join(output, 'audit.stderr'), stderr, { flag: 'wx' });
  const childIssued = Number.isInteger(child.pid) && child.pid > 0;
  const childSettled = !childIssued || child.status !== null || child.signal !== null;
  let audit = null;
  if (existsSync(auditOutput)) {
    try { audit = JSON.parse(regular(auditOutput, maximumBytes)); } catch { audit = null; }
  }
  const available = existsSync(tool);
  const validReport = audit?.schemaVersion === 1 && audit?.auditProfile === 'native-binding-content-audit/1'
    && audit?.bindingManifestSha256 === selected.manifestSha256
    && (audit?.result === 'pass' || audit?.result === 'fail')
    && auditReasons.has(audit?.reason);
  const matches = validReport && audit.result === selected.expectedResult
    && (!selected.expectedReason || audit.reason === selected.expectedReason)
    && child.status === (selected.expectedResult === 'pass' ? 0 : 1) && child.signal === null && !child.error;
  const receipt = {
    schemaVersion: 1, qaProfile: 'native-binding-content-qa/1', result: matches && childSettled ? 'pass' : 'fail',
    reason: !available ? 'audit-command-unavailable' : matches ? 'expected-audit-verdict' : 'audit-verdict-mismatch',
    bindingManifestSha256: selected.manifestSha256, outerManifestBound: true, artifacts: identities,
    prefixReceiptSha256, prefixArchiveChecksRunHere: false, expectedResult: selected.expectedResult,
    expectedReason: selected.expectedReason ?? null,
    auditCommandAvailable: available, childIssued, childSettled, rawChildrenAtReturn: childSettled ? 0 : 1,
    childExitCode: child.status, childSignal: child.signal,
    childErrorCode: !child.error ? null : ['ENOENT', 'EACCES', 'ETIMEDOUT', 'ENOBUFS', 'EINVAL'].includes(child.error.code) ? child.error.code : 'unknown',
    stdoutSha256: hash(stdout), stderrSha256: hash(stderr),
    auditReceiptSha256: validReport ? hash(regular(auditOutput, maximumBytes)) : null,
    auditResult: validReport ? audit.result : null, auditReason: validReport ? audit.reason : null,
    nativeBindingBuildOrExecution: false, decoderOrAbiQualification: false, releaseAccepted: false,
  };
  writeFileSync(join(output, 'qa-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const receipt = runNativeBindingContentsQa(process.argv.slice(2));
    console.log(JSON.stringify(receipt));
    if (receipt.result !== 'pass') process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({ schemaVersion: 1, qaProfile: 'native-binding-content-qa/1',
      result: 'fail', reason: 'qa-prerequisite-failed', nativeBindingBuildOrExecution: false, releaseAccepted: false }));
    process.exitCode = 1;
  }
}
