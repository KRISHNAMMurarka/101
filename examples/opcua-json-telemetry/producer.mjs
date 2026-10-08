import { connectAsync } from 'mqtt';
import { randomUUID, createHash } from 'node:crypto';

// Independently owned software publisher; IPC only selects the test stimulus.
const endpoint = process.argv[2];
if (!/^mqtt:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(endpoint ?? '') || !process.send) throw new Error('Owned loopback fixture required');
const topic = 'opcua/json/data/owned-publisher';
const client = await connectAsync(endpoint, { protocolVersion: 5, clean: true, reconnectPeriod: 0, resubscribe: false,
  queueQoSZero: false, properties: { sessionExpiryInterval: 0 }, connectTimeout: 3000 });
client.on('error', error => process.send?.({ kind: 'error', reason: error.code ?? 'mqtt-error' }));
let sequence = -1, last, closed = false, chain = Promise.resolve();
function frame(kind) {
  if (kind === 'duplicate') { if (!last) throw new Error('No fixture message'); return last; }
  sequence += kind === 'gap' ? 3 : 1;
  const value = { Value: 25.5, SourceTimestamp: '2026-10-08T00:00:00.1234567Z', ServerTimestamp: '2026-10-08T00:00:00.999Z', SourcePicoseconds: 12 };
  if (kind === 'uncertain') value.Status = { Code: 0x40000000, Symbol: 'Uncertain' };
  if (kind === 'bad') { value.Status = { Code: 0x80000000, Symbol: 'Bad' }; value.Value = null; }
  last = { MessageId: randomUUID(), MessageType: 'ua-data', PublisherId: 'owned-publisher', WriterGroupName: 'OwnedGroup',
    DataSetClassId: '11111111-1111-4111-8111-111111111111', Messages: [{ DataSetWriterId: 1, SequenceNumber: sequence,
      MetaDataVersion: { MajorVersion: 1, MinorVersion: 1 }, Timestamp: '2026-10-08T00:00:01Z', MessageType: 'ua-keyframe', Payload: { Temperature: value } }] };
  return last;
}
async function close() { if (closed) return; closed = true; await client.endAsync(true); process.disconnect?.(); }
process.on('disconnect', () => { void close(); });
process.on('message', message => {
  chain = chain.then(async () => {
    if (!message || typeof message !== 'object' || !Number.isSafeInteger(message.id) || closed) throw new Error('Invalid fixture request');
    if (message.kind === 'close') { process.send?.({ kind: 'closed', id: message.id }); await close(); return; }
    if (!['good','uncertain','bad','gap','duplicate','invalid','contentType'].includes(message.kind)) throw new Error('Invalid fixture case');
    const bytes = Buffer.from(message.kind === 'invalid' ? '{invalid' : JSON.stringify(frame(message.kind)));
    await client.publishAsync(topic, bytes, { qos: 1, retain: false, properties: { contentType: message.kind === 'contentType' ? 'text/plain' : 'application/json', payloadFormatIndicator: true } });
    process.send?.({ kind: 'published', id: message.id, payloadSha256: createHash('sha256').update(bytes).digest('hex'), bytesHex: bytes.toString('hex') });
  }).catch(async () => { process.send?.({ kind: 'error', id: message?.id, reason: 'fixture-failed' }); await close(); process.exitCode = 1; });
});
process.send({ kind: 'ready', pid: process.pid, transport: 'MQTT5 standard JSON' });
