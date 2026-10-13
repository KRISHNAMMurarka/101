import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import { createRosbridgePoseConnector, ROSBRIDGE_POSE_PROFILE, ROSBRIDGE_POSE_VALUE_SCHEMA } from '../../packages/hub-server/src/rosbridge-pose-connector.ts';
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function launchPeer(mode = 'normal') {
    const child = fork(fileURLToPath(new URL('./peer.mjs', import.meta.url)), [mode], { execArgv: [], env: { NODE_ENV: 'production' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    // Install before readiness/callouts: exit does not settle owned stdio/IPC.
    const nativeClose = new Promise(resolve => child.once('close', resolve));
    let readyResolve, readyReject, closedResolve;
    let timer, stderrBytes = 0, report;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    void ready.catch(() => { });
    const closed = new Promise(resolve => { closedResolve = resolve; });
    const exit = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, sig) => {
            clearTimeout(timer);
            readyReject(Error('peer exited before ready'));
            if (code === 0)
                resolve();
            else
                reject(Error(`peer exit ${code ?? sig}`));
        });
    });
    void exit.catch(() => { });
    child.stderr.on('data', v => {
        stderrBytes += v.length;
        if (stderrBytes > 4096)
            child.kill('SIGKILL');
    });
    child.on('message', v => {
        if (JSON.stringify(v).length > 8192) {
            readyReject(Error('fixture IPC bounds'));
            child.kill('SIGKILL');
            return;
        }
        if (v?.type === 'ready') {
            clearTimeout(timer);
            assert.equal(v.softwareOnly, true);
            assert.equal(v.physical, false);
            readyResolve(v.endpoint);
        }
        else if (v?.type === 'closed') {
            report = v;
            closedResolve(v);
        }
    });
    timer = setTimeout(() => { readyReject(Error('peer startup deadline')); child.kill('SIGKILL'); }, 1500);
    let endpoint;
    try {
        endpoint = await ready;
    }
    catch (e) {
        await Promise.allSettled([exit, nativeClose]);
        throw e;
    }
    let retirement;
    return { endpoint, async close() {
            if (retirement)
                return retirement;
            retirement = (async () => {
                const kill = setTimeout(() => child.kill('SIGKILL'), 1500);
                try {
                    if (child.connected)
                        child.send({ type: 'stop' });
                    await exit;
                    assert.ok(report, 'child exit requires final native closure report');
                    await closed;
                    assert.equal(report.rawSockets, 0);
                    assert.equal(report.peers, 0);
                    assert.equal(report.timers, 0);
                    assert.equal(report.listener, false);
                    assert.equal(report.failure, null);
                    return report;
                }
                finally {
                    await nativeClose;
                    clearTimeout(kill);
                }
            })();
            return retirement;
        } };
}
export function makeConnector(endpoint, config = {}) {
    const owner = config.owner ?? new AbortController(), caller = config.caller ?? new AbortController(), grant = config.grant ?? new AbortController(), poses = [];
    const c = createRosbridgePoseConnector({ selection: { ...ROSBRIDGE_POSE_PROFILE, endpoint }, scope: { principalId: 'pose-owner', applicationId: 'pose-app', sessionId: 'pose-session' }, ownerSignal: owner.signal,
        authorizeSubscription: config.authorize ?? (request => ({ request, signal: grant.signal, expiresAt: performance.now() + 2000 })),
        onPose(p) { poses.push(p); config.onPose?.(p); }, onUnavailable(reason) { config.onUnavailable?.(reason); } });
    return { connector: c, owner, caller, grant, poses, connect(deadline = performance.now() + 1500) { return c.connect({ purpose: 'selected read-only pose', deadline, signal: caller.signal }); } };
}
export async function runProtocolScenario(mode, action) {
    const peer = await launchPeer(mode);
    let unavailableResolve;
    const unavailable = new Promise(resolve => { unavailableResolve = resolve; });
    const h = makeConnector(peer.endpoint, { onUnavailable: unavailableResolve });
    let started, report;
    try {
        started = await h.connect(action === 'opening-expiry' ? performance.now() + 25 : undefined);
        if (action === 'caller-revoke')
            h.caller.abort();
        else if (action === 'owner-revoke')
            h.owner.abort();
        else if (action === 'grant-revoke')
            h.grant.abort();
        if (mode === 'normal' && !action) {
            await delay(25);
            assert.ok(h.poses.length);
        }
        else
            await Promise.race([unavailable, delay(1000).then(() => { throw Error(`missing retirement ${mode}/${action}`); })]);
    }
    finally {
        await h.connector.close();
        report = await peer.close();
    }
    const status = h.connector.status();
    assert.equal(status.rawSockets, 0);
    assert.equal(status.rawWrites, 0);
    assert.equal(status.waiters, 0);
    assert.equal(status.timers, 0);
    return { mode, action: action ?? null, started, status, poseCount: h.poses.length, stamps: h.poses.map(p => p.rosStamp), peer: report };
}
export async function runRosbridgePoseConsumer() {
    const peer = await launchPeer();
    const poses = [];
    let firstResolve;
    const first = new Promise(resolve => { firstResolve = resolve; });
    let withdraw = () => { }, allow = false;
    const h = makeConnector(peer.endpoint, { authorize: request => allow ? { request, signal: h.grant.signal, expiresAt: performance.now() + 2000 } : undefined,
        onPose(p) {
            poses.push(p);
            if (poses.length === 1)
                firstResolve(p);
        }, onUnavailable() { withdraw(); } });
    const scope = { principalId: 'pose-owner', applicationId: 'pose-app', sessionId: 'pose-session' }, grants = new Set(), key = r => JSON.stringify([r.principalId, r.applicationId, r.sessionId, r.source.registrationId, r.sink.registrationId, r.sourceOperation, r.sinkOperation]);
    const runtime = createDeviceRuntime({ now: () => performance.now(), clockDomain: 'rosbridge-pose-gateway-monotonic', authorize: r => grants.has(key(r)) ? { expiresAt: performance.now() + 1000, maxAgeMs: 250, maxHz: 20 } : undefined });
    const device = parseDeviceDescriptor({ schemaVersion: 1, id: 'rosbridge-pose-fixture', label: 'ROS bridge software pose', revision: 1, adapter: { id: 'example:rosbridge-pose', version: '1.0.0' }, runtime: { platform: 'node-loopback-fixture' }, metadata: { softwareOnly: true, physical: false, actualRos: false }, capabilities: [
            { id: 'pose', semantic: 'example:raw-ros-pose/1', schemaVersion: 1, kind: 'property', value: ROSBRIDGE_POSE_VALUE_SCHEMA, delivery: { mode: 'latest', maxHz: 20, maxAgeMs: 250 }, permissions: ['read', 'subscribe'] },
            { id: 'viewer', semantic: 'example:raw-ros-pose/1', schemaVersion: 1, kind: 'property', value: ROSBRIDGE_POSE_VALUE_SCHEMA, delivery: { mode: 'latest', maxHz: 20, maxAgeMs: 250 }, permissions: ['write'], ownership: { mode: 'observe' } },
        ] });
    const source = runtime.registerSource({ device, capability: 'pose' }), delivered = [];
    const sink = runtime.registerSink({ device, capability: 'viewer', apply(observation, context) { assert.ok(context.isCurrent()); delivered.push(observation); }, release() { } });
    runtime.setReadiness(source, 'unavailable');
    runtime.setReadiness(sink, 'available');
    withdraw = () => runtime.setReadiness(source, 'unavailable');
    const route = () => runtime.route({ from: source, to: sink, ...scope, sourceOperation: 'read', sinkOperation: 'write', queueCapacity: 1, leaseMs: 1000 });
    let connection, receipt, peerReport, denied;
    try {
        assert.deepEqual(await h.connect(), { ok: false, reason: 'denied' });
        assert.equal(h.connector.status().rawSockets, 0);
        allow = true;
        assert.ok((await h.connect()).ok);
        receipt = await Promise.race([first, delay(500).then(() => { throw Error('missing valid pose'); })]);
        runtime.setReadiness(source, 'available');
        assert.ok(runtime.publish(source, receipt.value, { timestamp: receipt.timestamp, clockDomain: receipt.clockDomain, quality: 'valid', provenance: receipt.provenance }).ok);
        denied = route().start();
        assert.equal(denied.ok, false);
        grants.add(JSON.stringify([scope.principalId, scope.applicationId, scope.sessionId, source.id, sink.id, 'read', 'write']));
        connection = route();
        assert.ok(connection.start().ok);
        for (let i = 0; i < 3; i++) {
            runtime.flush();
            await delay(1);
        }
        assert.equal(delivered.length, 1);
        assert.deepEqual(delivered[0].value, receipt.value);
        assert.equal(delivered[0].timestamp, receipt.timestamp);
        assert.equal(delivered[0].provenance.frameId, 'map');
        assert.deepEqual(delivered[0].provenance.rosStamp, { sec: 1, nanosec: 250000000 });
        assert.equal(delivered[0].provenance.sourceClockMapping, null);
        assert.equal(delivered[0].provenance.sourceBasisEstablished, false);
        runtime.revoke(connection);
        connection = undefined;
        await delay(Math.max(0, receipt.timestamp + 255 - performance.now()));
        assert.equal(h.connector.status().phase, 'subscribed');
        assert.ok(poses.length >= 3);
        assert.deepEqual(route().start(), { ok: false, reason: 'stale' });
        h.caller.abort();
        assert.equal(h.connector.status().phase, 'retiring');
        assert.equal(route().start().ok, false);
    }
    finally {
        connection?.stop();
        await h.connector.close();
        peerReport = await peer.close();
        runtime.close();
    }
    assert.equal(peerReport.connections, 1);
    assert.deepEqual(peerReport.transcript.map(v => v.op), ['subscribe', 'unsubscribe']);
    return { softwareOnly: true, actualRos: false, actualDds: false, hardware: false, qos: 'requested-unverified', captureFreshness: false, publicDenied: denied, publicDelivered: delivered.length, immutable250msStale: true, receipt, status: h.connector.status(), peer: peerReport };
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
    console.log(JSON.stringify(await runRosbridgePoseConsumer()));
