import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFileSync } from 'node:fs';
import { connectAsync, MqttClient } from 'mqtt';
import { startOwnedMqttBroker } from '../../../tools/qa-mqtt-connector.mjs';
import type { OpcUaJsonApprovalRequest, OpcUaJsonReading } from './opcua-json-telemetry.ts';
const api = await import('./opcua-json-telemetry.ts').catch(() => undefined);
const encoder = new TextEncoder();
function profile() { return { id: 'example:opcua-temperature', revision: 1, topic: 'opcua/json/data/owned-publisher', publisherId: 'owned-publisher',
  writerGroupName: 'OwnedGroup', dataSetClassId: '11111111-1111-4111-8111-111111111111', dataSetWriterId: 1,
  metadataVersion: { major: 1, minor: 1 }, field: { name: 'Temperature', builtInType: 11 as const, dataType: 'i=11' as const, valueRank: -1 as const,
    engineeringUnits: { namespaceUri: 'http://www.opcfoundation.org/UA/units/un/cefact' as const, unitId: 4408652 as const }, unit: 'Cel' as const, min: -50, max: 150 }, receiveTimeoutMs: 1000 }; }
function frame() { return { MessageId: '11111111-1111-4111-8111-111111111112', MessageType: 'ua-data', PublisherId: 'owned-publisher', WriterGroupName: 'OwnedGroup',
  DataSetClassId: '11111111-1111-4111-8111-111111111111', Messages: [{ DataSetWriterId: 1, SequenceNumber: 0,
    MetaDataVersion: { MajorVersion: 1, MinorVersion: 1 }, Timestamp: '2026-10-08T00:00:01Z', MessageType: 'ua-keyframe',
    Payload: { Temperature: { Value: 25.5, SourceTimestamp: '2026-10-08T00:00:00.1234567Z', ServerTimestamp: '2026-10-08T00:00:00.999Z' } } }] }; }
