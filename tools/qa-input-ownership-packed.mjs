import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const consumer = realpathSync(resolve(process.argv[2] ?? ''));
assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-sdk-consumer-')));
assert.equal(lstatSync(join(consumer, 'node_modules')).isSymbolicLink(), false);
const packed = JSON.parse(readFileSync(join(consumer, 'receipt.json'), 'utf8'));
assert.equal(packed.status, 'pass');
const paths = ['packages/device-runtime/src/input-ownership.ts', 'examples/device-pipelines/input-ownership.ts'];
const hash = value => createHash('sha256').update(value).digest('hex');
const pins = Object.fromEntries(paths.map(path => {
  const source = readFileSync(path), immutable = execFileSync('git', ['cat-file', 'blob', `${packed.source.tree}:${path}`]);
  assert.equal(hash(source), hash(immutable)); return [path, hash(source)];
}));
assert.equal(packed.source.sha256[paths[0]], pins[paths[0]]);
assert.equal(packed.source.sha256[paths[1]], pins[paths[1]]);
const caller = `import assert from 'node:assert/strict';
import { INPUT_OWNERSHIP_PROFILE, INPUT_OWNERSHIP_LIMITS } from '@101/connect';
import { createInputOwnershipExample } from '@101/connect/examples/input-ownership';
assert.equal(INPUT_OWNERSHIP_PROFILE, 'application-input-ownership/1');
assert.equal(INPUT_OWNERSHIP_LIMITS.activationAttempts, 64);
let time=0;
const e=createInputOwnershipExample({partitioned:false,now:()=>time});
const request=source=>{const r=e.controller.request(source,'exclusive');assert.equal(r.ok,true);return r.value;};
const decide=(r,allow)=>e.controller.decide(r.id,r.expectedOwnerEpoch,allow);
const move=index=>{time+=20;e.sources[index].driver.nudge(0.02,0);e.tick();};
move(0);assert.equal(e.state().frames,0);assert.equal(e.state().grants,0);
const first=request('first');assert.equal(e.state().grants,0);assert.equal(decide(first,true).ok,true);
move(0);assert.ok(e.state().frames>0);const owner=e.controller.snapshot().slots[0].owner;
const pending=request('second');move(0);assert.deepEqual(e.controller.snapshot().slots[0].owner,owner);
assert.equal(decide({...pending,expectedOwnerEpoch:pending.expectedOwnerEpoch+1},true).ok,false);
assert.equal(decide(pending,false).ok,true);const cancelled=request('second');assert.equal(e.controller.cancel(cancelled.id).ok,true);
assert.deepEqual(e.controller.snapshot().slots[0].owner,owner);
const next=request('second');assert.equal(decide(next,true).ok,true);assert.equal(e.state().surfaces[0].position,undefined);
time+=20;e.tick();const prior=e.state().surfaces[0];move(0);assert.deepEqual(e.state().surfaces[0],prior);
move(1);assert.ok(e.state().surfaces[0].position.x>prior.position.x+0.01);
e.setGrantsEnabled(false);const denied=request('first');assert.equal(decide(denied,true).ok,false);
assert.equal(e.controller.snapshot().slots[0].owner,undefined);assert.equal(e.state().surfaces[0].position,undefined);
e.setGrantsEnabled(true);assert.equal(decide(request('first'),true).ok,true);e.interrupt();assert.equal(e.controller.snapshot().slots[0].owner,undefined);
e.stop();assert.equal(e.controller.snapshot().closed,true);assert.equal(e.state().stopped,true);
console.log(JSON.stringify({profile:INPUT_OWNERSHIP_PROFILE,resolution:import.meta.resolve('@101/connect'),example:import.meta.resolve('@101/connect/examples/input-ownership'),checks:{requestInert:true,independentHostGrants:true,incumbentRetained:true,staleEpochDenied:true,transferReleasesOld:true,oldProducerNoEffect:true,grantDenialReleased:true,explicitRetry:true,interruptAndClose:true}}));
`;
const file = join(consumer, 'input-ownership-caller.mjs'); writeFileSync(file, caller);
const env = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' };
const result = spawnSync(process.execPath, [file], { cwd: consumer, env, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
assert.equal(result.status, 0, result.stderr || result.error?.message);
const proof = JSON.parse(result.stdout);
assert.equal(proof.resolution, `file://${join(consumer, 'node_modules/@101/connect/dist/index.js')}`);
assert.equal(proof.example, `file://${join(consumer, 'node_modules/@101/connect/examples/input-ownership.js')}`);
assert.ok(Object.values(proof.checks).every(Boolean));
const receipt = { schemaVersion: 1, result: 'pass', sourceTree: packed.source.tree, sourceSha256: pins, consumer,
  qaTool: { path: 'tools/qa-input-ownership-packed.mjs', sha256: hash(readFileSync('tools/qa-input-ownership-packed.mjs')) },
  environment: { node: process.version }, callerSha256: hash(caller), proof,
  scope: 'Fresh offline public compiled Node SDK caller and actual input driver/runtime application effects. No physical or OS input claim.' };
const receiptPath = join(consumer, 'input-ownership-receipt.json'); writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ result: 'pass', receiptPath, ...receipt }));
