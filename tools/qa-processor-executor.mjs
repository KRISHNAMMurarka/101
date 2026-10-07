import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..'), args = process.argv.slice(2);
assert.ok(args.length === 1 && args[0] === '--workspace-exports' || args.length === 2 && args[0] === '--sdk-root',
  'Usage: node tools/qa-processor-executor.mjs --workspace-exports | --sdk-root <owned installed consumer>');
const workspace = args[0] === '--workspace-exports', scratch = realpathSync(mkdtempSync(join(realpathSync('/tmp'), '101-s14-consumer-')));
const inputs = ['packages/device-runtime/src/processor-node.ts', 'packages/device-runtime/src/processor-worker.ts',
  'packages/device-runtime/src/processor-language.ts', 'packages/device-runtime/src/processor-registry.ts',
  'packages/device-runtime/src/processor-installation.ts', 'packages/device-runtime/src/runtime.ts', 'packages/device-runtime/src/types.ts',
  'packages/device-runtime/src/index.ts', 'packages/device-runtime/package.json', 'packages/device-model/src/extension-release.ts',
  'packages/device-model/src/processor-manifest.ts', 'packages/device-model/src/descriptor.ts',
  'examples/processor-executor/consumer.mjs', 'examples/external-processor/processor.mjs', 'examples/external-processor/manifest.json',
  'tools/qa-processor-executor.mjs'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pins = Object.fromEntries(inputs.map(path => [path, hash(readFileSync(join(root, path)))]));
let consumer = scratch, packed;
if (!workspace) {
  consumer = realpathSync(resolve(args[1]));
  assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-sdk-consumer-')));
  assert.equal(lstatSync(join(consumer, 'node_modules')).isSymbolicLink(), false);
  packed = JSON.parse(readFileSync(join(consumer, 'receipt.json'), 'utf8')); assert.equal(packed.status, 'pass');
  for (const path of inputs) {
    assert.equal(pins[path], hash(execFileSync('git', ['cat-file', 'blob', `${packed.source.tree}:${path}`], { cwd: root })));
    if (path.startsWith('packages/') && path.endsWith('.ts')) assert.equal(pins[path], packed.source.sha256[path]);
  }
  const bytes = readFileSync(packed.manifest.path); assert.equal(hash(bytes), packed.manifest.sha256);
  const manifest = JSON.parse(bytes); assert.equal(manifest.source.tree, packed.source.tree);
  for (const name of ['@101/device-model', '@101/device-runtime']) {
    const pkg = manifest.packages.find(value => value.name === name); assert.ok(pkg);
    const directory = join(consumer, 'node_modules', name); assert.equal(realpathSync(directory), directory);
    for (const file of pkg.files) {
      const path = join(directory, file.path); assert.equal(lstatSync(path).isSymbolicLink(), false);
      assert.equal(hash(readFileSync(path)), file.sha256);
    }
  }
}
const caller = workspace ? scratch : realpathSync(mkdtempSync(join(consumer, '.101-s14-caller-')));
copyFileSync(join(root, 'examples/processor-executor/consumer.mjs'), join(caller, 'consumer.mjs'));
copyFileSync(join(root, 'examples/external-processor/processor.mjs'), join(caller, 'processor.mjs'));
copyFileSync(join(root, 'examples/external-processor/manifest.json'), join(caller, 'manifest.json'));
let startup = '';
if (workspace) {
  const entries = { '@101/device-model': pathToFileURL(join(root, 'packages/device-model/src/index.ts')).href,
    '@101/device-runtime': pathToFileURL(join(root, 'packages/device-runtime/src/index.ts')).href };
  // Resolve the real public ./node package export, then map its model dependency to the same source tree.
  startup = `import { registerHooks, createRequire } from 'node:module';\nconst require=createRequire(${JSON.stringify(pathToFileURL(join(root, 'package.json')).href)});\nconst nodeEntry=require.resolve('@101/device-runtime/node');\nassert.equal(nodeEntry,${JSON.stringify(join(root, 'packages/device-runtime/src/processor-node.ts'))});\nconst entries=${JSON.stringify(entries)};entries['@101/device-runtime/node']=new URL('file://'+nodeEntry).href;\nregisterHooks({resolve(specifier,context,next){return next(entries[specifier]??specifier,context)}});\n`;
} else startup = `assert.equal(import.meta.resolve('@101/device-runtime/node'),new URL('./node_modules/@101/device-runtime/dist/processor-node.js',${JSON.stringify(pathToFileURL(join(consumer, 'package.json')).href)}).href);\n`;
const runner = `import assert from 'node:assert/strict';\nimport {readFileSync} from 'node:fs';\n${startup}
const {runProcessorExecutorExample}=await import('./consumer.mjs');\nconst {createTemperatureBand}=await import('./processor.mjs');\nconst result=await runProcessorExecutorExample({source:new Uint8Array(readFileSync(new URL('./processor.mjs',import.meta.url))),manifest:JSON.parse(readFileSync(new URL('./manifest.json',import.meta.url),'utf8')),factory:createTemperatureBand});\nconsole.log(JSON.stringify(result));\n`;
const path = join(caller, 'run.mjs'); writeFileSync(path, runner);
let output;
try {
  output = execFileSync(process.execPath, [...(workspace ? ['--experimental-strip-types'] : ['--no-experimental-strip-types']), path],
    { cwd: caller, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }, timeout: 15000, encoding: 'utf8' });
} catch (error) {
  writeFileSync(join(scratch, 'failure.log'), `${error.stdout ?? ''}\n${error.stderr ?? ''}`); throw error;
}
const receipt = { status: 'pass', mode: workspace ? 'workspace-public-export' : 'installed-compiled-public-export',
  sourcePins: pins, node: process.versions.node, caller, result: JSON.parse(output.trim()), ...(packed ? { distribution: packed.manifest, tree: packed.source.tree } : {}) };
writeFileSync(join(scratch, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ ...receipt, receiptPath: join(scratch, 'receipt.json') }));