test('standard UA keyframe preserves native quantity, omitted Good and original UTC', () => {
  assert.equal(typeof api?.decodeOpcUaJsonTelemetry, 'function', 'missing selected OPC UA parser'); assert.ok(api);
  const actual = api.decodeOpcUaJsonTelemetry(encoder.encode(JSON.stringify(frame())), profile());
  assert.equal(actual.record.temperature, 25.5); assert.equal(actual.record.severity, 'good'); assert.equal(actual.record.statusCode, 0);
  assert.equal(actual.record.sourceTimestamp, '2026-10-08T00:00:00.1234567Z');
});
test('strict parser rejects hostile protocol bytes before values are used', () => {
  assert.ok(api);
  const base = JSON.stringify(frame());
  const rejected: [string, Uint8Array][] = [ ['utf8', new Uint8Array([0xff])], ['oversize', new Uint8Array(8193)], ['malformed', encoder.encode('{')],
    ['duplicate', encoder.encode(base.replace('"Value":25.5', '"Value":25.5,"Value":26'))],
    ['escaped-duplicate', encoder.encode(base.replace('"Value":25.5', '"Value":25.5,"V\\u0061lue":26'))],
    ...[['publisher', 'owned-publisher', 'other'], ['writer', '"DataSetWriterId":1', '"DataSetWriterId":2'],
      ['metadata', '"MajorVersion":1', '"MajorVersion":2'], ['type', '"Value":25.5', '"Value":"25.5"'],
      ['infinity', '"Value":25.5', '"Value":1e999'], ['range', '"Value":25.5', '"Value":151'],
      ['date', '2026-10-08T00:00:00.1234567Z', '2026-02-30T00:00:00Z'],
      ['precision', '2026-10-08T00:00:00.1234567Z', '2026-10-08T00:00:00.12345678Z'],
      ['format', '"ua-keyframe"', '"ua-deltaframe"'], ['extra', '"Value":25.5', '"Value":25.5,"extra":1'],
      ['prototype', '"Value":25.5', '"Value":25.5,"__proto__":{}'],
      ['bad-code', '"Value":25.5', '"Value":25.5,"Status":{"Code":-1}'],
      ['orphan-pico', '"ServerTimestamp":"2026-10-08T00:00:00.999Z"', '"ServerPicoseconds":10'],
      ['source-missing', ',"SourceTimestamp":"2026-10-08T00:00:00.1234567Z"', ''],
    ].map(([name, from, to]) => [name!, encoder.encode(base.replace(from!, to!))] as [string, Uint8Array]) ];
  for (const [name, bytes] of rejected) {
    assert.throws(() => api.decodeOpcUaJsonTelemetry(bytes, profile()), TypeError, name);
    if (process.env.OPCUA_REJECTED_BYTES) appendFileSync(process.env.OPCUA_REJECTED_BYTES, JSON.stringify({ name, hex: Buffer.from(bytes).toString('hex') }) + '\n');
  }
});
test('native Uncertain and Bad remain explicit and Bad never exposes numeric measurement', () => {
  assert.ok(api); const base = JSON.stringify(frame());
  for (const [code, severity, value] of [[0x40000000, 'uncertain', 25.5], [0x80000000, 'bad', undefined], [1, 'good', 25.5]] as const) {
    const decoded = api.decodeOpcUaJsonTelemetry(encoder.encode(base.replace('"Value":25.5', `"Value":25.5,"Status":{"Code":${code}}`)), profile());
    assert.equal(decoded.record.severity, severity); assert.equal(decoded.record.statusCode, code); assert.equal(decoded.record.temperature, value);
  }
  const bad = api.decodeOpcUaJsonTelemetry(encoder.encode(base.replace('"Value":25.5', '"Value":null,"Status":{"Code":2147483648}')), profile());
  assert.equal(bad.record.temperature, undefined);
  const overall = api.decodeOpcUaJsonTelemetry(encoder.encode(base.replace('"SequenceNumber":0', '"SequenceNumber":0,"Status":{"Code":2147483648}')), profile());
  assert.equal(overall.record.severity, 'bad'); assert.equal(overall.record.temperature, undefined);
});
test('native UInt32 sequence uses UA bounds and rollover rather than signed arithmetic', () => {
  assert.ok(api);
  for (const [last, incoming, want] of [[0,1,0],[1,4,2],[0xffffffff,0,0],[1,1,undefined],[3,2,undefined],[0,0x40000001,undefined]] as const)
    assert.equal(api.opcUaSequenceGap(last,incoming), want);
});
test('reviewed profile rejects proxies, accessors and unknown engineering units without invoking getters', () => {
  assert.ok(api); let reads = 0;
  assert.throws(() => api.parseOpcUaJsonProfile(new Proxy(profile(), {})), TypeError);
  const hostile = { ...profile(), get topic() { reads++; return 'unexpected'; } };
  assert.throws(() => api.parseOpcUaJsonProfile(hostile), TypeError); assert.equal(reads, 0);
  const wrong = profile(); wrong.field.engineeringUnits.unitId = 1 as 4408652;
  assert.throws(() => api.parseOpcUaJsonProfile(wrong), TypeError);
});
function options(endpoint = 'mqtt://127.0.0.1:1') {
  const owner = new AbortController(), grant = new AbortController(), readings: OpcUaJsonReading[] = [], unavailable: string[] = [];
  return { owner, grant, readings, unavailable, input: { ownerSignal: owner.signal, scope: { principalId:'owner',applicationId:'ua-example',sessionId:'one' }, endpoint,
    profile:profile(), authorize(request: OpcUaJsonApprovalRequest) { return { request, signal:grant.signal, expiresAt:performance.now()+5000 }; },
    onReading(reading: OpcUaJsonReading) { readings.push(reading); }, onUnavailable(reason:string) { unavailable.push(reason); } } };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return {promise,resolve}; }
async function until(predicate:()=>boolean, ms=1000) { const end=performance.now()+ms; while (!predicate()) {
  assert.ok(performance.now()<end, 'bounded wait expired'); await new Promise(done=>setTimeout(done,5)); } }
