import assert from 'node:assert/strict';
import test from 'node:test';
import type { Socket as NativeTcpSocket } from 'node:net';
import { createRosbridgePoseConnector, decodeRosbridgePose, ROSBRIDGE_POSE_PROFILE } from './rosbridge-pose-connector.ts';
const sample = { op: 'publish', topic: '/101/robot/pose', msg: { header: { stamp: { sec: -1, nanosec: 999999999 }, frame_id: 'map' }, pose: { position: { x: 1.25, y: -2, z: 0.5 }, orientation: { x: 0, y: 0, z: 0, w: 1 } } } };
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const selection = { ...ROSBRIDGE_POSE_PROFILE, endpoint: 'ws://127.0.0.1:65534/rosbridge' };
test('private denial is inert and explicit caller signal is mandatory', async () => {
    const owner = new AbortController();
    let calls = 0;
    const c = createRosbridgePoseConnector({ selection, scope: { principalId: 'owner', applicationId: 'app', sessionId: 'session' }, ownerSignal: owner.signal, authorizeSubscription() { calls++; return undefined; }, onPose() { assert.fail(); }, onUnavailable() { } });
    assert.deepEqual(await c.connect({ purpose: 'read pose', deadline: performance.now() + 1000, signal: owner.signal }), { ok: false, reason: 'denied' });
    assert.equal(calls, 1);
    assert.equal(c.status().rawSockets, 0);
    await c.close();
    assert.equal(c.status().timers, 0);
});
test('native PoseStamped values and unmapped signed ROS time stay unchanged', () => {
    const d = decodeRosbridgePose(bytes(sample));
    assert.deepEqual(d.value.position, sample.msg.pose.position);
    assert.deepEqual(d.value.orientation, sample.msg.pose.orientation);
    assert.deepEqual(d.rosStamp, sample.msg.header.stamp);
    assert.equal(d.frameId, 'map');
    assert.equal(d.value.captureTimeKnown, false);
    for (const sec of [0, -2147483648, 2147483647]) {
        const v = structuredClone(sample);
        v.msg.header.stamp.sec = sec;
        assert.equal(decodeRosbridgePose(bytes(v)).rosStamp.sec, sec);
    }
});
for (const [label, mutate] of [
    ['wrong topic', (v: typeof sample) => { v.topic = '/other'; }], ['wrong frame', (v: typeof sample) => { v.msg.header.frame_id = 'odom'; }],
    ['nanosec', (v: typeof sample) => { v.msg.header.stamp.nanosec = 1000000000; }], ['sec', (v: typeof sample) => { v.msg.header.stamp.sec = 2147483648; }],
    ['position', (v: typeof sample) => { v.msg.pose.position.x = 101; }], ['zero quaternion', (v: typeof sample) => { v.msg.pose.orientation.w = 0; }],
] as const)
    test(label, () => { const v = structuredClone(sample); mutate(v); assert.throws(() => decodeRosbridgePose(bytes(v))); });
test('closed shapes, per-object duplicate keys, fatal UTF8 and early bounds', () => {
    const raw = JSON.stringify(sample);
    for (const s of [raw.replace('"sec":-1', '"sec":-1,"sec":0'), raw.replace('"x":1.25', '"x":1.25,"x":0'), raw + '{}', raw.replace('"op":"publish"', '"op":"publish","extra":1'), raw.replace('1.25', '1e999')])
        assert.throws(() => decodeRosbridgePose(new TextEncoder().encode(s)));
    assert.throws(() => decodeRosbridgePose(new Uint8Array([0xc3, 0x28])));
    assert.throws(() => decodeRosbridgePose(new Uint8Array(2049)));
});
test('published profile schema and raw provenance are deeply immutable', async () => {
    const { ROSBRIDGE_POSE_VALUE_SCHEMA } = await import('./rosbridge-pose-connector.ts');
    assert.equal(Object.isFrozen(ROSBRIDGE_POSE_VALUE_SCHEMA), true);
    if (ROSBRIDGE_POSE_VALUE_SCHEMA.type !== 'record')
        assert.fail();
    const position = ROSBRIDGE_POSE_VALUE_SCHEMA.fields.position;
    if (!position || position.type !== 'record')
        assert.fail();
    assert.equal(Object.isFrozen(position.fields.x), true);
    const { launchPeer, makeConnector, delay } = await import('../../../examples/rosbridge-pose/consumer.mjs');
    const peer = await launchPeer(), h = makeConnector(peer.endpoint);
    try {
        assert.ok((await h.connect()).ok);
        await delay(25);
        const p = h.poses[0];
        assert.ok(p);
        assert.equal(Object.isFrozen(p.provenance.rosStamp), true);
        assert.equal(Object.isFrozen(p.provenance.qos), true);
    }
    finally {
        await h.connector.close();
        await peer.close();
    }
});
const scope = { principalId: 'owner', applicationId: 'app', sessionId: 'session' };
for (const bad of ['fake', 'inherited', 'aborted', 'proxy', 'expired'] as const)
    test(`pre-callout ${bad} is inert`, async () => {
        const owner = new AbortController(), caller = new AbortController();
        let calls = 0;
        const c = createRosbridgePoseConnector({ selection, scope, ownerSignal: owner.signal, authorizeSubscription() { calls++; return undefined; }, onPose() { assert.fail(); }, onUnavailable() { } });
        if (bad === 'aborted')
            caller.abort();
        const input = { purpose: 'selected pose', deadline: bad === 'expired' ? performance.now() - 1 : performance.now() + 1000, signal: (bad === 'fake' ? { aborted: false } : bad === 'inherited' ? Object.create(caller.signal) : bad === 'proxy' ? new Proxy(caller.signal, {}) : caller.signal) as AbortSignal };
        try {
            if (bad === 'fake' || bad === 'inherited' || bad === 'proxy')
                await assert.rejects(c.connect(input));
            else
                assert.equal((await c.connect(input)).ok, false);
            assert.equal(calls, 0);
            assert.equal(c.status().rawSockets, 0);
        }
        finally {
            await c.close();
        }
    });
