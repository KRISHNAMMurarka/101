import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const { WebSocketServer } = createRequire(import.meta.url)('ws');
export function poseWire(sec = 1) { return { op: 'publish', topic: '/101/robot/pose', msg: { header: { stamp: { sec, nanosec: 250000000 }, frame_id: 'map' }, pose: { position: { x: 1.25, y: -2, z: 0.5 }, orientation: { x: 0, y: 0, z: 0, w: 1 } } } }; }
const QOS = { history: 'keep_last', depth: 1, reliability: 'best_effort', durability: 'volatile', deadline: 'infinite', lifespan: 'infinite' };
async function main(mode) {
    const modes = ['normal', 'quiet-after-first', 'no-first-pose', 'slow-handshake', 'close-after-first', 'wrong-topic', 'wrong-frame', 'missing-field', 'duplicate-key', 'invalid-utf8', 'invalid-quaternion', 'oversized-message', 'total-byte-flood', 'binary-message', 'rosbridge-fragment', 'service-message', 'repeated-stamp', 'backward-stamp'];
    if (!modes.includes(mode) || !process.send)
        throw Error('owned fixture mode required');
    const server = createServer((_req, res) => { res.writeHead(404); res.end(); }), wss = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });
    const sockets = new Set(), peers = new Set(), timers = new Set(), transcript = [];
    let connections = 0, publications = 0, receivedBytes = 0, sentBytes = 0, stopping = false, failure;
    const timeout = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); };
    server.on('connection', s => { sockets.add(s); s.on('error', () => { }); s.once('close', () => sockets.delete(s)); });
    server.on('upgrade', (req, socket, head) => {
        if (stopping || req.url !== '/rosbridge' || req.headers.host !== `127.0.0.1:${server.address().port}`) {
            socket.destroy();
            return;
        }
        const accept = () => {
            if (!stopping && !socket.destroyed)
                wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
        };
        if (mode === 'slow-handshake')
            timeout(accept, 150);
        else
            accept();
    });
    wss.on('connection', ws => {
        connections++;
        peers.add(ws);
        let subscription;
        ws.on('error', () => { });
        ws.once('close', () => peers.delete(ws));
        function send() {
            if (stopping || ws.readyState !== 1)
                return;
            const v = poseWire(mode === 'backward-stamp' && publications > 0 ? -1 : 1);
            if (mode === 'wrong-topic')
                v.topic = '/other';
            if (mode === 'wrong-frame')
                v.msg.header.frame_id = 'odom';
            if (mode === 'missing-field')
                delete v.msg.pose.position.z;
            if (mode === 'invalid-quaternion')
                v.msg.pose.orientation.w = 0;
            let raw = JSON.stringify(v), binary = false;
            if (mode === 'duplicate-key')
                raw = raw.replace('"sec":1', '"sec":1,"sec":2');
            if (mode === 'invalid-utf8')
                raw = Buffer.from([0xc3, 0x28]);
            if (mode === 'oversized-message')
                raw = ' '.repeat(2049);
            if (mode === 'binary-message')
                binary = true;
            if (mode === 'rosbridge-fragment')
                raw = JSON.stringify({ op: 'fragment', id: 'f', data: '{}', num: 0, total: 1 });
            if (mode === 'service-message')
                raw = JSON.stringify({ op: 'service_response', service: '/other', values: {}, result: true });
            if (mode === 'total-byte-flood')
                raw = ' '.repeat(1700) + raw;
            const count = mode === 'total-byte-flood' ? 40 : 1;
            for (let i = 0; i < count && ws.readyState === 1; i++) {
                sentBytes += Buffer.byteLength(raw);
                publications++;
                ws.send(raw, { binary }, () => { });
            }
            if (mode === 'close-after-first')
                timeout(() => ws.close(), 10);
            if (['normal', 'repeated-stamp', 'backward-stamp'].includes(mode) && publications < 100)
                timeout(send, 50);
        }
        ws.on('message', (bytes, binary) => {
            try {
                receivedBytes += bytes.length;
                if (binary || bytes.length > 2048 || receivedBytes > 65536 || transcript.length >= 2)
                    throw Error('client bounds');
                const v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
                if (v.op === 'subscribe') {
                    if (subscription || typeof v.id !== 'string' || !v.id || Object.keys(v).length !== 8 || v.topic !== '/101/robot/pose' || v.type !== 'geometry_msgs/msg/PoseStamped' || v.throttle_rate !== 50 || v.queue_length !== 1 || v.compression !== 'none' || JSON.stringify(v.qos) !== JSON.stringify(QOS))
                        throw Error('invalid subscribe');
                    subscription = v.id;
                    transcript.push(v);
                    if (mode !== 'no-first-pose')
                        send();
                }
                else if (v.op === 'unsubscribe') {
                    if (Object.keys(v).length !== 3 || v.id !== subscription || v.topic !== '/101/robot/pose')
                        throw Error('invalid unsubscribe');
                    transcript.push(v);
                }
                else
                    throw Error('read-only operation required');
            }
            catch {
                failure = 'fixture-rejected-client';
                ws.terminate();
            }
        });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    process.send({ type: 'ready', endpoint: `ws://127.0.0.1:${server.address().port}/rosbridge`, softwareOnly: true, physical: false });
    async function stop() {
        if (stopping)
            return;
        stopping = true;
        for (const id of timers)
            clearTimeout(id);
        timers.clear();
        for (const ws of peers)
            ws.terminate();
        for (const s of sockets)
            s.destroy();
        await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => wss.close(resolve))]);
        if (sockets.size)
            await Promise.all([...sockets].map(s => new Promise(resolve => s.once('close', resolve))));
        process.send({ type: 'closed', connections, publications, receivedBytes, sentBytes, transcript, rawSockets: sockets.size, peers: peers.size, timers: timers.size, listener: false, failure: failure ?? null }, () => process.disconnect());
    }
    process.on('message', v => {
        if (v?.type === 'stop' && Object.keys(v).length === 1)
            void stop();
        else {
            failure = 'invalid-fixture-control';
            void stop();
        }
    });
    process.on('disconnect', () => { void stop(); });
}
if (process.argv[1] === fileURLToPath(import.meta.url))
    await main(process.argv[2]);
