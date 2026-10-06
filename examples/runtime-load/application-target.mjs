import { parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
const port=parentPort, scope=workerData?.scopeIndex;
if(!port||Object.keys(workerData).length!==2||workerData.schemaVersion!==1||!Number.isInteger(scope)||scope<0||scope>3)throw Error('Invalid owned target context');
const state=new Map(),pending=new Map();let held=false,closed=false,messages=0;
function integer(value,min,max){return Number.isSafeInteger(value)&&value>=min&&value<=max;}
function fields(value,keys){return value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));}
function reply(value){port.postMessage({...value,clockId:'owned-node-worker-'+scope,emittedAt:performance.now()});}
function apply(value){
 const prior=state.get(value.edge);
 if(prior&&value.sequence<=prior.sequence){reply({kind:'rejected',id:value.id});return;}
 if(!prior&&state.size>=32){reply({kind:'rejected',id:value.id});return;}
 // The authoritative target performs the fixed integer-state effect before ACK.
 state.set(value.edge,{sequence:value.sequence,state:value.state});
 reply({kind:'applied',id:value.id,edge:value.edge,sequence:value.sequence,state:value.state});
}
port.on('message',value=>{
 if(closed)return;
 if(++messages>1024||JSON.stringify(value).length>256){closed=true;port.close();return;}
 if(fields(value,['kind','id','edge','sequence','state'])&&value.kind==='apply'&&integer(value.id,1,4096)&&integer(value.edge,0,127)&&value.edge%4===scope&&integer(value.sequence,1,256)&&integer(value.state,0,256)){
  if(held){if(pending.size>=2){reply({kind:'rejected',id:value.id});return;}pending.set(value.id,value);reply({kind:'held',id:value.id});}
  else apply(value);return;
 }
 if(fields(value,['kind','id'])&&value.kind==='cancel'&&integer(value.id,1,4096)){
  if(pending.delete(value.id))reply({kind:'cancelled',id:value.id});return;
 }
 if(fields(value,['kind','hold'])&&value.kind==='hold'&&typeof value.hold==='boolean'){
  held=value.hold;reply({kind:'holding',hold:held,pending:pending.size});
  if(!held){for(const [id,entry]of pending){pending.delete(id);apply(entry);}}return;
 }
 if(fields(value,['kind'])&&value.kind==='close'){
  closed=true;for(const id of pending.keys())reply({kind:'cancelled',id});pending.clear();
  reply({kind:'closed',entries:state.size});state.clear();port.close();return;
 }
 reply({kind:'invalid'});
});
reply({kind:'ready',profile:'subscribed-runtime-load-target/1',scopeIndex:scope});
