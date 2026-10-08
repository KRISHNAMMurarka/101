import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {existsSync,mkdtempSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createTmp102ClosureFence,fileHash,fingerprints,ordinaryFiles,prepareTmp102Artifacts,runTmp102OwnedCaller,sourceClosure} from './qa-tmp102-hwmon.mjs';
export function installedTmp102Inputs(consumerInput,{repoRoot=resolve(import.meta.dirname,'..')}={}){
 const consumer=realpathSync(consumerInput),sdkReceiptPath=join(consumer,'receipt.json'),dependencyReceiptPath=join(consumer,'selected-node-connectors/receipt.json');
 assert.ok(!consumer.startsWith(realpathSync(repoRoot)+sep));const receipt=JSON.parse(readFileSync(sdkReceiptPath,'utf8')),providers=JSON.parse(readFileSync(dependencyReceiptPath,'utf8'));
 assert.equal(receipt.status,'pass');assert.equal(providers.status,'pass');const manifest=JSON.parse(readFileSync(receipt.manifest.path,'utf8'));assert.equal(fileHash(receipt.manifest.path),receipt.manifest.sha256);
 assert.equal(manifest.packages.length,7);const sdkPaths=[],allowed=new Set();
 for(const pkg of manifest.packages){const directory=join(consumer,'node_modules',pkg.name);assert.equal(realpathSync(directory),directory);allowed.add(directory);
 const paths=ordinaryFiles(directory);assert.equal(paths.length,pkg.files.length);for(const file of pkg.files){assert.ok(typeof file.path==='string'&&!file.path.startsWith('/')&&!file.path.split('/').some(p=>!p||p==='.'||p==='..'));
 assert.equal(fileHash(join(directory,file.path)),file.sha256);}sdkPaths.push(...paths);}
 const dependencyPaths=[];for(const dep of providers.dependencies){assert.ok(typeof dep.path==='string'&&!dep.path.startsWith('/')&&!dep.path.split('/').some(p=>!p||p==='.'||p==='..'));
 const directory=join(consumer,'node_modules',dep.path);assert.equal(realpathSync(directory),directory);assert.equal(fileHash(join(directory,'package.json')),dep.packageSha256);allowed.add(directory);dependencyPaths.push(...ordinaryFiles(directory));}
 const visited=new Set();function visit(directory){assert.ok(allowed.has(directory),`Unrecorded actual dependency ${directory}`);if(visited.has(directory))return;visited.add(directory);
 const metadata=JSON.parse(readFileSync(join(directory,'package.json'),'utf8'));for(const dependency of Object.keys(metadata.dependencies??{})){
 let at=directory,target;for(;;){const candidate=join(at,'node_modules',dependency,'package.json');if(existsSync(candidate)){target=dirname(realpathSync(candidate));break;}const next=dirname(at);assert.notEqual(at,next);at=next;}visit(target);}}
 visit(join(consumer,'node_modules/@101/connect'));const tsRoot=dirname(realpathSync(createRequire(join(repoRoot,'package.json')).resolve('typescript/package.json')));
 return{consumer,sdkReceiptPath,dependencyReceiptPath,manifestPath:receipt.manifest.path,sdkManifest:receipt.manifest,sdkPaths,dependencyPaths,compilerPaths:ordinaryFiles(tsRoot),before:fingerprints([sdkReceiptPath,dependencyReceiptPath,receipt.manifest.path,...sdkPaths,...dependencyPaths])};
}
/** Root integration owner alone invokes the normal installed qualifier. No SDK build or install. */
export async function runInstalledTmp102HwmonQa(consumerInput,{root=resolve(import.meta.dirname,'..'),repoRoot=root}={}){
 const inputs=installedTmp102Inputs(consumerInput,{repoRoot}),before=sourceClosure(root,repoRoot),work=realpathSync(mkdtempSync(join(inputs.consumer,'tmp102-hwmon-'))),artifacts=prepareTmp102Artifacts({root,repoRoot,work});
 const fence=createTmp102ClosureFence({artifacts,sdkReceiptPath:inputs.sdkReceiptPath,dependencyReceiptPath:inputs.dependencyReceiptPath,sourcePaths:[...Object.keys(before),...inputs.compilerPaths,inputs.manifestPath],sdkPaths:inputs.sdkPaths,dependencyPaths:inputs.dependencyPaths});
 const execution=await runTmp102OwnedCaller(artifacts.runner);assert.ok(fileURLToPath(execution.entry).startsWith(join(inputs.consumer,'node_modules/@101/connect')+sep),'Actual installed public SDK resolution required');
 fence.verify();assert.deepEqual(sourceClosure(root,repoRoot),before);assert.deepEqual(installedTmp102Inputs(consumerInput,{repoRoot}).before,inputs.before);
 const result={schemaVersion:1,status:'pass',kind:'actual-installed-public-SDK-software-ABI',physical:false,supportRows:[],sdkManifest:inputs.sdkManifest,sdkFiles:inputs.sdkPaths.length,
 sourceSha256:before,closure:fence.before,artifacts,execution,nativeEnvironment:{status:'blocked',reason:'native-admission-not-qualified',nativeApproved:false},scope:'Ordinary file ABI reported Celsius/public SDK only; no native sysfs/I2C/calibration/physical/full A16 acceptance.'};
 const receiptPath=join(work,'receipt.json');writeFileSync(receiptPath,JSON.stringify(result,null,2)+'\n');return{...result,receiptPath};
}
if(process.argv[1]&&existsSync(process.argv[1])&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href){try{assert.ok(process.argv[2],'Existing offline SDK consumer required');console.log(JSON.stringify(await runInstalledTmp102HwmonQa(process.argv[2])));}catch(error){console.error(error);process.exitCode=1;}}
