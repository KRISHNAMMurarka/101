import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join} from 'node:path';

// Owned ordinary files; IPC schedules fixture changes, never supplies a sensor reading.
const issued=new Set(),writes=new Set();let queue=Promise.resolve(),messages=0,closed=false,root,terminating;
function own(p){issued.add(p);void p.then(()=>issued.delete(p),()=>issued.delete(p));return p;}
function send(message){const p=new Promise((done,reject)=>{try{process.send(message,e=>e?reject(e):done());}catch(e){reject(e);}});
 writes.add(p);void p.then(()=>writes.delete(p),()=>writes.delete(p));p.catch(()=>{process.exitCode=1;});return p;}
async function drain(){while(issued.size||writes.size)await Promise.allSettled([...issued,...writes]);}
function terminate(){if(terminating)return terminating;closed=true;process.exitCode=1;
 terminating=(async()=>{await Promise.allSettled([queue]);await drain();if(root)await own(fs.rm(root,{recursive:true,force:true})).catch(()=>{});
  await drain();if(process.connected)process.disconnect();})().catch(()=>{process.exitCode=1;if(process.connected)process.disconnect();});return terminating;}
process.on('uncaughtException',()=>{void terminate();});
process.on('disconnect',()=>{if(!closed)void terminate();});
process.on('message',m=>{if(closed)return;queue=queue.then(()=>action(m));queue.catch(()=>{void terminate();});});

const ident=async path=>{const s=await own(fs.lstat(path,{bigint:true}));return{dev:String(s.dev),ino:String(s.ino)};};
let work,parent,hwmon;
try{
 assert.equal(process.env.NODE_ENV,'production');assert.deepEqual(process.execArgv,[]);
 work=await own(fs.realpath(process.argv[2]));assert.ok((await own(fs.lstat(work))).isDirectory());
 root=await own(fs.mkdtemp(join(work,'producer-')));parent=join(root,'parent');hwmon=join(parent,'hwmon');
 await own(fs.mkdir(hwmon,{recursive:true}));await own(fs.writeFile(join(hwmon,'name'),'tmp102\n'));await own(fs.writeFile(join(hwmon,'temp1_input'),'-62\n'));
 await send({kind:'enrolled',pid:process.pid,root,parentRealPath:parent,hwmonRealPath:hwmon,enrolledIdentities:{parent:await ident(parent),hwmon:await ident(hwmon),name:await ident(join(hwmon,'name')),temperature:await ident(join(hwmon,'temp1_input'))}});
}catch{await terminate();}
async function action(m){assert.ok(m&&Object.getPrototypeOf(m)===Object.prototype);assert.ok(++messages<=32);assert.ok(Number.isSafeInteger(m.id)&&m.id>0);
 const name=join(hwmon,'temp1_input');
 if(m.kind==='contents'){assert.equal(Object.keys(m).length,3);assert.ok(typeof m.bytes==='string'&&Buffer.byteLength(m.bytes)<=128);await own(fs.writeFile(name,m.bytes));}
 else if(m.kind==='replace'){assert.equal(Object.keys(m).length,2);await own(fs.rename(name,join(hwmon,'retained-old')));await own(fs.writeFile(name,'0\n'));}
 else if(m.kind==='missing'){assert.equal(Object.keys(m).length,2);await own(fs.unlink(name));}
 else if(m.kind==='finish'){assert.equal(Object.keys(m).length,2);closed=true;await send({kind:'ack',id:m.id});await drain();await own(fs.rm(root,{recursive:true,force:true}));await drain();if(process.connected)process.disconnect();return;}
 else throw Error('Unsupported fixture action');await send({kind:'ack',id:m.id});
}
