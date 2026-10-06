import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';

const consumer = realpathSync(resolve(process.argv[2] ?? ''));
assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-sdk-consumer-')));
assert.equal(lstatSync(join(consumer, 'node_modules')).isSymbolicLink(), false);
const packed = JSON.parse(readFileSync(join(consumer, 'receipt.json'), 'utf8'));
assert.equal(packed.status, 'pass');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const paths = ['packages/device-model/src/pipeline-timing.ts', 'packages/device-web/src/binding.ts',
  'packages/device-web/src/wire.ts', 'examples/device-pipelines/timed-pointer.ts'];
const pins = Object.fromEntries(paths.map(path => {
  const bytes = readFileSync(path), immutable = execFileSync('git', ['cat-file', 'blob', `${packed.source.tree}:${path}`]);
  assert.equal(hash(bytes), hash(immutable)); assert.equal(packed.source.sha256[path], hash(bytes)); return [path, hash(bytes)];
}));
const caller = `import {createTimedPointerExample} from '@101/connect/examples/timed-pointer';
const check=(value,message)=>{if(!value)throw new Error(message);};
export async function run(browser=false){
 let position, effects=0, released=0, pendingFrames=0;
 const element=browser?document.querySelector('#pointer'):undefined;
 const e=createTimedPointerExample({now:()=>performance.now(),capacity:64,release:()=>{position=undefined;released++;if(element)element.hidden=true;},
   output:async(value,context)=>{
    check(context.isCurrent()&&!context.signal.aborted,'current sink before effect');position=value;effects++;
    if(element){element.hidden=false;element.style.left=(value.x*400)+'px';element.style.top=(value.y*200)+'px';}
    if(!browser){await new Promise(resolve=>setTimeout(resolve,1));return;}
    await new Promise(resolve=>{
      pendingFrames++;
      let frame;
      const finish=()=>{cancelAnimationFrame(frame);context.signal.removeEventListener('abort',finish);pendingFrames--;resolve();};
      context.signal.addEventListener('abort',finish,{once:true});
      frame=requestAnimationFrame(()=>{frame=requestAnimationFrame(finish);});
    });
   }});
 async function until(predicate){const deadline=performance.now()+3000;while(!predicate()){check(performance.now()<deadline,'local pipeline condition');e.tick();await new Promise(resolve=>setTimeout(resolve,2));}}
 let final;
 try{
  await until(()=>e.descriptionReady());check(!e.publish({x:.2,y:.8})&&effects===0,'no output before host grant');
  check(e.approve(),'explicit current host grant');await until(()=>e.ready());
  for(let index=0;index<64;index++){
    const value={x:index%2?.2:.8,y:index%2?.8:.2};
    const capturedAt=performance.now();
    check(e.publish(value,capturedAt),'actual typed producer admitted');
    await until(()=>e.snapshot().timing.accepted>index);
    check(Math.abs(position.x-value.x)<1e-7&&Math.abs(position.y-value.y)<1e-7,'actual selected sink value');
    if(element){const rect=element.getBoundingClientRect(),surface=element.parentElement.getBoundingClientRect();check(Math.abs((rect.left-surface.left)/400-value.x)<.001,'actual DOM position');}
    await new Promise(resolve=>setTimeout(resolve,18));
  }
  final=e.snapshot();check(final.timing.samples===64&&final.timing.rejected===0,'complete bounded timing samples');
  for(const [stage,distribution] of Object.entries(final.timing.stages))for(const quantile of ['p50','p95','p99']){
    const value=distribution[quantile];check(value&&Number.isFinite(value.minMs)&&value.minMs>=0&&value.maxMs>=value.minMs,'conservative '+stage+' '+quantile);
  }
  check(final.timing.maxClockUncertaintyMs>=0,'actual clock exchange uncertainty');
  check(!JSON.stringify(final).includes('epoch')&&!JSON.stringify(final).includes('value'),'aggregate contains no payload or session identifiers');
 }finally{e.close();}
 check(e.snapshot().closed&&e.snapshot().timing.closed&&e.snapshot().pending===0&&e.snapshot().timing.samples===0,'close clears local trace buffers');
 check(released>0&&position===undefined&&pendingFrames===0,'release and owned frame cleanup');
 check(!e.publish({x:.5,y:.5}),'closed pipeline rejects new work');
 return {profile:final.timing.profile,measurement:'JavaScript capture to declared local output commit',transport:'native local MessageChannel',distribution:final.timing,unmatched:final.unmatched,effects,released,pendingFrames,
   checks:{selectionBeforeEffect:true,genuineCodecAndClockExchange:true,currentSinkEffect:true,allStageQuantiles:true,uncertaintyPreserved:true,aggregateRedaction:true,releaseAndClosedBuffers:true},
   limits:'Serial 64-frame diagnostic workload, not throughput, impairment, physical acquisition or display photon evidence.'};
}
`;
const nodeCaller = join(consumer, 'pipeline-timing-caller.mjs');
writeFileSync(nodeCaller, caller + '\nconsole.log(JSON.stringify(await run()));\n');
const result = spawnSync(process.execPath, ['--no-experimental-strip-types', nodeCaller], {
  cwd: consumer, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }, encoding: 'utf8', timeout: 10000, maxBuffer: 65536,
});
assert.equal(result.status, 0, result.stderr || result.error?.message);
const proof = { node: JSON.parse(result.stdout), browsers: {} };
const imports = JSON.parse(readFileSync(join(consumer, 'browser-import-map.json'), 'utf8'));
const served = new Map();
const manifestBytes = readFileSync(packed.manifest.path);
assert.equal(hash(manifestBytes), packed.manifest.sha256);
const manifest = JSON.parse(manifestBytes);
for (const item of manifest.packages) for (const file of item.files) {
  if (file.path.endsWith('.js')) {
    const path = join(consumer, 'node_modules', item.name, file.path);
    assert.equal(hash(readFileSync(path)), file.sha256);
    served.set(`/packages/${item.name.slice('@101/'.length)}/${file.path}`, path);
  }
}
const html = `<!doctype html><meta charset="utf-8"><title>Local timing consumer</title><script type="importmap">${JSON.stringify(imports)}</script><div style="position:relative;width:400px;height:200px"><span id="pointer" hidden style="position:absolute;width:4px;height:4px;background:black"></span></div>`;
const server = createServer((request, response) => {
  if (request.method !== 'GET' || !['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) return response.writeHead(403).end();
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
  if (path === '/') return response.writeHead(200, { 'Content-Type': 'text/html' }).end(html);
  if (path === '/caller.mjs') return response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(caller);
  if (path === '/favicon.ico') return response.writeHead(204).end();
  if (served.has(path)) return response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(readFileSync(served.get(path)));
  response.writeHead(404).end();
});
await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  for (const [name, type] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await type.launch({ headless: true });
    try {
      const page = await browser.newPage(), errors = [], foreign = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        if (new URL(route.request().url()).origin !== origin) { foreign.push(route.request().url()); return route.abort(); }
        return route.continue();
      });
      await page.goto(origin);
      const outcome = await page.evaluate(async () => (await import('/caller.mjs')).run(true));
      assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
      proof.browsers[name] = { version: browser.version(), ...outcome, pageErrors: errors, foreignRequests: foreign };
    } finally { await browser.close(); }
  }
} finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
const receipt = { schemaVersion: 1, result: 'pass', sourceTree: packed.source.tree, sourceSha256: pins,
  qaTool: { path: 'tools/qa-pipeline-timing-packed.mjs', sha256: hash(readFileSync('tools/qa-pipeline-timing-packed.mjs')) },
  environment: { node: process.version }, consumer, callerSha256: hash(caller), proof,
  scope: 'Offline compiled public SDK and native local MessagePorts; actual Node output and browser DOM commit/frame boundary. No physical phone, network, throughput or photon evidence.' };
const receiptPath = join(consumer, 'pipeline-timing-receipt.json');
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ result: 'pass', receiptPath, ...receipt }));
