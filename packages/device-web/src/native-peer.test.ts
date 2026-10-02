import assert from 'node:assert/strict';
import test from 'node:test';
import { PeerDataTransport } from '@101/transport-webrtc';
import { createNativePeerPort, type NativePeerProducer, type NativeChannelProducer, type NativeDescription } from './native-peer.ts';

class Channel implements NativeChannelProducer {
  id: number | null = null; label: string; ordered = true; maxPacketLifeTime: number | undefined = -1; maxRetransmits: number | undefined = -1;
  readyState = 'open'; bufferedAmount = 0; binaryType = 'arraybuffer'; bufferedAmountLowThreshold = 0;
  onmessage: NativeChannelProducer['onmessage'] = null; onclose: NativeChannelProducer['onclose'] = null; onerror: NativeChannelProducer['onerror'] = null;
  sent: (string | ArrayBuffer | ArrayBufferView)[] = []; closes = 0;
  constructor(label: string) { this.label = label; }
  send(data: string | ArrayBuffer | ArrayBufferView) { this.sent.push(data); }
  close() { this.closes++; this.readyState = 'closed'; }
}
class Producer implements NativePeerProducer {
  connectionState = 'new'; iceGatheringState = 'complete'; localDescription: NativeDescription | null = null;
  onconnectionstatechange: NativePeerProducer['onconnectionstatechange'] = null;
  ondatachannel: NativePeerProducer['ondatachannel'] = null;
  onicegatheringstatechange: NativePeerProducer['onicegatheringstatechange'] = null;
  channels: Channel[] = []; closes = 0; descriptions: NativeDescription[] = [];
  offer: () => Promise<NativeDescription> = async () => ({type:'offer', sdp:'native-offer'});
  createDataChannel(label: string, options: RTCDataChannelInit) { const c = new Channel(label); c.ordered = options.ordered ?? true; c.maxRetransmits = options.maxRetransmits ?? -1; c.id=this.channels.length; this.channels.push(c); return c; }
  createOffer() { return this.offer(); }
  async createAnswer() { return {type:'answer', sdp:'native-answer'}; }
  async setLocalDescription(value: NativeDescription) { this.descriptions.push(value); this.localDescription = value; }
  async setRemoteDescription(value: NativeDescription) { this.descriptions.push(value); }
  report: RTCStatsReport = new Map([['native', {id:'native'}]]);
  async getStats() { return this.report; }
  close() { this.closes++; }
}
function fixture() { const producer = new Producer(); const converted: NativeDescription[] = []; const port = createNativePeerPort(producer, value => { const result = {...value}; converted.push(result); return result; }); return {producer, port, converted}; }

test('native initiated raw negotiation accepts producer -1 reliable and explicit zero disposable', async () => {
  const {producer,port,converted} = fixture(); const transport = new PeerDataTransport({initiator:true, createPeer:() => port});
  assert.deepEqual(await transport.createOffer(), {type:'offer',sdp:'native-offer'});
  await transport.acceptAnswer({type:'answer',sdp:'browser-answer'});
  assert.equal(converted.length,2); assert.equal(producer.descriptions[1],converted[1]);
  assert.equal(transport.send('reliable','control'),true); assert.equal(transport.send('disposable','sample'),true);
  const received: unknown[] = []; transport.onData((lane,data) => received.push([lane,data]));
  const bytes = new Uint8Array([1,2,3,4]); const view = bytes.subarray(1,3); assert.equal(transport.send('disposable',view),true);
  assert.equal(producer.channels[1].sent[1],view);
  producer.channels[1].onmessage?.({data:view.buffer}); assert.deepEqual(received,[['disposable',view.buffer]]);
  assert.deepEqual(await transport.stats(),new Map([['native',{id:'native'}]])); await transport.disconnect();
  assert.equal(producer.closes,1); assert.ok(producer.channels.every(c => c.closes===1 && c.onmessage===null && c.onclose===null && c.onerror===null));
});

test('delivery getters normalize only -1 and cannot be written', () => {
  const {producer,port} = fixture(); const c=port.createDataChannel('samples',{ordered:false,maxRetransmits:0});
  assert.equal(c.maxPacketLifeTime,null); assert.equal(c.maxRetransmits,0);
  producer.channels[0].maxPacketLifeTime=17; assert.equal(c.maxPacketLifeTime,17);
  producer.channels[0].maxPacketLifeTime=undefined; assert.ok(Number.isNaN(c.maxPacketLifeTime));
  assert.equal(Reflect.set(c,'ordered',true),false);
});

