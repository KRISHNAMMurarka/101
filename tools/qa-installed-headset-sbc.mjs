import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,dirname} from 'node:path';
import {CORE_FILES,guardApproval,qualifyHeadsetSbc,publicExportEntry} from './qa-headset-sbc.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

/** Exact copied glue, ordinary installed package imports; no build/install/alias. */
export async function qualifyInstalledHeadsetSbc({sourceRoot,sdkWorkspace,approvalPath,enrollmentPath,workRoot,group}){
 const approved=await guardApproval({sourceRoot,sdkWorkspace,approvalPath});assert.equal(approved.sdk.kind,'ordinary-installed-seven-package-SDK');
 const workspace=await fs.realpath(sdkWorkspace);assert.ok(workRoot.startsWith(workspace+'/headset-sbc-'),'Own a new child of the existing ordinary consumer');
 await fs.mkdir(workRoot,{mode:0o700,recursive:false});assert.equal(await fs.realpath(workRoot),workRoot);
 const copied=join(workRoot,'caller');await fs.mkdir(copied,{mode:0o700});const files=[];
 for(const relative of CORE_FILES){const bytes=await fs.readFile(join(sourceRoot,relative)),target=join(copied,relative);await fs.mkdir(dirname(target),{recursive:true});await fs.writeFile(target,bytes,{flag:'wx'});assert.equal(sha(await fs.readFile(target)),sha(bytes));files.push({relative,path:target,bytes:bytes.length,sha256:sha(bytes)});}
 const publicEntry=await publicExportEntry(workspace);assert.ok(publicEntry.startsWith(workspace+'/node_modules/@101/connect/'));assert.equal(publicEntry,approved.publicEntry);
 const result=await qualifyHeadsetSbc({sourceRoot:copied,sdkWorkspace:workspace,approvalPath,enrollmentPath,receiptDirectory:join(workRoot,'receipts'),group});
 await guardApproval({sourceRoot,sdkWorkspace:workspace,approvalPath});await guardApproval({sourceRoot:copied,sdkWorkspace:workspace,approvalPath});
 const output={status:result.status,callerFiles:files,publicEntry,sdkKind:approved.sdk.kind,manifest:approved.approval.installedManifest,qualification:result,sourceAlias:false,newInstall:false,newBuild:false,physical:false,fullW06:false};
 await fs.writeFile(join(workRoot,'result.json'),JSON.stringify(output,null,2)+'\n',{flag:'wx'});return output;
}
if(process.argv[1]===import.meta.filename){const [sourceRoot,sdkWorkspace,approvalPath,enrollmentPath,workRoot,group]=process.argv.slice(2);assert.equal(process.argv.length,8);console.log(JSON.stringify(await qualifyInstalledHeadsetSbc({sourceRoot,sdkWorkspace,approvalPath,enrollmentPath,workRoot,group})));}
