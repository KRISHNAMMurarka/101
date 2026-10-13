import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { decodeMatterSwitchMessage as decode, createMatterWsSwitchConnector as create } from './matter-ws-switch.ts';
import type { MatterPositionReceipt, MatterPressReceipt, MatterSwitchRequest } from './matter-ws-switch.ts';
import type NativeWebSocket from 'ws';
type Options = Parameters<typeof create>[0];
const { WebSocketServer, WebSocket } = createRequire(import.meta.url)('ws') as typeof import('ws');
// Independent native byte literals, derived from the pinned producer and model.
const info = '{"fabric_id":9007199254740993,"compressed_fabric_id":18446744073709551615,"schema_version":13,"min_supported_schema_version":11,"sdk_version":"matter-server/1.4.0 (matter.js/0.17.9)","wifi_credentials_set":false,"thread_credentials_set":false,"bluetooth_enabled":false}';
const node = '{"node_id":7,"date_commissioned":"2026-10-08T00:00:00.000Z","last_interview":"2026-10-08T00:00:00.000Z","interview_version":6,"available":true,"is_bridge":false,"attributes":{"1/59/0":2,"1/59/1":null,"1/59/65532":2},"attribute_subscriptions":[]}';
const inventory = '{"message_id":"listen-1","result":[' + node + ']}';
const press = '{"event":"node_event","data":{"node_id":7,"endpoint_id":1,"cluster_id":59,"event_id":1,"event_number":9007199254740993,"priority":1,"timestamp":18446744073709551615,"timestamp_type":1,"data":{"newPosition":1}}}';
const bytes = (s: string) => Buffer.from(s);
const position = (v: string) => '{"event":"attribute_updated","data":[7,"1/59/1",' + v + ']}';
const scope = Object.freeze({ principalId: 'operator', applicationId: 'test', sessionId: 'local' });
async function ownedScratch(t: TestContext, prefix: string) {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    // Register before copying or importing fixtures, so setup failures also
    // remove this run. Each body joins its native work in finally first.
    t.after(() => rm(directory, { recursive: true, force: true }));
    return directory;
}
test('lossless parser preserves original uint64 identities and timestamp types', () => {
    assert.deepEqual(decode(bytes(info)), { kind: 'serverInfo', fabricId: '9007199254740993', compressedFabricId: '18446744073709551615' });
    for (const n of ['9007199254740992', '9007199254740993', '18446744073709551615'])
        for (const type of [0, 1, 2]) {
            const d = decode(bytes(press.replace('9007199254740993', n).replace('"timestamp_type":1', '"timestamp_type":' + type)));
            assert.equal(d.kind, 'press');
            if (d.kind === 'press') {
                assert.equal(d.eventNumber, n);
                assert.equal(d.timestamp, '18446744073709551615');
                assert.equal(d.timestampType, type);
            }
        }
    assert.equal(decode(bytes(inventory)).kind, 'inventory');
    assert.deepEqual(decode(bytes(position('null'))), { kind: 'position', value: null });
    for (const n of ['9007199254740992', '9007199254740993', '18446744073709551615'])
        assert.equal(decode(bytes(inventory.replace(node, node + ',' + node.replace('"node_id":7', '"node_id":' + n)))).kind, 'inventory');
});
test('uint64 rejects original quoted fractional exponent negative and overflowing tokens', () => {
    for (const n of ['"7"', '7.0', '7e0', '-0', '-1', '18446744073709551616'])
        assert.throws(() => decode(bytes(press.replace('"node_id":7', '"node_id":' + n))), n);
    for (const n of ['"1"', '1.0', '1e0', '-0', '-1', '18446744073709551616'])
        assert.throws(() => decode(bytes(press.replace('9007199254740993', n))), n);
    assert.throws(() => decode(bytes(press.replace('18446744073709551615', '0e0'))));
});
test('bounded parser rejects decoded duplicates prototype markers malformed UTF8 and profile mismatches', () => {
    for (const s of [info.replace('"fabric_id":', '"fabric_id":1,"fabric_\\u0069d":'), info.replace('"fabric_id":', '"__proto__":{},"fabric_id":'), info.replace('false', '"__BIGINT__7"'), info + 'x', info.replace('13', '013'), inventory.replace('"1/59/65532":2', '"1/59/65532":3'), inventory.replace('"1/59/0":2', '"1/59/0":3'), inventory.replace(node, node + ',' + node), inventory.replace('"attribute_subscriptions":[]', '"attribute_subscriptions":[1]'), info.replace('13', '12')])
        assert.throws(() => decode(bytes(s)), s);
    assert.throws(() => decode(Uint8Array.from([0xc0, 0xaf])));
    assert.throws(() => decode(bytes(' '.repeat(32769))));
    assert.throws(() => decode(bytes('{"x":' + '['.repeat(9) + '0' + ']'.repeat(9) + '}')));
    assert.throws(() => decode(bytes('{"x":[' + '0,'.repeat(2049) + '0]}')));
    assert.throws(() => decode(bytes(inventory.replace(node, Array(17).fill(node).join(',')))));
    assert.throws(() => decode(bytes(info.replace('"fabric_id":', '"x":"' + 'a'.repeat(1025) + '","fabric_id":'))));
});
async function peer(mode = 'normal') {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false, maxPayload: 32768 });
    await new Promise<void>(r => server.once('listening', r));
    let socket: NativeWebSocket;
    const commands: string[] = [], pongs: Buffer[] = [];
    server.on('connection', (s: NativeWebSocket) => { socket = s; s.on('error', () => { }); s.on('pong', (b: Buffer) => pongs.push(b)); s.send(mode === 'wrapped' ? '{"event":"server_info_updated","data":' + info + '}' : info); s.on('message', (b: Buffer) => { commands.push(b.toString()); if (mode === 'normal')
        s.send(inventory);
    else if (mode === 'wrong')
        s.send('{"message_id":"other","result":[]}');
    else if (mode === 'error')
        s.send('{"message_id":"listen-1","error_code":1,"details":"denied"}'); }); });
    const address=server.address(); assert.ok(address && typeof address === 'object');
    return { endpoint: 'ws://127.0.0.1:' + address.port + '/ws', commands, pongs, send: (s: string) => socket.send(s), sendBinary: (s: string) => socket.send(Buffer.from(s)), ping: (s: string) => socket.ping(s), close: async () => { for (const s of server.clients)
            s.terminate(); await new Promise<void>(r => server.close(() => r())); } };
}
async function until(p: () => boolean) { const end = performance.now() + 2500; while (!p()) {
    assert.ok(performance.now() < end, 'condition timeout');
    await new Promise(r => setTimeout(r, 5));
} }
function connector(endpoint: string, extra: Partial<Options> = {}) { const owner = new AbortController(), grant = new AbortController(), caller = new AbortController(), positions: MatterPositionReceipt[] = [], events: MatterPressReceipt[] = [], unavailable: string[] = []; const c = create({ endpoint, ownerSignal: owner.signal, scope, authorize: r => ({ request: r, signal: grant.signal, expiresAt: r.deadline }), onPosition: r => positions.push(r), onPress: r => events.push(r), onUnavailable: r => unavailable.push(r), ...extra }); return { c, owner, grant, caller, positions, events, unavailable, start: () => c.start({ purpose: 'native reported switch', deadline: performance.now() + 20000, signal: caller.signal }) }; }
test('standing denial and forged signals cannot create native connections', async () => {
    const p = await peer();
    try {
        for (const authorize of [() => undefined, (r: MatterSwitchRequest) => ({ request: { ...r, authority: 'selected-node-only' } as unknown as MatterSwitchRequest, signal: new AbortController().signal, expiresAt: r.deadline }), (r: MatterSwitchRequest) => ({ request: r, signal: new AbortController().signal, expiresAt: r.deadline + 1 })]) {
            const x = connector(p.endpoint, { authorize });
            assert.equal((await x.start()).ok, false);
            assert.equal(x.c.status().rawSockets, 0);
            await x.c.close();
        }
        const x = connector(p.endpoint);
        for (const signal of [new Proxy(x.caller.signal, {}), Object.create(x.caller.signal)])
            assert.equal((await x.c.start({ purpose: 'x', deadline: performance.now() + 1000, signal })).ok, false);
        for (const deadline of [performance.now() - 1, performance.now() + 30001])
            assert.equal((await x.c.start({ purpose: 'x', deadline, signal: x.caller.signal })).ok, false);
        assert.equal(p.commands.length, 0);
        await x.c.close();
    }
    finally {
        await p.close();
    }
});
test('native handshake exact command cache silence live null recovery and ordered events', async () => {
    const p = await peer(), x = connector(p.endpoint);
    try {
        assert.equal((await x.start()).ok, true);
        assert.deepEqual(p.commands, ['{"message_id":"listen-1","command":"start_listening","args":{}}']);
        assert.equal(x.positions.length, 0);
        p.send(position('0'));
        await until(() => x.positions.length === 1);
        const original = x.positions[0];
        p.send(press);
        await until(() => x.events.length === 1);
        p.send(press);
        p.send(press.replace('9007199254740993', '9007199254740992'));
        p.send(position('null'));
        await until(() => x.positions.length === 2);
        assert.equal(x.positions[1].value, null);
        assert.equal(x.c.status().phase, 'ready');
        assert.equal(x.unavailable.length, 0);
        p.send(position('1'));
        await until(() => x.positions.length === 3);
        assert.equal(x.positions[2].localSequence, 4);
        assert.equal(original.receivedAt, x.positions[0].receivedAt);
        assert.equal(x.events.length, 1);
        p.send('{"event":"attribute_updated","data":[7,"1/59/65532",2]}');
        p.send('{"event":"node_updated","data":' + node + '}');
        p.ping('echo');
        await until(() => p.pongs.length === 1);
        assert.equal(p.pongs[0]!.toString(), 'echo');
        assert.equal(x.positions.length, 3);
        p.send('{"event":"node_removed","data":7}');
        await until(() => x.unavailable.length === 1);
        await x.c.stop();
        assert.equal(x.c.status().rawSockets, 0);
        assert.equal(x.c.status().rawWrites, 0);
        assert.equal(x.c.status().timers, 0);
        assert.equal(x.c.status().waiters, 0);
        assert.equal((await x.start()).ok, true);
        p.send(position('1'));
        await until(() => x.positions.length === 4);
        assert.equal(x.positions[3].localSequence, 5);
        await x.c.close();
    }
    finally {
        await Promise.allSettled([x.c.close(), p.close()]);
    }
});
test('malformed opening native errors and incompatible live metadata retire', async () => {
    for (const mode of ['wrong', 'error']) {
        const p = await peer(mode), x = connector(p.endpoint);
        try {
            assert.equal((await x.start()).ok, false);
            await x.c.close();
            assert.equal(x.c.status().rawSockets, 0);
            assert.equal(x.c.status().waiters, 0);
        }
        finally {
            await p.close();
        }
    }
    const p = await peer(), x = connector(p.endpoint);
    try {
        await x.start();
        p.send('{"event":"attribute_updated","data":[7,"1/59/0",3]}');
        await until(() => x.unavailable.length === 1);
        await x.c.close();
        assert.equal(x.positions.length, 0);
    }
    finally {
        await p.close();
    }
});
test('callback revocation fences queued observations and reentrant start', async () => {
    const p = await peer();
    let reentry: ReturnType<ReturnType<typeof create>['start']> | undefined;
    const x = connector(p.endpoint, { onPosition: () => { x.grant.abort(); reentry = x.start(); } });
    try {
        await x.start();
        p.send(position('1'));
        p.send(press);
        await until(() => x.unavailable.length === 1);
        assert.ok(reentry);
        assert.equal((await reentry).ok, false);
        await x.c.close();
        assert.equal(x.events.length, 0);
    }
    finally {
        await p.close();
    }
});
test('native ping quota closes without application delivery', async () => { const p = await peer(), x = connector(p.endpoint); try {
    await x.start();
    for (let i = 0; i < 65; i++)
        p.ping('q');
    await until(() => x.unavailable.length === 1);
    await x.c.close();
    assert.equal(x.events.length, 0);
    assert.equal(x.c.status().rawWrites, 0);
}
finally {
    await p.close();
} });
test('pre-upgrade genuine TCP close remains owned independently', async (t) => {
    const accepted = new Set<import('node:net').Socket>();
    const server = createServer(s => { accepted.add(s); s.on('error', () => { }); s.once('close', () => accepted.delete(s)); });
    let x: ReturnType<typeof connector> | undefined, finishing = false;
    let starting: ReturnType<ReturnType<typeof connector>['start']> | undefined, stopping: Promise<void> | undefined;
    let release: () => void = () => { };
    const original = WebSocket.prototype.emit;
    try {
        await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
        const address = server.address();
        assert.ok(address && typeof address === 'object');
        const selected = x = connector('ws://127.0.0.1:' + address.port + '/ws');
        t.mock.method(WebSocket.prototype, 'emit', function (this: NativeWebSocket, name: string, ...args: unknown[]) { if (name === 'close') {
            let delivered = false;
            const deliver = () => { if (!delivered) { delivered = true; Reflect.apply(original, this, [name, ...args]); } };
            if (finishing) deliver(); else release = deliver;
            return true;
        } return Reflect.apply(original, this, [name, ...args]); });
        starting = selected.start();
        await until(() => selected.c.status().rawSockets === 1);
        stopping = selected.c.stop();
        await until(() => selected.c.status().rawTcpSockets === 0);
        assert.equal(selected.c.status().phase, 'retiring');
        assert.equal(selected.c.status().rawWsSockets, 1);
        assert.equal((await selected.start()).ok, false);
        release();
        await stopping;
        await starting;
        assert.equal(selected.c.status().rawSockets, 0);
    } finally {
        finishing = true; release();
        const closing = x?.c.close();
        for (const socket of accepted) socket.destroy();
        await Promise.allSettled([starting, stopping, closing]);
        t.mock.restoreAll();
        if (server.listening) await new Promise<void>(r => server.close(() => r()));
    }
});
test('private numeric tokens cannot be impersonated by native JSON objects', () => { assert.throws(() => decode(bytes(press.replace('"node_id":7', '"node_id":{"numeric":true,"lexeme":"7"}')))); });
test('wrapped server-info cannot act as the initial unwrapped handshake', async () => { const p = await peer('wrapped'), x = connector(p.endpoint); try {
    assert.equal((await x.start()).ok, false);
    assert.equal(p.commands.length, 0);
    await x.c.close();
}
finally {
    await p.close();
} });
test('authorizer cannot renew the original caller deadline through a mutable input', async () => { const p = await peer(), caller = new AbortController(); const input = { purpose: 'original', deadline: performance.now() + 1000, signal: caller.signal }; const x = connector(p.endpoint, { authorize: r => { input.deadline += 10000; return { request: r, signal: new AbortController().signal, expiresAt: r.deadline + 1000 }; } }); try {
    assert.equal((await x.c.start(input)).ok, false);
    assert.equal(p.commands.length, 0);
    await x.c.close();
}
finally {
    await p.close();
} });
test('every issued application and pong callback stays owned after independent close', async (t) => {
    const p = await peer(), x = connector(p.endpoint);
    const originalSend = WebSocket.prototype.send, originalPong = WebSocket.prototype.pong;
    let application: ((e?: Error) => void) | undefined, pong: ((e?: Error) => void) | undefined;
    t.mock.method(WebSocket.prototype, 'send', function (this: NativeWebSocket, data: Parameters<NativeWebSocket['send']>[0], ...args: unknown[]) { if (this.url === p.endpoint) {
        const cb = args.at(-1) as (e?: Error) => void;
        application = cb;
        return Reflect.apply(originalSend, this, [data, () => { }]);
    } return Reflect.apply(originalSend, this, [data, ...args]); });
    t.mock.method(WebSocket.prototype, 'pong', function (this: NativeWebSocket, data: Parameters<NativeWebSocket['pong']>[0], ...args: unknown[]) { if (this.url === p.endpoint) {
        pong = args.at(-1) as (e?: Error) => void;
        return Reflect.apply(originalPong, this, [data, undefined, () => { }]);
    } return Reflect.apply(originalPong, this, [data, ...args]); });
    try {
        const opening = x.start();
        await until(() => p.commands.length === 1);
        p.ping('owned');
        await until(() => !!pong);
        assert.equal(x.c.status().rawWrites, 2);
        const stopping = x.c.stop();
        await until(() => x.c.status().rawSockets === 0);
        assert.equal(x.c.status().phase, 'retiring');
        assert.equal(x.c.status().rawWrites, 2);
        application!(new Error('authentic issued application callback rejection'));
        assert.equal((await opening).ok, false);
        await until(() => x.c.status().rawWrites === 1);
        assert.equal(x.c.status().phase, 'retiring');
        assert.equal((await x.start()).ok, false);
        pong!(new Error('authentic issued pong callback rejection'));
        await assert.rejects(stopping, /settlement failed/);
        assert.equal(x.c.status().rawWrites, 0);
        assert.equal(x.c.status().rawSockets, 0);
        assert.equal(x.c.status().phase, 'idle');
    }
    finally {
        t.mock.restoreAll();
        await Promise.allSettled([x.c.close(), p.close()]);
    }
});
test('genuine owner caller and grant abort withdraw and prevent late observations', async () => { for (const field of ['owner', 'caller', 'grant'] as const) {
    const p = await peer(), x = connector(p.endpoint);
    try {
        await x.start();
        x[field].abort();
        assert.equal(x.c.status().phase, 'retiring');
        p.send(position('1'));
        p.send(press);
        await x.c.stop();
        assert.equal(x.positions.length, 0);
        assert.equal(x.events.length, 0);
        assert.equal(x.unavailable.length, 1);
        assert.equal(x.c.status().rawSockets, 0);
    }
    finally {
        await Promise.allSettled([x.c.close(), p.close()]);
    }
} });
test('pre-ready message quota is charged without publishing buffered positions', async () => { const p = await peer('hold'), x = connector(p.endpoint); try {
    const starting = x.start();
    await until(() => p.commands.length === 1);
    for (let i = 0; i < 256; i++)
        p.send(position('1'));
    assert.equal((await starting).ok, false);
    await x.c.close();
    assert.equal(x.positions.length, 0);
    assert.equal(x.c.status().messages, 257);
    assert.equal(x.c.status().rawSockets, 0);
}
finally {
    await p.close();
} });
test('original session deadline and callback throw retire exact native ownership', async () => { const p = await peer(), x = connector(p.endpoint, { onPosition: () => { throw new Error('callback failure'); } }); try {
    await x.start();
    p.send(position('1'));
    await until(() => x.unavailable.length === 1);
    await x.c.close();
    assert.equal(x.c.status().rawSockets, 0);
}
finally {
    await p.close();
} const q = await peer(), y = connector(q.endpoint); try {
    assert.equal((await y.c.start({ purpose: 'short original', signal: y.caller.signal, deadline: performance.now() + 40 })).ok, true);
    await until(() => y.unavailable.length === 1);
    await y.c.close();
    assert.equal(y.c.status().rawSockets, 0);
}
finally {
    await q.close();
} });
test('actual child exit cannot replace held native child close even on failure', async (t) => {
    const { ChildProcess } = await import('node:child_process'), { writeFile } = await import('node:fs/promises'), { runMatterChild } = await import('../../../tools/qa-matter-ws-switch.mjs');
    const directory = await ownedScratch(t, '101-matter-child-proof-'), original = ChildProcess.prototype.emit;
    for (const failure of [false, true]) {
        let release: (() => void) | undefined, settled = false;
        const runner = directory + '/' + (failure ? 'failed' : 'success') + '.mjs';
        await writeFile(runner, failure ? 'process.exitCode=1;' : 'console.log(JSON.stringify({native:true}));');
        t.mock.method(ChildProcess.prototype, 'emit', function (this: import('node:child_process').ChildProcess, name: string, ...args: unknown[]) { if (name === 'close') {
            release = () => Reflect.apply(original, this, [name, ...args]);
            return true;
        } return Reflect.apply(original, this, [name, ...args]); });
        const running = runMatterChild(runner);
        void running.then(() => { settled = true; }, () => { settled = true; });
        try {
            await until(() => !!release);
            assert.equal(settled, false);
            release!();
            if (failure)
                await assert.rejects(running);
            else
                assert.equal((await running).actualChildClose, true);
            assert.equal(settled, true);
        } finally {
            t.mock.restoreAll();
            release?.();
            await Promise.allSettled([running]);
        }
    }
});
test('held genuine pre-upgrade TCP close survives observation timeout and blocks restart', async (t) => {
    const { Socket } = await import('node:net');
    const peers = new Set<import('node:net').Socket>(), server = createServer(s => { peers.add(s); s.on('error', () => { }); s.on('close', () => peers.delete(s)); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const original = Socket.prototype.emit;
    const native = new Set<import('node:net').Socket>();
    let release: (() => void) | undefined;
    t.mock.method(Socket.prototype, 'emit', function (this: import('node:net').Socket, name: string, ...args: unknown[]) { if (name === 'connect' && this.remotePort === address.port)
        native.add(this); if (name === 'close' && native.has(this)) {
        release = () => Reflect.apply(original, this, [name, ...args]);
        return true;
    } return Reflect.apply(original, this, [name, ...args]); });
    const x = connector('ws://127.0.0.1:' + address.port + '/ws');
    try {
        const opening = x.start();
        await until(() => native.size === 1);
        const stopping = x.c.stop();
        await until(() => !!release);
        assert.equal(x.c.status().rawTcpSockets, 1);
        await assert.rejects(stopping, /close unconfirmed/);
        assert.equal(x.c.status().phase, 'retiring');
        assert.equal(x.c.status().rawTcpSockets, 1);
        assert.equal((await x.start()).ok, false);
        release!();
        await opening;
        await until(() => x.c.status().phase === 'idle');
        assert.equal(x.c.status().rawSockets, 0);
    }
    finally {
        t.mock.restoreAll();
        await x.c.close();
        for (const p of peers)
            p.destroy();
        await new Promise<void>(r => server.close(() => r()));
    }
});
test('validated fabric uint64 claims remain immutable inert provider provenance', async () => { const p = await peer(), x = connector(p.endpoint); try {
    await x.start();
    p.send(position('1'));
    await until(() => x.positions.length === 1);
    assert.equal(x.positions[0]!.fabricId, '9007199254740993');
    assert.equal(x.positions[0]!.compressedFabricId, '18446744073709551615');
    assert.ok(Object.isFrozen(x.positions[0]));
    await x.c.close();
}
finally {
    await p.close();
} });
test('uint64 parsing never converts original string tokens before semantic validation', t => { const nativeNumber = Number; const replacement = t.mock.method(globalThis, 'Number', (value: unknown) => { assert.notEqual(typeof value, 'string', 'raw numeric lexeme converted before its field check'); return nativeNumber(value); }); Object.defineProperty(replacement, 'isFinite', { value: nativeNumber.isFinite }); try {
    const d = decode(bytes(press));
    assert.equal(d.kind, 'press');
}
finally {
    t.mock.restoreAll();
} });
test('idle Stop and Close never invent an additional session withdrawal', async () => { const p = await peer(), x = connector(p.endpoint); try {
    await x.c.stop();
    assert.equal(x.unavailable.length, 0);
    assert.equal((await x.start()).ok, true);
    p.send('{"event":"node_removed","data":7}');
    await until(() => x.unavailable.length === 1);
    await x.c.stop();
    await x.c.close();
    assert.equal(x.unavailable.length, 1);
}
finally {
    await p.close();
} });
test('native binary text content retires without a property or event',async()=>{const p=await peer(),x=connector(p.endpoint);try{await x.start();p.sendBinary(position('1'));await until(()=>x.unavailable.length===1);await x.c.close();assert.equal(x.positions.length,0);assert.equal(x.events.length,0);}finally{await p.close();}});
test('selected native nullable offline event shape and attribute limits are strict',()=>{assert.equal(decode(bytes(inventory.replace('"available":true','"available":false'))).kind,'offline');for(const payload of [press.replace('"newPosition":1','"newPosition":2'),press.replace('"priority":1','"priority":0'),press.replace('"timestamp_type":1','"timestamp_type":3'),press.replace('"data":{"newPosition":1}','"data":null'),position('2'),inventory.replace('"1/59/65532":2',Array.from({length:65},(_,i)=>'"1/60/'+i+'":0').join(',')),inventory.replace('"interview_version":6','"interview_version":6.0'),'{"event":"invented","data":{}}'])assert.throws(()=>decode(bytes(payload)));});
test('callback Stop Close and unavailable throws retain the native retirement fence',async()=>{for(const action of ['stop','close'] as const){const p=await peer();let pending:Promise<void>|undefined;const x=connector(p.endpoint,{onPosition:()=>{pending=x.c[action]();},onUnavailable:()=>{throw new Error('unavailable callout threw');}});try{await x.start();p.send(position('1'));p.send(press);await until(()=>!!pending);await pending;assert.equal(x.events.length,0);assert.equal(x.c.status().rawSockets,0);assert.ok(x.c.status().failures.some(s=>s.includes('unavailable callout threw')));}finally{await Promise.allSettled([x.c.close(),p.close()]);}}});
test('fabric stream byte quota is charged before selected readiness',async()=>{const p=await peer('hold'),x=connector(p.endpoint);try{const starting=x.start();await until(()=>p.commands.length===1);const payload=press.replace('"node_id":7','"node_id":9007199254740992').replace('"data":{"newPosition":1}', '"data":['+Array(32).fill('"'+'a'.repeat(1000)+'"').join(',')+']');assert.ok(Buffer.byteLength(payload)<32768);for(let i=0;i<34;i++)p.send(payload);assert.equal((await starting).ok,false);await x.c.close();assert.ok(x.c.status().receivedBytes>1048576);assert.ok(x.c.status().messages<256);assert.equal(x.positions.length,0);assert.equal(x.events.length,0);}finally{await p.close();}});
test('eight lifetime attempts never grant a ninth fabric stream',async()=>{const p=await peer();let authorizations=0;const x=connector(p.endpoint,{authorize:()=>{authorizations++;return undefined;}});try{for(let i=0;i<8;i++)assert.equal((await x.start()).ok,false);assert.equal((await x.start()).ok,false);assert.equal(authorizations,8);assert.equal(p.commands.length,0);await x.c.close();}finally{await p.close();}});
test('constructor endpoint accessor cannot replace the enrolled loopback endpoint',()=>{let reads=0;const options:Options={endpoint:'ws://127.0.0.1:9/ws',scope,ownerSignal:new AbortController().signal,authorize:()=>undefined,onPosition:()=>{},onPress:()=>{},onUnavailable:()=>{}};Object.defineProperty(options,'endpoint',{enumerable:true,get(){return ++reads<3?'ws://127.0.0.1:9/ws':'ws://example.com:80/ws';}});assert.throws(()=>create(options));assert.equal(reads,0);});
test('approval expiry accessor cannot extend the original standing deadline',async()=>{const p=await peer();let reads=0;const x=connector(p.endpoint,{authorize:r=>({request:r,signal:new AbortController().signal,get expiresAt(){return ++reads<4?r.deadline:r.deadline+10000;}})});try{assert.equal((await x.start()).ok,false);assert.equal(reads,0);assert.equal(p.commands.length,0);await x.c.close();}finally{await Promise.allSettled([x.c.close(),p.close()]);}});
test('synchronous native connect failure never leaves a fabricated WS reservation',async t=>{const {Socket}=await import('node:net');const x=connector('ws://127.0.0.1:9/ws');t.mock.method(Socket.prototype,'connect',()=>{throw new Error('native connect failed before OS effect');});try{assert.equal((await x.start()).ok,false);await until(()=>x.c.status().phase==='idle');assert.equal(x.c.status().rawWsSockets,0);assert.equal(x.c.status().rawTcpSockets,0);assert.equal(x.c.status().rawSockets,0);assert.equal(x.c.status().rawWrites,0);}finally{t.mock.restoreAll();await x.c.close();}});
test('synchronous native HTTP construction failure cannot release a fabricated WS owner',async t=>{const http=await import('node:http');const x=connector('ws://127.0.0.1:9/ws');t.mock.method(http.default,'request',()=>{throw new Error('native request construction failed');});try{assert.equal((await x.start()).ok,false);await until(()=>x.c.status().phase==='idle');assert.equal(x.c.status().rawWsSockets,0);assert.equal(x.c.status().rawSockets,0);}finally{t.mock.restoreAll();await x.c.close();}});
for(const failed of [false,true]) test('copied public caller joins actual IPC response write before advancing '+(failed?'including rejection':'success'),async t=>{
 const {ChildProcess}=await import('node:child_process'),{prepareMatterExecution}=await import('../../../tools/qa-matter-ws-switch.mjs');
 const directory=await ownedScratch(t,'101-matter-response-write-'),prepared=prepareMatterExecution({work:directory,installed:undefined});
 const {runMatterWsSwitchConsumer}=await import('node:url').then(({pathToFileURL})=>import(pathToFileURL((prepared.artifactPaths as Record<string,string>).caller!).href));
 const nativePrototype=ChildProcess.prototype as import('node:child_process').ChildProcess & {spawn:(...args:unknown[])=>unknown};const originalSpawn=nativePrototype.spawn;let release:((error?:Error)=>void)|undefined,response=false,advanced=false,held=false,retiring=false;const trace:string[]=[];let resolveReady!:()=>void;const ready=new Promise<void>(resolve=>{resolveReady=resolve;});
 t.mock.method(nativePrototype,'spawn',function(this:import('node:child_process').ChildProcess,...spawnArgs:unknown[]){const result=Reflect.apply(originalSpawn,this,spawnArgs);this.once('message',(message:unknown)=>{if((message as {kind?:string}).kind==='ready')resolveReady();});const original=this.send;
 this.send=function(this:import('node:child_process').ChildProcess,message:unknown,...args:unknown[]){const kind=(message as {kind?:string}).kind;if(kind==='position1'&&held)advanced=true;if(kind!=='position0'||held)return Reflect.apply(original,this,[message,...args]);held=true;const callback=args.at(-1) as (e?:Error|null)=>void;
 this.on('message',(m:unknown)=>{if((m as {id?:number}).id===(message as {id:number}).id){response=true;trace.push('authentic IPC response received');}});
 return Reflect.apply(original,this,[message,...args.slice(0,-1),(error?:Error|null)=>{let released=false;release=e=>{if(!released){released=true;callback(e??error);}};trace.push('actual write callback held');if(retiring)release();}]);} as typeof this.send;return result;});
 const running=runMatterWsSwitchConsumer();void running.catch(()=>{});
 // Producer readiness has its own unchanged 3000 ms bound. The write observation
 // window starts only after an authentic ready frame, and a failed caller wins.
 try{await Promise.race([ready,running.then(()=>assert.fail('caller completed before authentic producer readiness'))]);await until(()=>response&&!!release);await new Promise(r=>setTimeout(r,75));assert.equal(advanced,false,'ordinary caller advanced before native write settled');release!(failed?new Error('actual held response-write rejected'):undefined);if(failed)await assert.rejects(running);else assert.equal((await running).status,'pass');trace.push(failed?'write rejection remained failure after independent child joins':'actual caller returned after all child closes');}
 finally{retiring=true;release?.();await Promise.allSettled([running]);t.mock.restoreAll();t.diagnostic(JSON.stringify(trace));}
});
test('copied public caller joins close IPC write after authentic child close including rejection',async t=>{const {ChildProcess}=await import('node:child_process'),{prepareMatterExecution}=await import('../../../tools/qa-matter-ws-switch.mjs'),{pathToFileURL}=await import('node:url');const nativePrototype=ChildProcess.prototype as import('node:child_process').ChildProcess & {spawn:(...args:unknown[])=>unknown};const originalSpawn=nativePrototype.spawn;
 for(const failed of [false,true]){const directory=await ownedScratch(t,'101-matter-close-write-'),prepared=prepareMatterExecution({work:directory,installed:undefined}),{runMatterWsSwitchConsumer}=await import(pathToFileURL((prepared.artifactPaths as Record<string,string>).caller!).href);let held=false,closed=false,release:((error?:Error)=>void)|undefined,settled=false,retiring=false;const trace:string[]=[];
 t.mock.method(nativePrototype,'spawn',function(this:import('node:child_process').ChildProcess,...spawnArgs:unknown[]){const result=Reflect.apply(originalSpawn,this,spawnArgs);const original=this.send;this.send=function(this:import('node:child_process').ChildProcess,message:unknown,...args:unknown[]){if((message as {kind?:string}).kind!=='close'||held)return Reflect.apply(original,this,[message,...args]);held=true;const last=args.at(-1),callback=typeof last==='function'?last as (e?:Error|null)=>void:undefined;trace.push(callback?'caller supplied native close-write callback':'caller omitted native close-write callback');this.once('close',()=>{closed=true;trace.push('authentic child close observed');});return Reflect.apply(original,this,[message,...(callback?args.slice(0,-1):args),(error?:Error|null)=>{let released=false;release=e=>{if(!released){released=true;callback?.(e??error);}};trace.push('actual close-write callback held');if(retiring)release();}]);} as typeof this.send;return result;});const running=runMatterWsSwitchConsumer();void running.then(()=>{settled=true;},()=>{settled=true;});try{await until(()=>closed&&!!release);const completed=await Promise.race([running.then(()=>true,()=>true),new Promise<boolean>(r=>setTimeout(()=>r(false),500))]);assert.equal(completed,false,'ordinary caller settled before native close-write callback');assert.equal(settled,false);release!(failed?new Error('actual held close-write rejected'):undefined);if(failed)await assert.rejects(running);else assert.equal((await running).status,'pass');trace.push(failed?'write rejection remained failure':'caller returned only after write settled');}finally{retiring=true;release?.();await Promise.allSettled([running]);t.mock.restoreAll();t.diagnostic(JSON.stringify(trace));}
 }});
test('constructor scope and start require exact inert own data records without invoking traps',async()=>{
 const options:Options={endpoint:'ws://127.0.0.1:9/ws',scope,ownerSignal:new AbortController().signal,authorize:()=>undefined,onPosition:()=>{},onPress:()=>{},onUnavailable:()=>{}};let traps=0;
 for(const malformed of [Object.create(options),new Proxy(options,{ownKeys(){traps++;return [];}}),{...options,extra:true},{...options,scope:Object.create(scope)},{...options,scope:{...scope,extra:true}},{...options,scope:new Proxy(scope,{get(){traps++;return 'changed';}})}])assert.throws(()=>create(malformed as Options));
 const x=connector(options.endpoint,{authorize:()=>{traps++;return undefined;}});const input={purpose:'read',deadline:performance.now()+10000,signal:new AbortController().signal};const accessor={...input};Object.defineProperty(accessor,'signal',{get(){traps++;return input.signal;}});
 try{for(const malformed of [Object.create(input),new Proxy(input,{get(){traps++;return undefined;}}),{...input,extra:true},{purpose:'read',signal:input.signal},accessor])assert.equal((await x.c.start(malformed as typeof input)).ok,false);assert.equal(traps,0);assert.equal(x.c.status().attempts,0);}finally{await x.c.close();}
});
test('grant requires exact inert own data and original generation after authorizer callout',async()=>{
 let traps=0;for(const kind of ['inherited','proxy','extra','missing','accessor','stop'] as const){const x:ReturnType<typeof connector>=connector('ws://127.0.0.1:9/ws',{authorize:r=>{const grant={request:r,signal:new AbortController().signal,expiresAt:r.deadline};if(kind==='stop'){void x.c.stop();return grant;}if(kind==='inherited')return Object.create(grant) as typeof grant;if(kind==='proxy')return new Proxy(grant,{get(){traps++;return undefined;}});if(kind==='extra')return {...grant,extra:true};if(kind==='missing')return {request:r,signal:grant.signal} as typeof grant;Object.defineProperty(grant,'signal',{get(){traps++;return new AbortController().signal;}});return grant;}});try{assert.equal((await x.start()).ok,false);await x.c.close();assert.equal(x.c.status().rawSockets,0);}finally{await x.c.close();}}assert.equal(traps,0);
});
test('partially issued native TCP remains owned through held close after connect throws',async t=>{
 const {Socket}=await import('node:net');const native:{socket?:import('node:net').Socket}={};let release:(()=>void)|undefined;const originalEmit=Socket.prototype.emit;
 t.mock.method(Socket.prototype,'connect',function(this:import('node:net').Socket){native.socket=this;throw new Error('native connect threw before HTTP adopted TCP');});
 t.mock.method(Socket.prototype,'emit',function(this:import('node:net').Socket,name:string,...args:unknown[]){if(this===native.socket&&name==='close'){release=()=>Reflect.apply(originalEmit,this,[name,...args]);return true;}return Reflect.apply(originalEmit,this,[name,...args]);});
 const x=connector('ws://127.0.0.1:9/ws');try{assert.equal((await x.start()).ok,false);assert.equal(x.c.status().rawTcpSockets,1);await until(()=>!!release);assert.equal(x.c.status().phase,'retiring');assert.equal((await x.start()).ok,false);await assert.rejects(x.c.stop(),/close unconfirmed/);assert.equal(x.c.status().rawTcpSockets,1);release!();await until(()=>x.c.status().phase==='idle');assert.equal(x.c.status().rawSockets,0);}finally{native.socket?.destroy();release?.();t.mock.restoreAll();await x.c.close();}
});
for(const failed of [false,true]) test('actual copied producer joins native ready IPC callback before disconnect '+(failed?'rejection':'success'),async t=>{
 const {fork}=await import('node:child_process'),{writeFile}=await import('node:fs/promises'),{prepareMatterExecution}=await import('../../../tools/qa-matter-ws-switch.mjs'),{pathToFileURL}=await import('node:url');
 const directory=await ownedScratch(t,'101-matter-producer-write-'),prepared=prepareMatterExecution({work:directory,installed:undefined}),preload=directory+'/hold-native-send.mjs';
 await writeFile(preload,"const original=process.send.bind(process);let release,releaseRequested=false;process.send=function(message,...args){if(message.kind!=='ready')return original(message,...args);const last=args.at(-1),callback=typeof last==='function'?last:undefined;return original(message,...(callback?args.slice(0,-1):args),error=>{let released=false;release=()=>{if(!released){released=true;callback?.("+(failed?"new Error('held producer ready write rejected')":"error")+");}};if(releaseRequested)release();});};process.on('SIGUSR2',()=>{releaseRequested=true;release?.();});\n");
 const child=fork((prepared.artifactPaths as Record<string,string>).producer!,[],{execArgv:['--import',pathToFileURL(preload).href],env:{NODE_ENV:'production'},stdio:['ignore','ignore','pipe','ipc']});
 const exit=new Promise<{code:number|null,signal:NodeJS.Signals|null}>((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});void exit.catch(()=>{});
 const close=new Promise<void>(resolve=>child.once('close',()=>resolve()));let closed=false;void close.then(()=>{closed=true;});let ready=false;child.on('message',(m:unknown)=>{if((m as {kind?:string}).kind==='ready')ready=true;});const trace:string[]=[];
 try{await until(()=>ready);trace.push('authentic producer ready IPC received');await new Promise(r=>setTimeout(r,50));const write=new Promise<void>((resolve,reject)=>child.send({kind:'close'},error=>error?reject(error):resolve()));void write.catch(()=>{});await write;await new Promise(r=>setTimeout(r,200));assert.equal(closed,false,'producer disconnected before native ready write callback');child.kill('SIGUSR2');const result=await exit;await close;assert.equal(result.signal,null);assert.equal(result.code,failed?1:0);trace.push(failed?'native write rejection kept failing natural exit':'natural exit followed callback release');}
 finally{
  let cleanupWrite:Promise<void>|undefined;
  if(!closed){
   if(child.connected){
    cleanupWrite=new Promise<void>((resolve,reject)=>child.send({kind:'close'},error=>error?reject(error):resolve()));
    void cleanupWrite.catch(()=>{if(!closed)child.kill('SIGTERM');});
   }else child.kill('SIGTERM');
   child.kill('SIGUSR2');
  }
  await Promise.allSettled([exit,close,...(cleanupWrite?[cleanupWrite]:[])]);
  t.diagnostic(JSON.stringify(trace));
 }
});
test('callback thrown inert and hostile objects cannot escape retirement diagnostics',async()=>{
 let coerced=0;for(const thrown of [Object.create(null) as object,{toString(){coerced++;throw new Error('diagnostic coercion must never run');}},new Proxy(new Error('proxy failure'),{get(){coerced++;throw new Error('proxy trap');}})]){
 const p=await peer(),x=connector(p.endpoint,{onPosition:()=>{throw thrown;}});try{assert.equal((await x.start()).ok,true);p.send(position('1'));await until(()=>x.unavailable.length===1);await x.c.close();assert.equal(x.c.status().rawSockets,0);assert.equal(x.c.status().rawWrites,0);assert.equal(coerced,0);assert.ok(x.c.status().failures.every(s=>s.length<=256));}finally{await Promise.allSettled([x.c.close(),p.close()]);}
 }
});
test('native write thrown object always settles its issued ownership without coercion',async t=>{
 const p=await peer();let coerced=0;const original=WebSocket.prototype.send;t.mock.method(WebSocket.prototype,'send',function(this:NativeWebSocket,...args:unknown[]){if(args[0]==='{"message_id":"listen-1","command":"start_listening","args":{}}')throw {toString(){coerced++;throw new Error('forbidden coercion');}};return Reflect.apply(original,this,args);});
 const x=connector(p.endpoint);try{assert.equal((await x.start()).ok,false);await x.c.close();assert.equal(x.c.status().rawWrites,0);assert.equal(x.c.status().rawSockets,0);assert.equal(coerced,0);}finally{t.mock.restoreAll();await Promise.allSettled([x.c.close(),p.close()]);}
});
// Native post-handshake metadata uses the pinned producer's unwrapped info and event envelope.
for(const wrapped of [false,true]) for(const field of ['fabric_id','compressed_fabric_id'] as const) test('live changed fabric claims retire '+(wrapped?'wrapped update ':'repeated unwrapped info ')+field,async()=>{
 const changed=field==='fabric_id'?info.replace('"fabric_id":9007199254740993','"fabric_id":9007199254740992'):info.replace('"compressed_fabric_id":18446744073709551615','"compressed_fabric_id":18446744073709551614');
 const payload=wrapped?'{"event":"server_info_updated","data":'+changed+'}':changed;
 const p=await peer(),x=connector(p.endpoint);try{assert.equal((await x.start()).ok,true);p.send(position('0'));await until(()=>x.positions.length===1);const original=x.positions[0]!,before=x.c.status().messages;p.send(payload);p.send(position('1'));p.send(press);await until(()=>x.c.status().messages>before||x.unavailable.length>0);assert.deepEqual([...x.unavailable],['fabric-claim-changed']);await x.c.close();assert.equal(x.positions.length,1);assert.equal(x.events.length,0);assert.equal(x.positions[0],original);assert.equal(p.commands.length,1);assert.equal(x.c.status().rawSockets,0);assert.equal(x.c.status().rawWrites,0);}finally{await Promise.allSettled([x.c.close(),p.close()]);}
});
for(const wrapped of [false,true]) test('matching live fabric metadata remains consistency only '+(wrapped?'wrapped':'unwrapped'),async()=>{
 let grants=0;const p=await peer(),x=connector(p.endpoint,{authorize:r=>{grants++;return {request:r,signal:new AbortController().signal,expiresAt:r.deadline};}});try{assert.equal((await x.start()).ok,true);p.send(position('0'));await until(()=>x.positions.length===1);const original=x.positions[0]!,sequence=x.c.status().localSequence,before=x.c.status().messages;const matching=info.replace('"wifi_credentials_set":false','"wifi_credentials_set":true');p.send(wrapped?'{"event":"server_info_updated","data":'+matching+'}':matching);await until(()=>x.c.status().messages===before+1);assert.equal(x.c.status().phase,'ready');assert.equal(x.positions.length,1);assert.equal(x.events.length,0);assert.equal(x.positions[0],original);assert.equal(x.positions[0]!.receivedAt,original.receivedAt);assert.equal(x.c.status().localSequence,sequence);assert.equal(grants,1);assert.equal(p.commands.length,1);p.send(position('1'));await until(()=>x.positions.length===2);assert.equal(x.positions[1]!.fabricId,original.fabricId);assert.equal(x.positions[1]!.compressedFabricId,original.compressedFabricId);assert.deepEqual(x.unavailable,[]);await x.c.close();}finally{await Promise.allSettled([x.c.close(),p.close()]);}
});