test('iOS uint16 unset limits qualify only locally initiated omitted delivery options', async () => {
  const producer = new Producer();
  const original = producer.createDataChannel.bind(producer);
  producer.createDataChannel = (label, options) => {
    const channel = original(label, options);
    channel.maxPacketLifeTime = options.maxPacketLifeTime ?? 65535;
    channel.maxRetransmits = options.maxRetransmits ?? 65535;
    return channel;
  };
  const port = createNativePeerPort(producer, value => value, { unsetDeliveryLimit: 65535 });
  const transport = new PeerDataTransport({ initiator: true, createPeer: () => port });
  assert.deepEqual(await transport.createOffer(), { type: 'offer', sdp: 'native-offer' });
  assert.equal(transport.send('reliable', 'control'), true);
  assert.equal(transport.send('disposable', 'sample'), true);
  const explicit = port.createDataChannel('finite', { ordered: true, maxRetransmits: 65535 });
  assert.equal(explicit.maxRetransmits, 65535, 'explicit finite delivery must not become reliable');
  let incoming!: import('@101/transport-webrtc').PeerDataChannelPort;
  port.ondatachannel = event => { incoming = event.channel; };
  const remote = new Channel('remote'); remote.maxPacketLifeTime = 65535; remote.maxRetransmits = 65535;
  producer.ondatachannel?.({ channel: remote });
  assert.equal(incoming.maxPacketLifeTime, 65535, 'incoming uint16 metadata cannot prove omitted options');
  assert.equal(incoming.maxRetransmits, 65535);
  await transport.disconnect();
});

test('raw peer rejects missing or invalid metadata and Android incoming samples reporting reliable', async () => {
  for (const lifetime of [undefined,NaN,-2,0,4]) {
    const {producer,port}=fixture(); const original=producer.createDataChannel.bind(producer);
    producer.createDataChannel=(label,options)=>{const c=original(label,options); c.maxPacketLifeTime=lifetime; return c;};
    const transport=new PeerDataTransport({initiator:true,createPeer:()=>port});
    await assert.rejects(transport.connect(),/Incompatible/); assert.equal(producer.closes,1);
  }
  const {producer,port}=fixture(); const transport=new PeerDataTransport({initiator:false,createPeer:()=>port}); await transport.connect();
  const incoming=new Channel('connect-samples-1'); producer.ondatachannel?.({channel:incoming});
  assert.equal(incoming.closes,1); assert.equal(transport.isOpen('disposable'),false); await transport.disconnect();
});

test('callback forwarding and ICE listeners are suppressed and cleaned after close', () => {
  const {producer,port}=fixture(); const c=port.createDataChannel('control',{}); let events=0;
  port.onconnectionstatechange=()=>events++; c.onmessage=()=>events++; c.onerror=()=>events++; c.onclose=()=>events++;
  const ice=()=>events++; port.addEventListener('icegatheringstatechange',ice); port.addEventListener('icegatheringstatechange',ice);
  assert.equal(typeof producer.onicegatheringstatechange,'function'); const lateIce=producer.onicegatheringstatechange!; const lateMessage=producer.channels[0].onmessage; const lateState=producer.onconnectionstatechange; const lateIncoming=producer.ondatachannel;
  producer.onconnectionstatechange?.({}); producer.channels[0].onmessage?.({data:'a'}); producer.channels[0].onerror?.({}); lateIce({}); assert.equal(events,4);
  port.close(); port.close(); lateIce({}); lateMessage?.({data:'late'}); lateState?.({}); const orphan=new Channel('late'); lateIncoming?.({channel:orphan});
  assert.equal(events,4); assert.equal(orphan.closes,1); assert.equal(producer.onicegatheringstatechange,null); assert.equal(producer.closes,1); assert.equal(port.onconnectionstatechange,null); assert.equal(c.onmessage,null);
});

test('pending native offer completion is cancelled by disposal', async () => {
  const {producer,port}=fixture(); let resolve!: (value: NativeDescription)=>void; producer.offer=()=>new Promise(done=>{resolve=done;});
  const pending=port.createOffer(); port.close(); resolve({type:'offer',sdp:'late'}); await assert.rejects(pending,/closed/);
  assert.throws(()=>port.createDataChannel('late',{}),/closed/);
});

test('raw transport cancels gathering and removes the native subscription on disconnect', async () => {
  const {producer,port}=fixture(); producer.iceGatheringState='gathering';
  const transport=new PeerDataTransport({initiator:true,createPeer:()=>port}); const pending=transport.createOffer();
  // Native description methods resolve asynchronously before the raw peer subscribes.
  for (let i=0; i<10 && !producer.onicegatheringstatechange; i++) await Promise.resolve();
  assert.equal(typeof producer.onicegatheringstatechange,'function');
  await transport.disconnect(); await assert.rejects(pending,/disconnected/); assert.equal(producer.onicegatheringstatechange,null);
});

