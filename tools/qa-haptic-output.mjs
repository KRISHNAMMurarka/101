#!/usr/bin/env node
/** Local public caller; API acceptance is recorded separately from unverified physical vibration. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { chromium, webkit } from 'playwright';

const args = process.argv.slice(2), workspace = args.includes('--workspace-exports');
const index = args.indexOf('--sdk-root'), sdkRoot = index < 0 ? undefined : args[index + 1];
assert.ok(workspace !== Boolean(sdkRoot), 'Select --workspace-exports or --sdk-root <installed consumer>');
assert.ok(workspace ? args.length === 1 && args[0] === '--workspace-exports'
  : args.length === 2 && args[0] === '--sdk-root', 'Unexpected haptic QA arguments');
const root = resolve(import.meta.dirname, '..');
const names = ['@101/connect', '@101/device-model', '@101/device-runtime', '@101/device-web', '@101/vision', '@101/transport-webrtc', '@101/transport-websocket'];
const owned = ['packages/device-model/src/haptic-profile.ts', 'packages/device-model/src/haptic-profile.test.ts',
  'packages/device-runtime/src/haptic-output.ts', 'packages/device-runtime/src/haptic-output.test.ts',
  'apps/controller-native/src/controller-haptics.ts', 'apps/controller-native/src/controller-haptics.test.ts',
  'apps/controller-native/App.tsx', 'tools/qa-haptic-output.mjs'];
let resolver, server, browser;
try {
  let entries;
  if (sdkRoot) {
    const consumer = realpathSync(resolve(sdkRoot));
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    const receipt = JSON.parse(readFileSync(join(consumer, 'receipt.json'), 'utf8'));
    assert.equal(receipt.status, 'pass');
    const manifestBytes = readFileSync(receipt.manifest.path);
    assert.equal(hash(manifestBytes), receipt.manifest.sha256);
    const manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.source.tree, receipt.source.tree);
    assert.equal(lstatSync(join(consumer, 'node_modules')).isSymbolicLink(), false);
    for (const name of names) {
      const pkg = manifest.packages.find(value => value.name === name);
      assert.ok(pkg && Array.isArray(pkg.files) && pkg.files.length <= 1024);
      const directory = join(consumer, 'node_modules', name);
      assert.ok(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink());
      for (const file of pkg.files) {
        const path = resolve(directory, file.path);
        assert.ok(path.startsWith(directory + '/'));
        assert.ok(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink());
        assert.equal(hash(readFileSync(path)), file.sha256);
      }
    }
    for (const path of ['packages/device-model/src/haptic-profile.ts', 'packages/device-runtime/src/haptic-output.ts',
      'packages/device-runtime/src/runtime.ts']) assert.equal(hash(readFileSync(join(root, path))), manifest.source.sha256[path]);
    resolver = mkdtempSync(join(consumer, '.101-haptic-resolve-'));
    const file = join(resolver, 'resolve.mjs');
    writeFileSync(file, 'export default {' + names.map(name => JSON.stringify(name) + ': import.meta.resolve(' + JSON.stringify(name) + ')').join(',') + '};');
    entries = (await import(pathToFileURL(file).href)).default;
  } else entries = Object.fromEntries(names.map(name => [name, pathToFileURL(resolve(root, 'packages', name.slice(5), 'src/index.ts')).href]));
  const bases = Object.fromEntries(Object.entries(entries).map(([name, url]) => [name.slice(5), realpathSync(dirname(fileURLToPath(url)))]));
  const importMap = { imports: Object.fromEntries(Object.entries(entries).map(([name, url]) => [name, '/sdk/' + name.slice(5) + '/' + basename(fileURLToPath(url))])) };
  const client = `import * as api from '@101/connect';
window.hapticProof=async()=>{
 const assert=(ok,message)=>{if(!ok)throw Error(message);};
 const checks=[], apiReturns=[], requested=[];
 const supported=typeof navigator.vibrate==='function';
 const actual=navigator.vibrate;
 const port=supported?{vibrate(pattern){requested.push(pattern);const value=actual.call(navigator,pattern);apiReturns.push(value);return value;}}:undefined;
 let now=1000, selected=false;
 function fixture(session='local'){
  const runtime=api.createDeviceRuntime({now:()=>now,authorize:request=>selected&&request.principalId==='owner'&&request.applicationId==='haptic-caller'&&request.sessionId==='local'&&request.source.deviceId==='haptic-caller-source'&&request.sink.deviceId==='haptic-caller-output'&&request.sinkOperation==='invoke'?{expiresAt:now+1000,maxAgeMs:100,maxHz:10}:undefined});
  const output=api.createHapticOutputController({runtime,deviceId:'haptic-caller-output',now:()=>now,backend:api.createBrowserHapticBackend(port)});
  const profile=api.getHapticOutputProfile('app:browser-haptic-presets/1');
  const source=runtime.registerSource({device:{schemaVersion:1,id:'haptic-caller-source',label:'Haptic caller',revision:1,adapter:{id:'local:haptic-caller',version:'1'},runtime:{platform:'browser'},capabilities:[{...profile.capability,kind:'event',permissions:['subscribe']}]},capability:'preset'});
  runtime.setReadiness(source,'available');output.setAvailable(true);
  const route=runtime.route({from:source,to:output.endpoint,principalId:'owner',applicationId:'haptic-caller',sessionId:session,leaseMs:500,queueCapacity:1});
  return {runtime,output,route,publish(id,value='tap'){return runtime.publish(source,value,{operationId:id,deadline:now+100});},close(){output.close();runtime.close();}};
 }
 const first=fixture();
 try {
  assert(!first.route.start().ok,'no automatic host grant');assert(requested.length===0,'denied route must remain inert');checks.push('no-current-approval-no-api');
  selected=true;
  const started=first.route.start().ok;
  assert(started===supported,'availability must match actual browser API presence');
  if(started){
   assert(first.publish('1',{preset:'tap',intensity:0.5}).ok===false,'custom intensity rejected');assert(first.publish('1').ok,'current preset admission');first.runtime.flush();
   await new Promise(resolve=>setTimeout(resolve,0));
   const record=first.output.records()[0], operation=first.route.operations()[0];
   assert(record&&record.physical==='unverified'&&record.effect===(apiReturns[0]===true?'dispatched':'none'),'API refusal is not accepted dispatch');
   assert(operation.effectEvidence===(apiReturns[0]===true?'dispatched':'none')&&operation.state!=='observed'&&operation.state!=='target-acknowledged','no fabricated acknowledgement');
   assert(record.outcome===(apiReturns[0]===true?'api-returned':'unavailable'),'actual navigator boolean is respected');
   const count=requested.length;assert(!first.publish('1').ok,'duplicate operation denied');first.runtime.flush();assert(requested.length===count,'no duplicate API request');
   checks.push('actual-browser-api-result-unverified','replay-no-repeat');
  }else {assert(requested.length===0,'missing API inert');checks.push('actual-missing-api-fallback');}
 }finally{first.close();}
 const before=requested.length;
 for(const kind of ['revoke','expire','wrong-session']){
  now+=200;const f=fixture(kind==='wrong-session'?'foreign':'local');
  try{
   const started=f.route.start().ok;
   if(kind==='wrong-session')assert(!started,'foreign session denied');
   else if(started){assert(f.publish('1').ok,'queued current command');if(kind==='revoke')f.runtime.revoke(f.route);else now+=100;f.runtime.flush();assert(f.route.operations()[0].effectEvidence==='none','retired queue stays inert');}
   assert(requested.length===before,'retired or foreign command cannot issue API');checks.push(kind+'-no-api');
  }finally{f.close();}
 }
 const profile=api.getHapticOutputProfile('app:expo-haptic-presets/1');
 assert(profile.duration.control==='platform-preset'&&profile.duration.maxRequestedMs===undefined&&profile.intensity.custom===false&&profile.physicalCancellation==='unsupported','Expo limits must be truthful');checks.push('expo-preset-only-no-physical-claim');
 return {supported,checks,apiReturns,requested,physicalVibration:'unverified',nativeBridge:'unqualified'};
};`;
  server = createServer((request, response) => {
    if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>Local haptic API qualification</title><script type="importmap">' + JSON.stringify(importMap) + '</script><script type="module" src="/client.js"></script>');
    } else if (request.url === '/client.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(client); }
    else {
      try {
        const match = /^\/sdk\/([^/]+)\/(.+\.(?:ts|js))$/.exec(decodeURIComponent(request.url ?? ''));
        if (!match || !Object.hasOwn(bases, match[1])) throw Error('unowned module');
        const base = bases[match[1]], file = realpathSync(resolve(base, match[2])), path = relative(base, file);
        if (isAbsolute(path) || path === '..' || path.startsWith('../') || path.includes('.test.')) throw Error('unowned module');
        const source = readFileSync(file, 'utf8');
        response.setHeader('Content-Type', 'text/javascript');
        response.end(file.endsWith('.ts') ? ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText : source);
      } catch { response.statusCode = 404; response.end(); }
    }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browsers = [];
  for (const engine of [chromium, webkit]) {
    browser = await engine.launch({ headless: true });
    const context = await browser.newContext(), errors = [], foreign = [];
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin !== origin) { foreign.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin); await page.waitForFunction(() => typeof window.hapticProof === 'function');
    const result = await page.evaluate(() => window.hapticProof());
    assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
    browsers.push({ engine: engine.name(), version: browser.version(), result, pageErrors: errors.length, foreignRequests: foreign.length });
    await browser.close(); browser = undefined;
  }
  console.log(JSON.stringify({ result: 'pass', profile: 'preset-haptics/1', node: process.version,
    publicResolution: workspace ? 'source-worktree-public-barrels-not-installed' : 'ordinary-installed-sdk-esm', browsers,
    sourceSha256: Object.fromEntries(owned.map(path => [path, createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')])),
    exclusions: ['native-bridge-dispatch', 'physical-vibration-distinction', 'physical-duration-intensity', 'issued-Expo-cancellation', 'legacy-SDK-grant-migration'] }, null, 2));
} finally {
  if (browser) await browser.close();
  if (server) await new Promise(done => server.close(done));
  if (resolver) rmSync(resolver, { recursive: true, force: true });
}
