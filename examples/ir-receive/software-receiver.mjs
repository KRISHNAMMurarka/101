import { randomBytes } from 'node:crypto';
import readline from 'node:readline';
const profileId='app:nec-inverse-byte-demodulated-nominal/1', mode=process.argv[2]??'valid'; let session,active;
const send=value=>process.stdout.write(`${JSON.stringify(value)}\n`),exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const P=n=>0x01000000|n,S=n=>n,T=(n=20000)=>0x03000000|n;
function canonical(){const bytes=[0x34,0xcb,0xa2,0x5d],out=[P(9000),S(4500)];for(const value of bytes)for(let bit=0;bit<8;bit++)out.push(P(560),S((value>>>bit)&1?1690:565));out.push(P(560),T());return out}
function fixture(){const p=canonical();if(mode==='repeat')return[P(9000),S(2250),P(560),T()];if(mode==='overflow')return[0x04ffffff,T()];if(mode==='frequency')return[0x02009470,T()];if(mode==='partial')return p.slice(0,-1);return p}
const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
rl.on('line',line=>{try{if(line.length>1024)throw Error();const m=JSON.parse(line);
 if(exact(m,['type','generation','token','deadline'])&&m.type==='open'&&!session&&Number.isSafeInteger(m.generation)&&typeof m.token==='string'&&/^[a-f0-9]{32}$/.test(m.token)&&Number.isFinite(m.deadline)&&m.deadline>performance.now()){session={generation:m.generation,token:m.token};send({type:'ready',generation:m.generation,token:m.token});return}
 if(m?.type==='capture'&&(!exact(m,['type','generation','token','operationId','deadline'])||!session||m.generation!==session.generation||m.token!==session.token||active||typeof m.operationId!=='string'||!Number.isFinite(m.deadline)||m.deadline<=performance.now())){send({type:'rejected',operationId:typeof m?.operationId==='string'?m.operationId:''});return}
 if(m?.type==='capture'){const operationId=m.operationId,timer=setTimeout(()=>{active=undefined;send({type:'capture',operationId,packets:fixture()})},5);active={operationId,timer};return}
 if(m?.type==='stop'&&(!exact(m,['type','generation','token'])||!session||m.generation!==session.generation||m.token!==session.token)){send({type:'rejected-stop'});return}
 if(m?.type==='stop'){if(active){clearTimeout(active.timer);send({type:'cancelled',operationId:active.operationId});active=undefined}const stopped=session;session=undefined;send({type:'stopped',...stopped});return}
 if(exact(m,['type'])&&m.type==='close'){if(active)clearTimeout(active.timer);send({type:'closed'});process.exit(0)}throw Error();
 }catch{send({type:'error',nonce:randomBytes(4).toString('hex')})}});
send({type:'hello',revision:1,profileId,mode:'LIRC_MODE_MODE2',resolutionMicros:1,carrierMeasurement:false});
