import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const consumer = realpathSync(resolve(process.argv[2] ?? ''));
assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-sdk-consumer-')), 'Use an owned external packed SDK consumer');
assert.ok(!lstatSync(join(consumer, 'node_modules')).isSymbolicLink(), 'The external install must not use aliases or symlinks');
const packed = JSON.parse(readFileSync(join(consumer, 'receipt.json'), 'utf8'));
assert.equal(packed.status, 'pass'); assert.match(packed.source?.tree ?? '', /^[a-f0-9]{40}$/);
const hash = source => createHash('sha256').update(source).digest('hex');
const paths = ['packages/device-model/src/connector-profile.ts', 'packages/device-model/src/connector-profile.test.ts',
  'packages/device-runtime/src/profile-connector.ts', 'packages/device-runtime/src/profile-connector.test.ts',
  'examples/device-profiles/node-memory-profile.ts', 'examples/device-profiles/node-memory-producer.mjs',
  'examples/device-profiles/consumer.mjs', 'tools/qa-connector-profiles.mjs'];
const fingerprints = Object.fromEntries(paths.map(path => {
  const source = readFileSync(join(root, path));
  const immutable = execFileSync('git', ['cat-file', 'blob', `${packed.source.tree}:${path}`], { cwd: root, timeout: 5000, maxBuffer: 1048576 });
  assert.equal(hash(source), hash(immutable), `Caller source differs from packed immutable tree: ${path}`);
  if (path.endsWith('/connector-profile.ts') || path.endsWith('/profile-connector.ts')) assert.equal(packed.source.sha256[path], hash(source), `SDK source pin missing: ${path}`);
  return [path, hash(source)];
}));
const directory = join(consumer, 'connector-profile-caller'); mkdirSync(directory, { recursive: true });
copyFileSync(join(root, 'examples/device-profiles/node-memory-producer.mjs'), join(directory, 'node-memory-producer.mjs'));
const profile = ts.transpileModule(readFileSync(join(root, 'examples/device-profiles/node-memory-profile.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, reportDiagnostics: true,
});
assert.equal(profile.diagnostics?.length ?? 0, 0);
writeFileSync(join(directory, 'node-memory-profile.js'), profile.outputText);
writeFileSync(join(directory, 'consumer.mjs'), readFileSync(join(root, 'examples/device-profiles/consumer.mjs'), 'utf8').replace("'./node-memory-profile.ts'", "'./node-memory-profile.js'"));
writeFileSync(join(directory, 'public-resolution.mjs'), `console.log(JSON.stringify(Object.fromEntries(['connect','device-model','device-runtime'].map(name=>[name,import.meta.resolve('@101/'+name)]))));\n`);
const environment = { ...process.env }; delete environment.NODE_OPTIONS; delete environment.NODE_PATH;
function run(file) {
  const result = spawnSync(process.execPath, [join(directory, file)], { cwd: consumer, env: environment, encoding: 'utf8', timeout: 8000, maxBuffer: 131072 });
  assert.equal(result.status, 0, `Actual public Node caller failed: ${result.error?.code ?? result.stderr.slice(0, 1200)}`);
  return JSON.parse(result.stdout);
}
const resolutions = run('public-resolution.mjs');
for (const [name, url] of Object.entries(resolutions)) assert.equal(url, `file://${join(consumer, 'node_modules', '@101', name, 'dist', 'index.js')}`);
const result = run('consumer.mjs');
assert.equal(result.kind, 'actual-node-rss'); assert.ok(result.readings.length > 0 && result.readings.length <= 32);
assert.equal(result.sourceSha256, fingerprints['examples/device-profiles/node-memory-producer.mjs']);
assert.ok(Object.values(result.checks).every(value => value === true));
const receipt = { schemaVersion: 1, status: 'pass', createdAt: new Date().toISOString(), environment: { node: process.version },
  consumer, sourceTree: packed.source.tree, sourceSha256: fingerprints, publicEsmResolutions: resolutions,
  callerFiles: Object.fromEntries(['consumer.mjs', 'node-memory-profile.js', 'node-memory-producer.mjs'].map(file => [file, hash(readFileSync(join(directory, file)))])), result };
const receiptPath = join(consumer, 'connector-profile-receipt.json'); writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ status: 'pass', receiptPath, sourceTree: packed.source.tree, readings: result.readings.length, checks: result.checks }));
