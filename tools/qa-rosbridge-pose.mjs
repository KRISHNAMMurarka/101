import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { runRosbridgePoseConsumer, runProtocolScenario, launchPeer, makeConnector, delay } from '../examples/rosbridge-pose/consumer.mjs';
assert.equal(process.argv.length, 3, 'Pass an owned receipt path');
const sources = ['packages/hub-server/src/rosbridge-pose-connector.ts', 'packages/hub-server/src/rosbridge-pose-connector.test.ts', 'examples/rosbridge-pose/peer.mjs', 'examples/rosbridge-pose/consumer.mjs', 'tools/qa-rosbridge-pose.mjs', 'tools/qa-installed-rosbridge-pose.mjs'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const initial = Object.fromEntries(await Promise.all(sources.map(async (p) => [p, hash(await readFile(new URL('../' + p, import.meta.url)))])));
const unhandled = [], capture = e => unhandled.push(String(e));
process.on('unhandledRejection', capture);
const scenarios = [];
let publicResult;
try {
    for (const mode of ['normal', 'no-first-pose', 'quiet-after-first', 'close-after-first', 'wrong-topic', 'wrong-frame', 'missing-field', 'duplicate-key', 'invalid-utf8', 'invalid-quaternion', 'oversized-message', 'total-byte-flood', 'binary-message', 'rosbridge-fragment', 'service-message']) {
        const r = await runProtocolScenario(mode);
        if (!['normal', 'quiet-after-first', 'close-after-first', 'total-byte-flood'].includes(mode))
            assert.equal(r.poseCount, 0);
        scenarios.push(r);
    }
    scenarios.push(await runProtocolScenario('slow-handshake', 'opening-expiry'));
    for (const action of ['caller-revoke', 'owner-revoke', 'grant-revoke'])
        scenarios.push(await runProtocolScenario('normal', action));
    for (const mode of ['repeated-stamp', 'backward-stamp']) {
        const peer = await launchPeer(mode), h = makeConnector(peer.endpoint);
        let report;
        try {
            assert.ok((await h.connect()).ok);
            await delay(125);
            assert.ok(h.poses.length >= 2);
            assert.equal(h.poses[0].rosStamp.sec, 1);
            assert.equal(h.poses.at(-1).rosStamp.sec, mode === 'backward-stamp' ? -1 : 1);
            assert.ok(h.poses.at(-1).timestamp > h.poses[0].timestamp);
            assert.equal(h.poses.at(-1).value.captureTimeKnown, false);
        }
        finally {
            await h.connector.close();
            report = await peer.close();
        }
        scenarios.push({ mode, poseCount: h.poses.length, status: h.connector.status(), peer: report });
    }
    // New connectors cannot retain prior native callbacks/snapshots; no automatic reconnect.
    const peer = await launchPeer(), a = makeConnector(peer.endpoint);
    try {
        assert.ok((await a.connect()).ok);
        await delay(20);
        a.caller.abort();
        await a.connector.close();
        const count = a.poses.length;
        await delay(60);
        assert.equal(a.poses.length, count);
        const b = makeConnector(peer.endpoint);
        assert.equal(b.poses.length, 0);
        assert.equal(b.connector.status().rawSockets, 0);
        await b.connector.close();
    }
    finally {
        await a.connector.close();
        await peer.close();
    }
    scenarios.push({ mode: 'fresh-connector-no-history-or-auto-reconnect' });
    // Expiry is enforced while the stream remains active, independent of owner/grant revocation.
    const expiryPeer = await launchPeer(), exp = makeConnector(expiryPeer.endpoint);
    try {
        assert.ok((await exp.connect(performance.now() + 90)).ok);
        await delay(115);
        assert.notEqual(exp.connector.status().phase, 'subscribed');
    }
    finally {
        await exp.connector.close();
        await expiryPeer.close();
    }
    scenarios.push({ mode: 'original-standing-deadline', status: exp.connector.status() });
    publicResult = await runRosbridgePoseConsumer();
    await delay(25);
    assert.deepEqual(unhandled, []);
}
finally {
    process.off('unhandledRejection', capture);
}
const final = Object.fromEntries(await Promise.all(sources.map(async (p) => [p, hash(await readFile(new URL('../' + p, import.meta.url)))])));
assert.deepEqual(final, initial);
const receipt = { schemaVersion: 1, status: 'pass', sourceSha256: initial, finalSourceSha256: final, protocol: 'rosbridge2.1.0 JSON WebSocket', softwareOnly: true, actualRos: false, actualDds: false, hardware: false, supportRows: [], qos: 'requested-unverified', captureFreshness: false, scenarios, protocolChecks: scenarios.length, unhandledRejections: unhandled, publicResult };
await writeFile(process.argv[2], JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ status: 'pass', protocolChecks: scenarios.length, receipt: process.argv[2] }));