test('denied or forged authority cannot allocate a native MQTT client', async () => {
  assert.equal(typeof api?.createOpcUaJsonTelemetryConnector, 'function', 'missing authorized selected OPC UA connector'); assert.ok(api);
  const fixture=options(); const connector=api.createOpcUaJsonTelemetryConnector({...fixture.input,authorize:()=>undefined});
  assert.deepEqual(await connector.start({purpose:'read',signal:fixture.owner.signal}),{ok:false,reason:'denied'});
  assert.equal(connector.status().nativeClients,0); await connector.close();
  const wrong=api.createOpcUaJsonTelemetryConnector({...fixture.input,authorize:request=>({request:{...request},signal:fixture.grant.signal,expiresAt:performance.now()+1000})});
  assert.equal((await wrong.start({purpose:'read',signal:fixture.owner.signal})).ok,false); assert.equal(wrong.status().nativeClients,0); await wrong.close();
  assert.throws(()=>api.createOpcUaJsonTelemetryConnector({...fixture.input,ownerSignal:{aborted:false} as AbortSignal}),TypeError);
  assert.throws(()=>api.createOpcUaJsonTelemetryConnector({...fixture.input,endpoint:'mqtt://localhost:1883'}),TypeError);
});
test('authority callout cannot replace profile or owner signals', async () => {
  assert.ok(api?.createOpcUaJsonTelemetryConnector); const broker=await startOwnedMqttBroker(), fixture=options(broker.endpoint); const mutable=fixture.input;
  const original=mutable.authorize; mutable.authorize=request=>{
    mutable.profile.topic='other'; mutable.ownerSignal=new AbortController().signal;
    assert.equal(request.profile.topic,'opcua/json/data/owned-publisher'); assert.ok(Object.isFrozen(request.profile.field)); return original(request);
  };
  const connector=api.createOpcUaJsonTelemetryConnector(mutable);
  try { assert.ok((await connector.start({purpose:'read',signal:fixture.owner.signal})).ok); fixture.owner.abort(); await connector.close();
    assert.equal(connector.status().nativeClients,0); assert.equal(fixture.readings.length,0);
  } finally { await connector.close(); await broker.close(); }
});
test('revocation while native SUBACK is held never activates the session', async () => {
  assert.ok(api?.createOpcUaJsonTelemetryConnector); const broker=await startOwnedMqttBroker(), fixture=options(broker.endpoint), entered=deferred(), held=deferred();
  const original=MqttClient.prototype.subscribeAsync;
  MqttClient.prototype.subscribeAsync=async function(...args:Parameters<typeof original>) {
    const result=await original.apply(this,args); entered.resolve(); await held.promise; return result;
  };
  const connector=api.createOpcUaJsonTelemetryConnector(fixture.input);
  try { const start=connector.start({purpose:'read',signal:fixture.owner.signal}); await entered.promise; fixture.grant.abort(); held.resolve();
    assert.equal((await start).ok,false); await connector.close(); assert.equal(connector.status().nativeClients,0); assert.equal(fixture.readings.length,0);
  } finally { held.resolve(); MqttClient.prototype.subscribeAsync=original; await connector.close(); await broker.close(); }
});
test('actual broker preserves native wrap, detects loss and ignores replay without renewing freshness', async () => {
  assert.ok(api?.createOpcUaJsonTelemetryConnector); const broker=await startOwnedMqttBroker(), fixture=options(broker.endpoint); fixture.input.profile.receiveTimeoutMs=250;
  const connector=api.createOpcUaJsonTelemetryConnector(fixture.input); let publisher: MqttClient|undefined;
  try { assert.ok((await connector.start({purpose:'read',signal:fixture.owner.signal})).ok);
    publisher=await connectAsync(broker.endpoint,{protocolVersion:5,reconnectPeriod:0});
    let message=frame(); message.Messages[0]!.SequenceNumber=0xffffffff;
    const send=async()=>publisher!.publishAsync(profile().topic,JSON.stringify(message),{qos:1,retain:false,properties:{contentType:'application/json'}});
    await send(); await until(()=>fixture.readings.length===1);
    message={...frame(),MessageId:'id-wrap'}; message.Messages[0]!.SequenceNumber=0; await send(); await until(()=>fixture.readings.length===2);
    message={...frame(),MessageId:'id-gap'}; message.Messages[0]!.SequenceNumber=3; await send(); await until(()=>fixture.readings.length===3);
    assert.equal(fixture.readings[2]!.record.missingMessages,2); assert.equal(fixture.readings[2]!.localSequence,3);
    message.Messages[0]!.SequenceNumber=4; await send(); await until(()=>connector.status().rejectedMessages===1);
    await until(()=>connector.status().phase!=='ready',1000); await connector.close();
    assert.equal(connector.status().nativeClients,0); assert.equal(fixture.readings.length,3); assert.equal(fixture.unavailable.length,1);
  } finally { await connector.close(); await publisher?.endAsync(true); await broker.close(); }
});
test('concurrent close waits for native retirement already started by stop', async () => {
  assert.ok(api?.createOpcUaJsonTelemetryConnector); const broker=await startOwnedMqttBroker(), fixture=options(broker.endpoint), entered=deferred(), held=deferred();
  const original=MqttClient.prototype.endAsync;
  const connector=api.createOpcUaJsonTelemetryConnector(fixture.input);
  try { assert.ok((await connector.start({purpose:'read',signal:fixture.owner.signal})).ok);
    MqttClient.prototype.endAsync=(async function(this:MqttClient,...args:Parameters<typeof original>) {entered.resolve();await held.promise;return original.apply(this,args);}) as typeof original;
    let settled=false; const first=connector.stop(); await entered.promise; const second=connector.close().then(()=>{settled=true;});
    await new Promise(done=>setTimeout(done,20)); assert.equal(settled,false); assert.equal(connector.status().nativeClients,1);
    held.resolve();await first;await second;assert.equal(connector.status().nativeClients,0);
  } finally { held.resolve(); MqttClient.prototype.endAsync=original; await connector.close();await broker.close(); }
});
test('retained or non-JSON MQTT packets retire before callback delivery', async () => {
  assert.ok(api?.createOpcUaJsonTelemetryConnector);
  for (const kind of ['retained','contentType','malformed'] as const) {
    const broker=await startOwnedMqttBroker(),fixture=options(broker.endpoint),connector=api.createOpcUaJsonTelemetryConnector(fixture.input);
    let publisher:MqttClient|undefined;
    try {assert.ok((await connector.start({purpose:'read',signal:fixture.owner.signal})).ok);publisher=await connectAsync(broker.endpoint,{protocolVersion:5,reconnectPeriod:0});
      await publisher.publishAsync(profile().topic,kind==='malformed'?'not json':JSON.stringify(frame()),{qos:1,retain:kind==='retained',properties:{contentType:kind==='contentType'?'text/plain':'application/json'}});
      await until(()=>connector.status().phase!=='ready');await connector.close();assert.equal(fixture.readings.length,0);assert.equal(connector.status().nativeClients,0);
    } finally {await connector.close();await publisher?.endAsync(true);await broker.close();}
  }
});
test('separate standard producer and public runtime caller preserve native evidence and route authority', async () => {
  const consumer=await import('../../../examples/opcua-json-telemetry/consumer.mjs').catch(()=>undefined);
  assert.equal(typeof consumer?.runOpcUaJsonTelemetryConsumer,'function','missing actual public OPC UA caller');assert.ok(consumer);
  const broker=await startOwnedMqttBroker();
  try {const result=await consumer.runOpcUaJsonTelemetryConsumer(broker.endpoint);assert.equal(result.status,'pass');
    for(const key of ['nativeQualityPreserved','originalUtcPreserved','routeDenied','gapObserved','replayRejected','retired'] as const) assert.equal(result.checks[key],true,key);
  }finally{await broker.close();}
});
test('start settles after revocation even while the native subscription promise remains held', async () => {
  assert.ok(api); const broker=await startOwnedMqttBroker(),fixture=options(broker.endpoint),entered=deferred(),held=deferred(),original=MqttClient.prototype.subscribeAsync;
  MqttClient.prototype.subscribeAsync=async function(...args:Parameters<typeof original>) {const value=await original.apply(this,args);entered.resolve();await held.promise;return value;};
  const connector=api.createOpcUaJsonTelemetryConnector(fixture.input);let settled=false;
  try {const start=connector.start({purpose:'read',signal:fixture.owner.signal}).then(result=>{settled=true;return result;});await entered.promise;
    fixture.grant.abort();await connector.close();await new Promise(done=>setTimeout(done,20));assert.equal(settled,true,'logical start must not wait for retired native SUBACK promise');
    assert.equal((await start).ok,false);assert.equal(connector.status().nativeClients,0);
  }finally{held.resolve();MqttClient.prototype.subscribeAsync=original;await connector.close();await broker.close();}
});
test('callback exceptions, grant expiry and counted rejected-message quota retire exact owned clients', async () => {
  assert.ok(api);
  for(const kind of ['callback','expiry','quota'] as const){const broker=await startOwnedMqttBroker(),fixture=options(broker.endpoint);
    if(kind==='callback')fixture.input.onReading=()=>{throw new Error('owned callback failure');};
    if(kind==='expiry')fixture.input.authorize=request=>({request,signal:fixture.grant.signal,expiresAt:performance.now()+200});
    const connector=api.createOpcUaJsonTelemetryConnector(fixture.input);let publisher:MqttClient|undefined;
    try{assert.ok((await connector.start({purpose:'read',signal:fixture.owner.signal})).ok);
      if(kind!=='expiry'){publisher=await connectAsync(broker.endpoint,{protocolVersion:5,reconnectPeriod:0});
        const bytes=JSON.stringify(frame());for(let index=0;index<(kind==='quota'?257:1);index++)await publisher.publishAsync(profile().topic,bytes,{qos:1,retain:false,properties:{contentType:'application/json'}});}
      await until(()=>connector.status().phase!=='ready',1200);await connector.close();assert.equal(connector.status().nativeClients,0);assert.equal(fixture.unavailable.length,1);
      assert.equal(connector.status().reason,kind==='expiry'?'expired':kind==='quota'?'quota':'protocol-or-callback');
    }finally{await connector.close();await publisher?.endAsync(true);await broker.close();}
  }
});
for (const quota of ['messages','bytes'] as const) test(`genuine packets received before held SUBACK consume ${quota} quota without delivering telemetry`, async () => {
  assert.ok(api);const broker=await startOwnedMqttBroker(),fixture=options(broker.endpoint),entered=deferred(),held=deferred(),original=MqttClient.prototype.subscribeAsync;let nativePackets=0;
  MqttClient.prototype.subscribeAsync=async function(...args:Parameters<typeof original>) {const result=await original.apply(this,args);this.on('message',topic=>{if(topic===profile().topic)nativePackets++;});entered.resolve();await held.promise;return result;};
  const connector=api.createOpcUaJsonTelemetryConnector(fixture.input);let publisher:MqttClient|undefined,start:ReturnType<typeof connector.start>|undefined;
  try{start=connector.start({purpose:'read',signal:fixture.owner.signal});await entered.promise;
    publisher=await connectAsync(broker.endpoint,{protocolVersion:5,reconnectPeriod:0});
    const wire=JSON.stringify(frame()),bytes=Buffer.from(quota==='bytes'?wire.padEnd(api.OPCUA_JSON_LIMITS.payloadBytes,' '):wire);
    const count=quota==='messages'?api.OPCUA_JSON_LIMITS.messages+1:Math.floor(api.OPCUA_JSON_LIMITS.totalBytes/bytes.byteLength)+1;
    for(let index=0;index<count;index++)await publisher.publishAsync(profile().topic,bytes,{qos:1,retain:false,properties:{contentType:'application/json'}});
    // Publisher PUBACK does not prove subscriber delivery; await a bounded observation.
    await until(()=>nativePackets===count,1200);assert.equal(connector.status().messages,count);assert.equal(connector.status().receivedBytes,bytes.byteLength*count);
    assert.equal(connector.status().reason,'quota');assert.equal(fixture.readings.length,0);await connector.close();
    assert.equal((await start).ok,false);assert.equal(connector.status().nativeClients,0);
  }finally{held.resolve();MqttClient.prototype.subscribeAsync=original;await start;await connector.close();await publisher?.endAsync(true);await broker.close();}
});
