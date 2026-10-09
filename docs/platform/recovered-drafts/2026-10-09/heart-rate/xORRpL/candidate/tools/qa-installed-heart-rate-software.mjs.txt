import assert from 'node:assert/strict';
import {realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {fileHash,installedHeartRateInputs,runHeartRateSoftwareQa} from './qa-heart-rate-software.mjs';
/** Integration owner only; reuse current consumer, no SDK build/install or SDK mutation. */
export async function runInstalledHeartRateSoftwareQa(consumer,{root=resolve(import.meta.dirname,'..'),repoRoot=root,selectedSource,python}={}){
 const inputs=installedHeartRateInputs(consumer);assert.ok(!inputs.consumer.startsWith(realpathSync(repoRoot)+'/'));
 const result=await runHeartRateSoftwareQa({root,repoRoot,workRoot:inputs.consumer,selectedSource,python,installedInputs:inputs});
 assert.deepEqual(installedHeartRateInputs(consumer).before,inputs.before);return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href){const [consumer,selectedSource,python]=process.argv.slice(2);assert.ok(consumer&&selectedSource&&python,'Existing consumer, exact selected source and interpreter required');const result=await runInstalledHeartRateSoftwareQa(consumer,{selectedSource,python});console.log(JSON.stringify({status:result.status,receiptPath:result.receiptPath,sha256:fileHash(result.receiptPath),mutationReceipt:result.mutations.receiptPath}));}
