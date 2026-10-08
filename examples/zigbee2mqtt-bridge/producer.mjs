import { connectAsync } from 'mqtt';
import { createHash } from 'node:crypto';
// Software stand-in for native Zigbee2MQTT bytes; never commissions or identifies hardware.
const endpoint=process.argv[2];if(!/^mqtt:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(endpoint??'')||!process.send)throw new Error('Owned loopback fixture required');
const ieee='0x0000000000000007',state='zigbee2mqtt/'+ieee;
const client=await connectAsync(endpoint,{protocolVersion:5,clean:true,reconnectPeriod:0,resubscribe:false,queueQoSZero:false,connectTimeout:3000,properties:{sessionExpiryInterval:0}});
let chain=Promise.resolve(),closing;
const close=()=>closing??=(async()=>{const stream=client.stream;const closed=new Promise(res=>{if(stream.closed)res();else stream.once('close',res);});const results=await Promise.allSettled([client.endAsync(true),closed]);const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)throw new AggregateError(errors,'Producer transport close failed');process.disconnect?.();})();
client.on('error',e=>{process.send?.({kind:'error',reason:e.message});void close().catch(e=>{console.error(e);process.exitCode=1;});});
function fixture(kind){
  const metadata=[{ieee_address:ieee,friendly_name:ieee,supported:true,disabled:false,interview_state:'SUCCESSFUL',definition:{model:'WXKG01LM',exposes:[{type:'numeric',name:'battery',property:'battery',access:1,unit:'%'},{type:'enum',name:'action',property:'action',access:1,values:['single','double','triple','quadruple','hold','release','many']}]}}];
  if(kind==='metadata-change')metadata[0].definition.exposes[0].unit='V';
  if(kind==='metadata'||kind==='metadata-change')return{topic:'zigbee2mqtt/bridge/devices',value:metadata,qos:0,retain:true};
  if(kind==='bridge-online')return{topic:'zigbee2mqtt/bridge/state',value:{state:'online'},qos:0,retain:true};
  if(kind==='device-online'||kind==='offline')return{topic:state+'/availability',value:{state:kind==='offline'?'offline':'online'},qos:1,retain:true};
  if(kind==='battery')return{topic:state,value:{battery:75,last_seen:'2026-10-08T00:00:00.000Z',linkquality:99},qos:0,retain:false};
  if(kind==='retained-state')return{topic:state,value:{battery:75,action:'single'},qos:0,retain:true};
  if(kind==='mixed')return{topic:state,value:{battery:75,action:'double'},qos:0,retain:false};
  if(['single','hold','release'].includes(kind))return{topic:state,value:{action:kind},qos:0,retain:false};
  throw new Error('Unknown bounded fixture');
}
process.on('disconnect',()=>{void close().catch(e=>{console.error(e);process.exitCode=1;});});
process.on('message',message=>{chain=chain.then(async()=>{
  if(!message||!Number.isSafeInteger(message.id)||closing)throw new Error('Invalid fixture request');
  if(message.kind==='close'){await close();return;}
  const f=fixture(message.kind),bytes=Buffer.from(JSON.stringify(f.value));await client.publishAsync(f.topic,bytes,{qos:f.qos,retain:f.retain});
  process.send?.({kind:'published',id:message.id,topic:f.topic,qos:f.qos,retain:f.retain,bytesHex:bytes.toString('hex'),payloadSha256:createHash('sha256').update(bytes).digest('hex')});
}).catch(async e=>{process.send?.({kind:'error',id:message?.id,reason:e.message});console.error(e);process.exitCode=1;await close();});});
process.send({kind:'ready',pid:process.pid,transport:'MQTT5 native Zigbee2MQTT JSON software fixture'});
