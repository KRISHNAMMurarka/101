#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..'), args = process.argv.slice(2);
assert.ok(args[0] === '--sdk-root' && typeof args[1] === 'string');
const trailing = args.slice(2), candidate = trailing[0] === '--candidate-tree' ? trailing[1] : undefined;
const remaining = candidate ? trailing.slice(2) : trailing;
assert.ok(remaining.length === 0 || remaining.length === 1 && remaining[0] === '--unsafe-composition-red');
assert.ok(candidate === undefined || /^[0-9a-f]{40}$/.test(candidate));
const consumer = realpathSync(resolve(args[1])), unsafe = args.includes('--unsafe-composition-red');
assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-sdk-consumer-')));
const image = 'sha256:6dac556d980b7f0e5498d08f08cee0ca67798b4ad6c23964a9214920e67758d0';
const socket = 'unix:///Users/km/.docker/run/docker.sock', docker = '/usr/local/bin/docker';
const environment = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }; delete environment.DOCKER_HOST; delete environment.DOCKER_CONTEXT;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const command = parameters => execFileSync(docker, ['--host', socket, ...parameters], { env: environment, encoding: 'utf8', timeout: 3000, maxBuffer: 1048576 }).trim();
const engine = JSON.parse(command(['version', '--format', '{{json .Server}}']));
assert.equal(engine.Os, 'linux'); assert.equal(engine.Arch, 'arm64');
const cached = JSON.parse(command(['image', 'inspect', image]))[0];
assert.equal(cached.Id, image); assert.equal(cached.Os, 'linux'); assert.equal(cached.Architecture, 'arm64');
const receipt = JSON.parse(readFileSync(join(consumer, 'receipt.json'))); assert.equal(receipt.status, 'pass');
const sourcePins = receipt.source.sha256;
const owned = ['examples/headless-linux/client.mjs', 'examples/headless-linux/process-port.mjs', 'tools/qa-headless-linux.mjs'];
if (candidate) for (const path of owned) assert.equal(hash(readFileSync(join(root, path))), hash(execFileSync('git', ['cat-file', 'blob', `${candidate}:${path}`], { cwd: root })));
for (const [path, pin] of Object.entries(sourcePins)) {
  assert.equal(hash(readFileSync(join(root, path))), pin);
  assert.equal(hash(execFileSync('git', ['cat-file', 'blob', `${receipt.source.tree}:${path}`], { cwd: root })), pin);
}
const manifestBytes = readFileSync(receipt.manifest.path); assert.equal(hash(manifestBytes), receipt.manifest.sha256);
const manifest = JSON.parse(manifestBytes); assert.equal(manifest.source.tree, receipt.source.tree);
const names = ['device-model', 'device-runtime', 'transport-webrtc', 'transport-websocket', 'device-web', 'vision', 'connect'];
assert.equal(manifest.packages.length, names.length);
function files(directory, prefix = '') {
  return readdirSync(directory).sort().flatMap(name => {
    const path = join(directory, name), relative = prefix + name, stat = lstatSync(path);
    assert.equal(stat.isSymbolicLink(), false); assert.equal(realpathSync(path), path);
    return stat.isDirectory() ? files(path, relative + '/') : (assert.ok(stat.isFile()), [relative]);
  });
}
const work = realpathSync(mkdtempSync(join(tmpdir(), '101-headless-linux-'))); chmodSync(work, 0o755);
let id;
try {
  const inputPins = {};
  const copy = (source, destination) => { mkdirSync(dirname(destination), { recursive: true, mode: 0o755 }); copyFileSync(source, destination); chmodSync(destination, 0o644); };
  for (const name of names) {
    const item = manifest.packages.find(value => value.name === '@101/' + name); assert.ok(item && item.files.length > 0 && item.files.length <= 1024);
    const directory = join(consumer, 'node_modules', '@101', name); assert.equal(realpathSync(directory), directory);
    assert.deepEqual(files(directory), item.files.map(file => file.path).sort());
    for (const file of item.files) { assert.equal(hash(readFileSync(join(directory, file.path))), file.sha256); copy(join(directory, file.path), join(work, 'node_modules', '@101', name, file.path)); }
  }
  for (const [source, destination] of [['examples/device-profiles/node-memory-producer.mjs', 'producer.mjs'], ['examples/device-profiles/node-memory-profile.ts', 'profile.mjs']]) {
    const bytes = readFileSync(join(root, source)); assert.equal(hash(bytes), hash(execFileSync('git', ['cat-file', 'blob', `${receipt.source.tree}:${source}`], { cwd: root })));
    const output = source.endsWith('.ts') ? Buffer.from(ts.transpileModule(bytes.toString(), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText) : bytes;
    writeFileSync(join(work, destination), output, { mode: 0o644 }); inputPins[destination] = hash(output); inputPins[source] = hash(bytes);
  }
  assert.equal(inputPins['producer.mjs'], '7bb4137d774b85ad461413962e9f95cf1cb67679a49d4cf21bb7c8ea8f09c59b');
  if (unsafe) {
    const baseline = `import assert from 'node:assert/strict';import{spawn}from'node:child_process';import{readFileSync}from'node:fs';
const source=readFileSync('/input/producer.mjs','utf8'),child=spawn(process.execPath,['--max-old-space-size=32','--input-type=module','--eval',source+'\\nrunProducer();'],{stdio:['pipe','pipe','pipe']});
let tail='',initial,observed;child.stdout.on('data',chunk=>{tail+=chunk;for(let i;(i=tail.indexOf('\\n'))>=0;){const frame=JSON.parse(tail.slice(0,i));tail=tail.slice(i+1);if(frame.kind==='reading'){initial??=frame;if(frame.enabled)observed=frame;}}});
const until=async check=>{const deadline=performance.now()+1500;while(!check()){assert.ok(performance.now()<deadline,'actual producer feedback');await new Promise(r=>setTimeout(r,5));}};
const ended=new Promise(r=>child.once('close',r));try{await until(()=>initial);const abort=new AbortController();abort.abort();const context={signal:abort.signal,isCurrent:()=>false};
// Unsafe composition before a guarded owned port: ignores the cancelled context.
const unsafeWrite=(bytes,_context)=>child.stdin.write(bytes);unsafeWrite(JSON.stringify({wireVersion:1,kind:'command',resourceId:'sampling',commandId:'1',value:true})+'\\n',context);await until(()=>observed);
console.log(JSON.stringify({profile:'linux-node-rss/1',baseline:'unsafe-composition-not-product-bug',platform:process.platform,arch:process.arch,node:process.version,sourceSha256:'${inputPins['producer.mjs']}',rssBytes:observed.rssBytes,enabled:observed.enabled,alreadyRevoked:true}));assert.equal(observed.enabled,false,'cancelled context must not dispatch an owned target command');
}finally{child.stdin.end();await ended;}`;
    writeFileSync(join(work, 'client.mjs'), baseline, { mode: 0o644 }); inputPins['client.mjs'] = hash(baseline);
  } else {
    for (const [path, destination] of [['examples/headless-linux/client.mjs', 'client.mjs'], ['examples/headless-linux/process-port.mjs', 'process-port.mjs']]) {
      copy(join(root, path), join(work, destination)); inputPins[destination] = hash(readFileSync(join(root, path)));
    }
  }
  writeFileSync(join(work, 'inputs.json'), JSON.stringify({ profile: 'linux-node-rss/1', image, sdkTree: receipt.source.tree, inputPins, packageManifestSha256: receipt.manifest.sha256 }), { mode: 0o644 });
  const label = '101-headless-' + randomUUID();
  id = command(['create', '--pull=never', '--platform=linux/arm64', '--name', label, '--label', '101.owned=' + label,
    '--network=none', '--read-only', '--user=65534:65534', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--memory=256m', '--memory-swap=256m', '--pids-limit=32', '--cpus=0.5', '--tmpfs=/tmp:rw,noexec,nosuid,size=1m',
    '--mount', `type=bind,source=${work},target=/input,readonly`, '--workdir=/input', '--entrypoint=/usr/local/bin/node', image,
    '--max-old-space-size=32', '--no-experimental-strip-types', '/input/client.mjs']);
  assert.match(id, /^[0-9a-f]{64}$/);
  const provisioned = JSON.parse(command(['inspect', id]))[0];
  assert.equal(provisioned.Image, image); assert.equal(provisioned.Config.User, '65534:65534');
  assert.equal(provisioned.HostConfig.NetworkMode, 'none'); assert.equal(provisioned.HostConfig.ReadonlyRootfs, true);
  assert.equal(provisioned.HostConfig.Privileged, false); assert.equal(provisioned.HostConfig.Memory, 268435456); assert.equal(provisioned.HostConfig.MemorySwap, 268435456);
  assert.equal(provisioned.HostConfig.PidsLimit, 32); assert.equal(provisioned.HostConfig.NanoCpus, 500000000); assert.deepEqual(provisioned.HostConfig.CapDrop, ['ALL']);
  assert.deepEqual(provisioned.HostConfig.SecurityOpt, ['no-new-privileges']); assert.deepEqual(provisioned.HostConfig.Tmpfs, { '/tmp': 'rw,noexec,nosuid,size=1m' });
  assert.equal(provisioned.Mounts.length, 1); assert.equal(provisioned.Mounts[0].Source, work); assert.equal(provisioned.Mounts[0].Destination, '/input'); assert.equal(provisioned.Mounts[0].RW, false);
  const started = performance.now(), result = spawnSync(docker, ['--host', socket, 'start', '--attach', id], { env: environment, encoding: 'utf8', timeout: 10000, maxBuffer: 1048576 });
  if (result.error || result.status === null) command(['kill', id]);
  const state = JSON.parse(command(['inspect', '--format', '{{json .State}}', id]));
  console.log(JSON.stringify({ profile: 'linux-node-rss/1', image, engine: { version: engine.Version, kernel: engine.KernelVersion, arch: engine.Arch },
    sdkTree: receipt.source.tree, sdkSourceCount: Object.keys(sourcePins).length, manifestSha256: receipt.manifest.sha256, inputPins,
    qaSha256: hash(readFileSync(import.meta.filename)), candidateTree: candidate ?? null, ownedSha256: Object.fromEntries(owned.filter(path => !unsafe || path.endsWith('qa-headless-linux.mjs')).map(path => [path, hash(readFileSync(join(root, path)))])), container: { status: result.status, elapsedMs: performance.now() - started, oomKilled: state.OOMKilled, exitCode: state.ExitCode },
    target: result.stdout.trim() ? JSON.parse(result.stdout.trim()) : null, stderr: result.stderr.trim() }, null, 2));
  assert.equal(result.status, 0, result.stderr || result.error?.message); assert.equal(state.OOMKilled, false); assert.equal(state.ExitCode, 0);
} finally { if (id) command(['rm', '--force', id]); rmSync(work, { recursive: true, force: true }); }
