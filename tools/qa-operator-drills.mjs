#!/usr/bin/env node
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,mkdtempSync,readdirSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
assert.deepEqual(process.argv.slice(2),['--source']);
const root=resolve(import.meta.dirname,'..'),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const paths=['examples/operator-drills/operator-drills.ts','tests/operator-drills.test.ts','tools/operator-drills.mjs','tools/qa-operator-drills.mjs',
  'packages/hub-server/src/operator-identity-lifecycle.ts','packages/hub-server/src/operator-configuration.ts','packages/hub-server/src/https-coordinator.ts',
  'packages/device-runtime/src/processor-installation.ts','packages/device-runtime/src/owner-backup.ts','packages/device-runtime/src/owner-data.ts',
  'examples/extension-installation/filesystem-storage.mjs','examples/extension-installation/consumer.mjs','examples/owner-data/filesystem-storage.mjs','tools/qa-https-coordinator.mjs'];
const sourceSha256=Object.fromEntries(paths.map(path=>[path,sha(readFileSync(join(root,path)))]));
const directory=realpathSync(mkdtempSync(join(tmpdir(),'101-operator-drills-qa-'))),sentinel=join(directory,'unrelated-sentinel');writeFileSync(sentinel,'owned sentinel\n',{mode:0o600});
async function child(args,killAtStage) {
  return new Promise((resolveResult,reject)=>{
    const issued=spawn(process.execPath,[join(root,'tools/operator-drills.mjs'),...args],{cwd:root,env:{...process.env,TMPDIR:directory,NODE_ENV:'production'},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',bytes=0,cancelled=false,failure,drained=0;const records=[];
    const timer=setTimeout(()=>{failure=Error('Owned operator drill child deadline.');issued.kill('SIGTERM');},35000);
    const output=chunk=>{if((bytes+=chunk.byteLength)>65536){failure=Error('Owned operator drill output quota.');issued.kill('SIGTERM');return;}
      stdout+=chunk.toString();for(const line of stdout.split('\n').slice(records.length,-1)){
        try{const row=JSON.parse(line);records.push(row);if(killAtStage&&row.event==='stage'&&row.stage===killAtStage&&!cancelled){cancelled=true;issued.kill('SIGTERM');}}catch{failure=Error('Owned operator drill output invalid.');issued.kill('SIGTERM');}
      }};
    issued.stdout.on('data',output);issued.stderr.on('data',chunk=>{if((bytes+=chunk.byteLength)>65536){failure=Error('Owned operator drill output quota.');issued.kill('SIGTERM');return;}stderr+=chunk.toString();});
    issued.once('error',error=>{failure=error;});issued.stdout.once('end',()=>drained++);issued.stderr.once('end',()=>drained++);
    issued.once('close',(code,signal)=>{clearTimeout(timer);if(failure)return reject(failure);if(drained!==2)return reject(Error('Owned operator drill child streams not drained.'));
      resolveResult({code,signal,records,stderr,cancelled});});
  });
}
function clean() {assert.equal(readFileSync(sentinel,'utf8'),'owned sentinel\n');assert.deepEqual(readdirSync(directory),['unrelated-sentinel']);assert.equal(lstatSync(directory).isDirectory(),true);}
try {
  const invalid=await child(['--endpoint','https://untrusted.invalid']);assert.equal(invalid.code,2);assert.deepEqual(invalid.records,[]);clean();
  const help=await child(['--help']);assert.equal(help.code,0);assert.equal(help.records[0].profile,'local-operator-recovery-drills/1');clean();
  const success=await child(['--exercise']);assert.equal(success.code,0,success.stderr);const receipt=success.records.find(row=>row.result==='pass');assert.ok(receipt);assert.equal(receipt.cleanup.nativeContexts,0);clean();
  assert.equal(receipt.publicResolution,'explicit-owned-source-barrels');
  const dependencies=receipt.sourceDependencySha256;assert.ok(dependencies&&Object.getPrototypeOf(dependencies)===Object.prototype);
  const dependencyPaths=Object.keys(dependencies);assert.ok(dependencyPaths.length>14&&dependencyPaths.length<=256);
  assert.ok(dependencyPaths.includes('packages/connect/src/index.ts'));assert.ok(dependencyPaths.includes('packages/hub-server/src/index.ts'));
  for(const path of dependencyPaths){
    assert.ok(path.length<=200&&/^(packages|examples|tools)\/.+\.(ts|mjs)$/.test(path)&&!path.split('/').includes('..'));
    const file=join(root,path),stat=lstatSync(file);assert.equal(realpathSync(file),file);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=2097152);
    assert.match(dependencies[path],/^[0-9a-f]{64}$/);assert.equal(sha(readFileSync(file)),dependencies[path]);
  }
  const stopped=await child(['--exercise'],'native-started');assert.equal(stopped.cancelled,true);assert.ok(stopped.records.some(row=>row.event==='stage'&&row.stage==='removed'));assert.equal(stopped.records.some(row=>row.result==='pass'),false);clean();
  for(const [path,pin]of Object.entries(sourceSha256))assert.equal(sha(readFileSync(join(root,path))),pin);
  rmSync(directory,{recursive:true});assert.equal(existsSync(directory),false);
  console.log(JSON.stringify({result:'pass',profile:'local-operator-recovery-drills/1',publicResolution:'explicit-owned-source-barrels',node:process.version,sourceSha256,
    checks:['invalid closed CLI performs no work','help performs no native work','actual complete upgrade rollback and incident drill','SIGTERM retires actual native owner before removed event'],proof:receipt,
    cleanup:{ownedChildren:0,privateFixtureRemoved:true,unrelatedSentinelPreserved:true},physical:false,installedHubClaim:false},null,2));
}finally{if(existsSync(directory))rmSync(directory,{recursive:true});}
