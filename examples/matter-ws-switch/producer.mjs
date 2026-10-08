import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const { WebSocketServer } = createRequire(import.meta.url)('ws');
// Native literals manually derived from the pinned v1.4.0 producer, not the decoder.
const info = '{"fabric_id":9007199254740993,"compressed_fabric_id":18446744073709551615,"fabric_index":1,"schema_version":13,"min_supported_schema_version":11,"sdk_version":"matter-server/1.4.0 (matter.js/0.17.9)","wifi_credentials_set":false,"thread_credentials_set":false,"bluetooth_enabled":false,"controller_node_id":9007199254740992}';
const node = '{"node_id":7,"date_commissioned":"2026-10-08T00:00:00.000Z","last_interview":"2026-10-08T00:00:00.000Z","interview_version":6,"available":true,"is_bridge":false,"attributes":{"1/59/0":2,"1/59/1":null,"1/59/65532":2},"attribute_subscriptions":[],"matter_version":"1.4.0"}';
const inventory = '{"message_id":"listen-1","result":[' + node + ',' + node.replace('"node_id":7', '"node_id":18446744073709551615') + ']}';
const press = '{"event":"node_event","data":{"node_id":7,"endpoint_id":1,"cluster_id":59,"event_id":1,"event_number":9007199254740993,"priority":1,"timestamp":18446744073709551615,"timestamp_type":1,"data":{"newPosition":1}}}';
const messages = { position0: '{"event":"attribute_updated","data":[7,"1/59/1",0]}', position1: '{"event":"attribute_updated","data":[7,"1/59/1",1]}', null: '{"event":"attribute_updated","data":[7,"1/59/1",null]}', press, repeat: press, older: press.replace('9007199254740993', '9007199254740992'), next: press.replace('9007199254740993', '9007199254740994').replace('"timestamp_type":1', '"timestamp_type":0'), last: press.replace('9007199254740993', '9007199254740995').replace('"timestamp_type":1', '"timestamp_type":2'), unrelated: press.replace('"node_id":7', '"node_id":18446744073709551615'), cache: '{"event":"node_updated","data":' + node + '}', compatible: '{"event":"attribute_updated","data":[7,"1/59/65532",2]}', offline: '{"event":"node_updated","data":' + node.replace('"available":true', '"available":false') + '}' };
const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/ws', perMessageDeflate: false, maxPayload: 32768 });
let commands = 0, closing = false;
const sockets = new Set(), nativeCloses = new Set(), writes = [], ipcWrites = [], operations = new Set();
function send(socket, payload) {
    let resolve, reject;
    const write = new Promise((res, rej) => { resolve = res; reject = rej; });
    writes.push(write); void write.catch(() => {});
    try { socket.send(payload, error => error ? reject(error) : resolve()); }
    catch (error) { reject(error); }
    return write;
}
function sendIpc(message) {
    let resolve, reject;
    const write = new Promise((res, rej) => { resolve = res; reject = rej; });
    ipcWrites.push(write); void write.catch(() => { process.exitCode = 1; });
    try { process.send(message, error => error ? reject(error) : resolve()); }
    catch (error) { reject(error); }
    return write;
}
function ownOperation(operation) { operations.add(operation); void operation.then(() => operations.delete(operation), () => { operations.delete(operation); process.exitCode = 1; }); }
server.on('connection', socket => { sockets.add(socket); const closed = new Promise(res => socket.once('close', () => { sockets.delete(socket); res(); })); nativeCloses.add(closed); socket.on('error', () => { }); void send(socket, info).catch(() => { }); socket.on('message', (data, binary) => { if (closing) return; ownOperation((async () => { try {
    assert.equal(binary, false);
    assert.equal(data.toString(), '{"message_id":"listen-1","command":"start_listening","args":{}}');
    assert.equal(++commands, 1);
    await send(socket, inventory);
}
catch (e) {
    await sendIpc({ kind: 'error', reason: e.message });
    socket.close();
} })()); }); });
async function close() {
    if (closing) return;
    closing = true;
    await Promise.allSettled([...operations]);
    for (const socket of sockets) socket.close();
    const serverClosed = new Promise((res, rej) => server.close(error => error ? rej(error) : res()));
    void serverClosed.catch(() => {});
    const results = await Promise.allSettled([serverClosed, ...writes, ...nativeCloses, ...ipcWrites]);
    if (process.connected) process.disconnect();
    assert.ok(results.every(r => r.status === 'fulfilled'));
}
async function request(message) {
    try {
        const payload = messages[message.kind];
        assert.ok(payload);
        const results = await Promise.allSettled([...sockets].filter(s => s.readyState === 1).map(s => send(s, payload)));
        for (const result of results) if (result.status === 'rejected') throw result.reason;
        await sendIpc({ kind: 'sent', id: message.id, payload, payloadSha256: createHash('sha256').update(payload).digest('hex'), commands });
    } catch (error) {
        await sendIpc({ kind: 'error', id: message.id, reason: error.message });
    }
}
process.on('message', message => {
    if (message.kind === 'close') { void close().catch(() => { process.exitCode = 1; }); return; }
    if (closing) return;
    ownOperation(request(message));
});
server.once('listening', () => { void sendIpc({ kind: 'ready', pid: process.pid, endpoint: 'ws://127.0.0.1:' + server.address().port + '/ws' }); });
process.once('disconnect', () => { if (!closing) void close().catch(() => { process.exitCode = 1; }); });