test('native close clears channel callbacks before notifying and is terminal', () => {
  const {producer,port}=fixture(); const c=port.createDataChannel('control',{}); let closes=0;
  c.onclose=()=>{closes++; assert.equal(c.onmessage,null); assert.equal(c.readyState,'closed');}; c.onmessage=()=>assert.fail('late message');
  const late=producer.channels[0].onmessage; producer.channels[0].onclose?.({}); late?.({data:'late'}); c.close();
  assert.equal(closes,1); assert.equal(producer.channels[0].closes,0); assert.throws(()=>c.send('late'),/closed/); port.close();
});

test('incoming reliable callbacks work and explicit listener removal detaches subscription', async () => {
  const {producer,port}=fixture(); const transport=new PeerDataTransport({initiator:false,createPeer:()=>port}); await transport.connect();
  const c=new Channel('connect-control-1'); producer.ondatachannel?.({channel:c}); assert.equal(transport.send('reliable','a'),true);
  let calls=0; const listener=()=>calls++; port.addEventListener('icegatheringstatechange',listener); const late=producer.onicegatheringstatechange;
  port.removeEventListener('icegatheringstatechange',listener); assert.equal(producer.onicegatheringstatechange,null); late?.({}); assert.equal(calls,0);
  await transport.disconnect();
});

test('unset or invalid retransmits are not synthesized from a reliable channel label', async () => {
  for (const retries of [undefined,NaN,-2,0,5]) {
    const {producer,port}=fixture(); const original=producer.createDataChannel.bind(producer);
    producer.createDataChannel=(label,options)=>{const c=original(label,options); c.maxRetransmits=retries; return c;};
    const transport=new PeerDataTransport({initiator:true,createPeer:()=>port}); await assert.rejects(transport.connect(),/Incompatible/);
  }
});

test('native SDP type is validated and local descriptions return detached snapshots', async () => {
  const {producer,port}=fixture(); producer.localDescription={type:'offer',sdp:'first'};
  const snapshot=port.localDescription!; snapshot.sdp='changed'; assert.equal(port.localDescription?.sdp,'first');
  producer.offer=async()=>({type:'bogus',sdp:'offer'}); await assert.rejects(port.createOffer(),/Invalid/);
  await assert.rejects(port.setRemoteDescription({type:'answer'}),/Invalid/); port.close();
});

test('missing ordered metadata cannot qualify disposable delivery', () => {
  const {producer,port}=fixture(); const original=producer.createDataChannel.bind(producer);
  producer.createDataChannel=(label,options)=>{const c=original(label,options); Reflect.deleteProperty(c,'ordered'); return c;};
  assert.throws(()=>port.createDataChannel('connect-samples-1',{ordered:false,maxRetransmits:0}),/Incompatible/);
  assert.equal(producer.channels[0].closes,1); port.close();
});

test('same-turn native bridge submissions cannot exceed the raw reliable buffer limit', async () => {
  const {producer,port}=fixture(); const transport=new PeerDataTransport({initiator:true,createPeer:()=>port}); await transport.connect();
  const data=new ArrayBuffer(262144);
  assert.equal(transport.send('reliable',data),true);
  assert.equal(producer.channels[0].bufferedAmount,0); // Real JS producer updates only from later native events.
  assert.equal(transport.send('reliable',data),false);
  assert.equal(producer.channels[0].sent.reduce((sum,value)=>sum+(typeof value==='string'?new TextEncoder().encode(value).length:value.byteLength),0),262144);
  await transport.disconnect();
});

function channelStats(id: number, label: string, bytesSent: number, statId = `D${id}`, messagesSent = 1): RTCStatsReport {
  return new Map([[statId,{id:statId,type:'data-channel',dataChannelIdentifier:id,label,bytesSent,messagesSent}]]);
}
test('only exact owned cumulative native stats retire synchronously reserved payload bytes', async () => {
  const {producer,port}=fixture(); const channel=port.createDataChannel('control',{});
  channel.send('é'); channel.send(new Uint8Array([1,2,3,4]).subarray(1,3)); assert.equal(channel.bufferedAmount,4);
  producer.channels[0].bufferedAmount=0; await port.getStats(); assert.equal(channel.bufferedAmount,4);
  for (const report of [channelStats(9,'control',4),channelStats(0,'other',4),channelStats(0,'control',5),channelStats(0,'control',NaN)]) {
    producer.report=report; await port.getStats(); assert.equal(channel.bufferedAmount,4);
  }
  producer.report=channelStats(0,'control',2); await port.getStats(); assert.equal(channel.bufferedAmount,2);
  producer.report=channelStats(0,'control',1); await port.getStats(); assert.equal(channel.bufferedAmount,2);
  producer.report=channelStats(0,'control',4,'changed-id'); await port.getStats(); assert.equal(channel.bufferedAmount,2);
  producer.report=channelStats(0,'control',4,'D0',2); await port.getStats(); assert.equal(channel.bufferedAmount,0); port.close();
});