test('exact request is deeply frozen, replaced grant and authorizer reentry issue no socket', async () => {
    const owner = new AbortController();
    const c = createRosbridgePoseConnector({ selection, scope, ownerSignal: owner.signal, authorizeSubscription(r) { assert.equal(Object.isFrozen(r.qos), true); void c.close(); return { request: r, signal: owner.signal, expiresAt: performance.now() + 1000 }; }, onPose() { assert.fail(); }, onUnavailable() { } });
    assert.equal((await c.connect({ purpose: 'read', deadline: performance.now() + 1000, signal: owner.signal })).ok, false);
    await c.close();
    assert.equal(c.status().rawSockets, 0);
    const d = createRosbridgePoseConnector({ selection, scope, ownerSignal: owner.signal, authorizeSubscription: r => ({ request: { ...r }, signal: owner.signal, expiresAt: performance.now() + 1000 }), onPose() { assert.fail(); }, onUnavailable() { } });
    assert.equal((await d.connect({ purpose: 'read', deadline: performance.now() + 1000, signal: owner.signal })).ok, false);
    await d.close();
    assert.equal(d.status().rawSockets, 0);
});
test('denials consume bounded attempts without transport', async () => {
    const owner = new AbortController();
    let calls = 0;
    const c = createRosbridgePoseConnector({ selection, scope, ownerSignal: owner.signal, authorizeSubscription() { calls++; return undefined; }, onPose() { }, onUnavailable() { } });
    for (let i = 0; i < 9; i++)
        assert.equal((await c.connect({ purpose: 'read', deadline: performance.now() + 1000, signal: owner.signal })).ok, false);
    assert.equal(calls, 8);
    assert.equal(c.status().attempts, 8);
    await c.close();
});
test('held native subscribe/unsubscribe callbacks remain reserved after logical close', async () => {
    const { createRequire } = await import('node:module');
    const Ws = createRequire(import.meta.url)('ws').WebSocket;
    const original = Ws.prototype.send, held: (() => void)[] = [];
    const { launchPeer, makeConnector, delay } = await import('../../../examples/rosbridge-pose/consumer.mjs');
    const peer = await launchPeer(), h = makeConnector(peer.endpoint);
    Ws.prototype.send = function (data: unknown, options: unknown, callback: (error?: Error) => void) { return original.call(this, data, options, (error?: Error) => { held.push(() => callback(error)); }); };
    try {
        const opening = h.connect();
        await delay(30);
        assert.equal(h.connector.status().rawWrites, 1);
        let settled = false;
        const closing = h.connector.close().then(() => { settled = true; });
        await delay(10);
        assert.equal(settled, false);
        assert.equal(h.connector.status().rawWrites, 2);
        for (const release of held.splice(0))
            release();
        await closing;
        assert.equal((await opening).ok, false);
        assert.equal(h.connector.status().rawWrites, 0);
    }
    finally {
        Ws.prototype.send = original;
        for (const release of held.splice(0))
            release();
        await h.connector.close();
        await peer.close();
    }
});
test('retirement joins the actual native TCP close event', async () => {
    const { Socket } = await import('node:net');
    const { launchPeer, makeConnector, delay } = await import('../../../examples/rosbridge-pose/consumer.mjs');
    const peer = await launchPeer();
    const originalConnect = Socket.prototype.connect, originalEmit = Socket.prototype.emit;
    const clients = new WeakSet<NativeTcpSocket>();
    let release: (() => void) | undefined;
    Socket.prototype.connect = (function (this: NativeTcpSocket, ...args: unknown[]) { clients.add(this); return Reflect.apply(originalConnect, this, args); }) as NativeTcpSocket['connect'];
    Socket.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
        if (clients.has(this) && event === 'close') {
            release = () => { Reflect.apply(originalEmit, this, [event, ...args]); };
            return true;
        }
        return Reflect.apply(originalEmit, this, [event, ...args]);
    };
    const h = makeConnector(peer.endpoint);
    try {
        assert.ok((await h.connect()).ok);
        let settled = false;
        const closing = h.connector.close().then(() => { settled = true; });
        await delay(80);
        assert.ok(release);
        assert.equal(settled, false);
        assert.equal(h.connector.status().rawSockets, 1);
        release();
        release = undefined;
        await closing;
        assert.equal(h.connector.status().rawSockets, 0);
    }
    finally {
        Socket.prototype.connect = originalConnect;
        Socket.prototype.emit = originalEmit;
        release?.();
        await h.connector.close();
        await peer.close();
    }
});
test('synchronous native send fault owns opening/write settlement without orphan rejection', async () => {
    const { createRequire } = await import('node:module');
    const Ws = createRequire(import.meta.url)('ws').WebSocket, original = Ws.prototype.send;
    const errors: unknown[] = [], capture = (e: unknown) => errors.push(e);
    const { launchPeer, makeConnector, delay } = await import('../../../examples/rosbridge-pose/consumer.mjs');
    const peer = await launchPeer(), h = makeConnector(peer.endpoint);
    process.on('unhandledRejection', capture);
    Ws.prototype.send = function () { throw Error('actual send setup fault'); };
    try {
        assert.equal((await h.connect()).ok, false);
        await h.connector.close();
        await delay(20);
        assert.deepEqual(errors, []);
        assert.equal(h.connector.status().rawWrites, 0);
        assert.equal(h.connector.status().waiters, 0);
    }
    finally {
        Ws.prototype.send = original;
        process.off('unhandledRejection', capture);
        await h.connector.close();
        await peer.close();
    }
});
test('standing grant expiry and callback close reentry fence currently received samples', async () => {
    const { launchPeer, makeConnector, delay } = await import('../../../examples/rosbridge-pose/consumer.mjs');
    const peer = await launchPeer();
    const grant = new AbortController();
    const h = makeConnector(peer.endpoint, { grant, authorize: (request: import('./rosbridge-pose-connector.ts').RosbridgePoseRequest) => ({ request, signal: grant.signal, expiresAt: performance.now() + 75 }) });
    try {
        assert.ok((await h.connect()).ok);
        await delay(100);
        assert.notEqual(h.connector.status().phase, 'subscribed');
        await h.connector.close();
        const count = h.poses.length;
        await delay(60);
        assert.equal(h.poses.length, count);
    }
    finally {
        await h.connector.close();
        await peer.close();
    }
    const p = await launchPeer();
    const reentrant: ReturnType<typeof makeConnector> = makeConnector(p.endpoint, { onPose() { void reentrant.connector.close(); } });
    try {
        await reentrant.connect();
        await delay(50);
        await reentrant.connector.close();
        assert.equal(reentrant.poses.length, 1);
    }
    finally {
        await reentrant.connector.close();
        await p.close();
    }
});
test('inert construction rejects unsupported selection and accessor hooks without reading them', () => {
    const owner = new AbortController();
    let effects = 0;
    const options = { selection, scope, ownerSignal: owner.signal, authorizeSubscription() { effects++; return undefined; }, onPose() { }, onUnavailable() { } };
    for (const endpoint of ['ws://localhost:123/rosbridge', 'ws://127.0.0.1:01/rosbridge', 'ws://127.0.0.1:65536/rosbridge', 'ws://127.0.0.1:123/rosbridge?x=1', 'ws://user@127.0.0.1:123/rosbridge'])
        assert.throws(() => createRosbridgePoseConnector({ ...options, selection: { ...selection, endpoint } }));
    assert.throws(() => createRosbridgePoseConnector({ ...options, selection: { ...selection, interfaceType: 'geometry_msgs/msg/Pose' } as unknown as typeof selection }));
    assert.throws(() => createRosbridgePoseConnector({ ...options, selection: { ...selection, frameId: 'odom' } as unknown as typeof selection }));
    const accessor = Object.defineProperty({ ...options }, 'onPose', { enumerable: true, get() { effects++; return () => { }; } });
    assert.throws(() => createRosbridgePoseConnector(accessor));
    assert.equal(effects, 0);
});
test('near-unit quaternion signs/components are preserved without normalization', () => {
    const wire = structuredClone(sample);
    wire.msg.pose.orientation = { x: 0, y: 0, z: -0.7074602462329598, w: -0.7074602462329598 };
    assert.deepEqual(decodeRosbridgePose(bytes(wire)).value.orientation, wire.msg.pose.orientation);
});
test('failed native unsubscribe does not discard held subscribe callback settlement', async () => {
    const { createRequire } = await import('node:module');
    const Ws = createRequire(import.meta.url)('ws').WebSocket, original = Ws.prototype.send;
    let release: (() => void) | undefined;
    const { launchPeer, makeConnector, delay } = await import('../../../examples/rosbridge-pose/consumer.mjs');
    let peer: Awaited<ReturnType<typeof launchPeer>> | undefined;
    let h: ReturnType<typeof makeConnector> | undefined;
    try {
        peer = await launchPeer();
        h = makeConnector(peer.endpoint);
        Ws.prototype.send = function (raw: string, options: unknown, callback: (error?: Error) => void) {
            return original.call(this, raw, options, (error?: Error) => {
                if (JSON.parse(raw).op === 'subscribe')
                    release = () => callback(error);
                else
                    callback(error ?? Error('issued unsubscribe callback failure'));
            });
        };
        const opening = h.connect();
        await delay(30);
        assert.ok(release);
        assert.equal(h.connector.status().rawWrites, 1);
        let settled = false;
        const closing = h.connector.close().then(() => { settled = true; });
        await delay(80);
        assert.equal(h.connector.status().rawSockets, 0);
        assert.equal(h.connector.status().rawWrites, 1);
        assert.equal(settled, false, 'failed write must not discard another issued callback');
        release();
        release = undefined;
        await closing;
        assert.equal((await opening).ok, false);
        assert.equal(h.connector.status().rawWrites, 0);
    }
    finally {
        Ws.prototype.send = original;
        release?.();
        try {
            await h?.connector.close();
        }
        finally {
            await peer?.close();
        }
    }
});
async function waitForNativeClose(observed: Promise<void>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([observed, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(Error('native child close was not observed')), 1500);
        })]);
    }
    finally {
        clearTimeout(timer);
    }
}
test('peer cleanup joins native ChildProcess close after successful report and exit', async () => {
    const { ChildProcess } = await import('node:child_process');
    const original = ChildProcess.prototype.emit;
    let release: (() => void) | undefined;
    let closeObserved!: () => void;
    const observed = new Promise<void>(resolve => { closeObserved = resolve; });
    const { launchPeer } = await import('../../../examples/rosbridge-pose/consumer.mjs');
    let peer: Awaited<ReturnType<typeof launchPeer>> | undefined;
    try {
        peer = await launchPeer();
        ChildProcess.prototype.emit = function (event: string | symbol, ...args: unknown[]) { if (event === 'close') {
            release = () => { Reflect.apply(original, this, [event, ...args]); };
            closeObserved();
            return true;
        } return Reflect.apply(original, this, [event, ...args]); };
        let settled = false;
        const closing = peer.close().then(() => { settled = true; });
        await waitForNativeClose(observed);
        assert.ok(release, 'native close must be observed after actual child exit');
        assert.equal(settled, false, 'exit and IPC report must not replace native child close');
        release();
        release = undefined;
        await closing;
    }
    finally {
        ChildProcess.prototype.emit = original;
        release?.();
        await peer?.close();
    }
});
test('failed peer startup also waits for native child close without orphan rejection', async () => {
    const { ChildProcess } = await import('node:child_process');
    const original = ChildProcess.prototype.emit;
    let release: (() => void) | undefined;
    let closeObserved!: () => void;
    const observed = new Promise<void>(resolve => { closeObserved = resolve; });
    const errors: unknown[] = [], capture = (e: unknown) => errors.push(e);
    process.on('unhandledRejection', capture);
    ChildProcess.prototype.emit = function (event: string | symbol, ...args: unknown[]) { if (event === 'close') {
        release = () => { Reflect.apply(original, this, [event, ...args]); };
        closeObserved();
        return true;
    } return Reflect.apply(original, this, [event, ...args]); };
    const { launchPeer, delay } = await import('../../../examples/rosbridge-pose/consumer.mjs');
    let settled = false;
    const startup = launchPeer('invalid-fixture-mode').then(() => { assert.fail('invalid mode must fail'); }, () => { settled = true; });
    try {
        await waitForNativeClose(observed);
        assert.ok(release);
        assert.equal(settled, false, 'failed startup exit still owns native close');
        release();
        release = undefined;
        await startup;
        assert.equal(settled, true);
        await delay(10);
        assert.deepEqual(errors, []);
    }
    finally {
        ChildProcess.prototype.emit = original;
        release?.();
        await startup;
        process.off('unhandledRejection', capture);
    }
});