test('native stats never credit reused SCTP identifiers or stale completions after close', async () => {
  const {producer,port}=fixture(); const first=port.createDataChannel('same',{}); first.send('abcd');
  producer.report=channelStats(0,'same',4); await port.getStats(); first.close();
  const second=port.createDataChannel('same',{}); producer.channels[1].id=0; second.send('abcd');
  await port.getStats(); assert.equal(second.bufferedAmount,4);
  let resolve!: (value:RTCStatsReport)=>void; producer.getStats=()=>new Promise(done=>{resolve=done;});
  const pending=port.getStats(); port.close(); resolve(channelStats(0,'same',4)); await assert.rejects(pending,/closed/);
});

test('native snapshots cannot understate shadow reservations and bridge errors retain uncertainty', () => {
  const {producer,port}=fixture(); const c=port.createDataChannel('control',{});
  c.send(new ArrayBuffer(10)); producer.channels[0].bufferedAmount=1; assert.equal(c.bufferedAmount,10);
  producer.channels[0].bufferedAmount=100; assert.equal(c.bufferedAmount,100);
  producer.channels[0].send=()=>{throw new Error('bridge failure');}; assert.throws(()=>c.send(new ArrayBuffer(200)),/bridge/);
  producer.channels[0].bufferedAmount=0; assert.equal(c.bufferedAmount,210); port.close();
});

test('zero-payload native bridge commands have a synchronous pending-message bound', async () => {
  const {producer,port}=fixture(); const transport=new PeerDataTransport({initiator:true,createPeer:()=>port}); await transport.connect();
  for (let i=0;i<256;i++) assert.equal(transport.send('reliable',i%2?'':new ArrayBuffer(0)),true);
  assert.equal(transport.send('reliable',''),false); assert.equal(producer.channels[0].sent.length,256);
  producer.report=new Map([['D0',{id:'D0',type:'data-channel',dataChannelIdentifier:0,label:'connect-control-1',bytesSent:0,messagesSent:256}]]);
  await transport.stats(); assert.equal(transport.send('reliable',''),true); await transport.disconnect();
});

test('invalid message counters, duplicate identities and pre-negotiation ids retain outstanding bounds', async () => {
  const {producer,port}=fixture(); const c=port.createDataChannel('control',{}); c.send('abcd');
  for (const messages of [undefined,NaN,-1,2,0]) {
    producer.report=new Map([['D0',{id:'D0',type:'data-channel',dataChannelIdentifier:0,label:'control',bytesSent:4,messagesSent:messages}]]);
    await port.getStats(); assert.equal(c.bufferedAmount,4);
  }
  producer.channels[0].id=null; producer.report=channelStats(0,'control',4); await port.getStats(); assert.equal(c.bufferedAmount,4);
  producer.channels[0].id=0;
  const other=port.createDataChannel('other',{}); producer.channels[1].id=0; other.send('abcd');
  producer.report=channelStats(0,'control',4); await port.getStats(); assert.equal(c.bufferedAmount,4); assert.equal(other.bufferedAmount,4); port.close();
});

test('incoming producer channels receive no cumulative stat credit', () => {
  const {producer,port}=fixture(); let received: import('@101/transport-webrtc').PeerDataChannelPort | undefined;
  port.ondatachannel=event=>{received=event.channel;}; const incoming=new Channel('incoming'); incoming.id=0; producer.ondatachannel?.({channel:incoming});
  received!.send('abcd'); producer.report=channelStats(0,'incoming',4);
  return port.getStats().then(()=>{assert.equal(received!.bufferedAmount,4);port.close();});
});

test('message credit matches actual payload prefixes including empty messages', async () => {
  const {producer,port}=fixture(); const channel=port.createDataChannel('control',{});
  for (let count=0;count<256;count++) channel.send('x');
  producer.report=channelStats(0,'control',0,'DC0',256);
  await port.getStats();
  assert.throws(()=>channel.send('x'),/pending-message/);
  assert.equal(channel.bufferedAmount,256);
  producer.report=channelStats(0,'control',128,'DC0',128);
  await port.getStats(); assert.equal(channel.bufferedAmount,128);
  channel.send(''); channel.send('');
  producer.report=channelStats(0,'control',256,'DC0',258);
  await port.getStats(); assert.equal(channel.bufferedAmount,0);
  channel.send('next'); assert.equal(channel.bufferedAmount,4);
  producer.report=channelStats(0,'control',256,'DC0',259);
  await port.getStats(); assert.equal(channel.bufferedAmount,4);
  port.close();
});
