import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import { createMatterWsSwitchConnector, MATTER_WS_SWITCH_POSITION_SCHEMA, MATTER_WS_SWITCH_EVENT_SCHEMA } from '../../packages/hub-server/src/matter-ws-switch.ts';
function producer() {
    const child = fork(new URL('./producer.mjs', import.meta.url), [], { execArgv: [], env: { NODE_ENV: 'production' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '', next = 0, closing;
    const writes = [];
    function issue(message) {
        let resolve, reject;
        const write = new Promise((res, rej) => { resolve = res; reject = rej; });
        writes.push(write);
        void write.catch(() => {});
        try { child.send(message, error => error ? reject(error) : resolve()); }
        catch (error) { reject(error); }
        return write;
    }
    child.stderr.on('data', b => { stderr = (stderr + b).slice(-4096); });
    const exit = new Promise((res, rej) => { child.once('error', rej); child.once('exit', (code, signal) => res({ code, signal })); });
    const closed = new Promise(res => child.once('close', res));
    void exit.catch(() => { });
    async function response(id, message) {
        const received = new Promise((res, rej) => {
            let done = false;
            const finish = (error, value) => { if (done)
                return; done = true; clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); child.off('error', onError); if (error)
                rej(error);
            else
                res(value); };
            const onMessage = m => { if (id === 0 && m?.kind === 'ready' || m?.id === id)
                finish(m.kind === 'error' ? new Error(m.reason) : undefined, m); };
            const onExit = () => finish(new Error('Producer premature exit ' + stderr)), onError = e => finish(e);
            const timer = setTimeout(() => finish(new Error('Producer response timeout ' + stderr)), 3000);
            child.on('message', onMessage);
            child.once('exit', onExit);
            child.once('error', onError);
        });
        const write = message ? issue(message) : Promise.resolve();
        const results = await Promise.allSettled([received, write]);
        const errors = results.filter(r => r.status === 'rejected').map(r => r.reason);
        if (errors.length) throw new AggregateError(errors, 'Producer response or native write failed');
        return results[0].value;
    }
    const ready = response(0);
    return { child, ready, request(kind) { return response(++next, { kind, id: next }); }, close() {
            return closing ??= (async () => {
                if (child.connected)
                    issue({ kind: 'close', id: ++next });
                let timer, escalation;
                try {
                    const result = await Promise.race([Promise.allSettled([exit, closed, ...writes]), new Promise((_, rej) => { timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) {
                            child.kill('SIGTERM');
                            escalation = setTimeout(() => { if (child.exitCode === null && child.signalCode === null)
                                child.kill('SIGKILL'); }, 1000);
                        } rej(new Error('Producer native close unconfirmed ' + stderr)); }, 3000); })]);
                    const errors = result.filter(r => r.status === 'rejected').map(r => r.reason);
                    if (errors.length)
                        throw new AggregateError(errors, 'Producer close failed');
                    const outcome = result[0].value;
                    assert.equal(outcome.code, 0, stderr);
                    assert.equal(outcome.signal, null, stderr);
                }
                finally {
                    if (timer)
                        clearTimeout(timer);
                    await Promise.allSettled([exit, closed, ...writes]);
                    if (escalation)
                        clearTimeout(escalation);
                }
            })();
        } };
}
const scope = Object.freeze({ principalId: 'owned-operator', applicationId: 'matter-reported-switch-example', sessionId: 'software-session' });
export async function runMatterWsSwitchConsumer() {
    const owner = new AbortController(), grant = new AbortController(), caller = new AbortController(), positions = [], events = [], positionReceipts = [], eventReceipts = [], wire = [], unavailable = [], publishResults = [];
    let positionAllowed = false, eventAllowed = false, positionRoute, eventRoute, p, c, recover = false, released = 0;
    const capability = (id, kind, value, sink) => ({ id, kind, value, semantic: 'example:matter/reported-' + kind, schemaVersion: 1, permissions: [sink ? 'write' : 'subscribe'], delivery: kind === 'event' ? { mode: 'reliable', maxAgeMs: 1000 } : { mode: 'latest', maxAgeMs: 1000, maxHz: 120 }, ...(sink ? { ownership: { mode: 'observe' } } : {}) });
    const device = parseDeviceDescriptor({ schemaVersion: 1, id: 'reported-software-matter-switch', label: 'Software reported switch', revision: 1, adapter: { id: 'example:matter-read-only', version: '1.0.0' }, runtime: { platform: 'node-loopback-software' }, capabilities: [capability('position', 'property', MATTER_WS_SWITCH_POSITION_SCHEMA, false), capability('position-view', 'property', MATTER_WS_SWITCH_POSITION_SCHEMA, true), capability('press', 'event', MATTER_WS_SWITCH_EVENT_SCHEMA, false), capability('press-input', 'event', MATTER_WS_SWITCH_EVENT_SCHEMA, true)] });
    const runtime = createDeviceRuntime({ clockDomain: 'matter-ws-gateway-monotonic', now: () => performance.now(), authorize: r => { if (r.principalId !== scope.principalId || r.applicationId !== scope.applicationId || r.sessionId !== scope.sessionId || r.sourceOperation !== 'subscribe' || r.sinkOperation !== 'write')
            return; const pos = r.source.registrationId === positionSource.id && r.sink.registrationId === positionSink.id && positionAllowed; const event = r.source.registrationId === eventSource.id && r.sink.registrationId === eventSink.id && eventAllowed; if (pos || event)
            return { expiresAt: performance.now() + 10000, maxAgeMs: 1000, maxHz: 120 }; } });
    const positionSource = runtime.registerSource({ device, capability: 'position' }), eventSource = runtime.registerSource({ device, capability: 'press' });
    const positionSink = runtime.registerSink({ device, capability: 'position-view', apply: (o, context) => { if (context.isCurrent() && !context.signal.aborted)
            positions.push(o); }, release() { released++; } }), eventSink = runtime.registerSink({ device, capability: 'press-input', apply: (o, context) => { if (context.isCurrent() && !context.signal.aborted)
            events.push(o); }, release() { } });
    for (const sink of [positionSink, eventSink])
        runtime.setReadiness(sink, 'available');
    const route = (source, sink) => runtime.route({ from: source, to: sink, ...scope });
    const provenance = r => ({ fabricId: r.fabricId, compressedFabricId: r.compressedFabricId, receivedAt: r.receivedAt, receiptClockId: r.receiptClockId, clockMapping: null, captureTimeKnown: false, physical: false, nodeId: '7', endpointId: 1, clusterId: 59, ...(r.kind === 'press' ? { eventNumber: r.eventNumber, nativeTimestamp: r.timestamp, nativeTimestampType: r.timestampType, timestampInterpretation: ['unverified-native-system-ms', 'unverified-native-posix-ms', 'server-posix-ms-fallback'][r.timestampType] } : {}) });
    const observationOptions = r => ({ sequence: r.localSequence, timestamp: r.receivedAt, clockDomain: r.receiptClockId, quality: 'valid', provenance: provenance(r) });
    const until = async (predicate, label) => { const end = performance.now() + 1500; while (!predicate()) {
        runtime.flush();
        assert.ok(performance.now() < end, JSON.stringify({ label, connector: c?.status(), positions: positions.length, events: events.length, publishResults }));
        await new Promise(res => setTimeout(res, 5));
    } };
    let result, error;
    try {
        p = producer();
        const ready = await p.ready;
        assert.equal(ready.pid, p.child.pid);
        c = createMatterWsSwitchConnector({ endpoint: ready.endpoint, ownerSignal: owner.signal, scope, authorize: r => { assert.equal(r.authority, 'matter-fabric-inventory-event-stream'); assert.ok(Object.isFrozen(r) && Object.isFrozen(r.scope)); return { request: r, signal: grant.signal, expiresAt: r.deadline }; }, onPosition: r => {
                positionReceipts.push(r);
                if (r.value === null) {
                    runtime.setReadiness(positionSource, 'unavailable');
                    return;
                }
                runtime.setReadiness(positionSource, 'available');
                if (recover) {
                    positionRoute = route(positionSource, positionSink);
                    assert.equal(positionRoute.start().ok, true);
                    recover = false;
                }
                const value = runtime.publish(positionSource, r.value, observationOptions(r));
                publishResults.push(value);
                assert.equal(value.ok, true);
                runtime.flush();
            }, onPress: r => { eventReceipts.push(r); const value = runtime.publish(eventSource, { newPosition: r.newPosition }, { ...observationOptions(r), operationId: String(r.localSequence), deadline: r.receivedAt + 1000 }); publishResults.push(value); if (eventAllowed)
                assert.equal(value.ok, true, JSON.stringify(value)); runtime.flush(); }, onUnavailable: r => { unavailable.push(r); runtime.setReadiness(positionSource, 'unavailable'); runtime.setReadiness(eventSource, 'unavailable'); } });
        assert.equal((await c.start({ purpose: 'Read selected reported software switch', deadline: performance.now() + 20000, signal: caller.signal })).ok, true);
        assert.equal(positionReceipts.length, 0);
        assert.equal(eventReceipts.length, 0);
        for (const source of [positionSource, eventSource])
            runtime.setReadiness(source, 'available');
        positionRoute = route(positionSource, positionSink);
        eventRoute = route(eventSource, eventSink);
        assert.equal(positionRoute.start().ok, false);
        assert.equal(eventRoute.start().ok, false);
        wire.push(await p.request('position0'));
        await until(() => positionReceipts.length === 1, 'denied property');
        assert.equal(positions.length, 0);
        positionAllowed = true;
        positionRoute = route(positionSource, positionSink);
        assert.equal(positionRoute.start().ok, true);
        for (const key of ['principalId', 'applicationId', 'sessionId'])
            assert.equal(runtime.route({ from: positionSource, to: positionSink, ...scope, [key]: 'other' }).start().ok, false);
        wire.push(await p.request('position1'));
        await until(() => positions.length === 1, 'property route');
        const original = positionReceipts.at(-1);
        assert.equal(positions[0].value, 1);
        wire.push(await p.request('press'));
        await until(() => eventReceipts.length === 1, 'separate event denial');
        assert.equal(events.length, 0);
        eventAllowed = true;
        eventRoute = route(eventSource, eventSink);
        assert.equal(eventRoute.start().ok, true);
        wire.push(await p.request('next'));
        await until(() => events.length === 1, 'event admission');
        assert.deepEqual(events[0].value, { newPosition: 1 });
        assert.equal(eventReceipts.at(-1).eventNumber, '9007199254740994');
        const count = c.status().messages;
        for (const kind of ['repeat', 'older', 'unrelated', 'cache', 'compatible'])
            wire.push(await p.request(kind));
        await until(() => c.status().messages >= count + 5, 'ignored native cache');
        assert.equal(events.length, 1);
        assert.equal(positions.length, 1);
        assert.equal(positionReceipts.at(-1).receivedAt, original.receivedAt);
        await new Promise(res => setTimeout(res, Math.max(1, original.receivedAt + 1010 - performance.now())));
        wire.push(await p.request('last'));
        await until(() => events.length === 2, 'event while property old');
        const stale = runtime.publish(positionSource, original.value, observationOptions(original));
        assert.equal(stale.ok, false);
        assert.equal(stale.reason, 'stale');
        assert.equal(positions[0].timestamp, original.receivedAt);
        const oldRoute = positionRoute;
        wire.push(await p.request('null'));
        await until(() => positionReceipts.at(-1).value === null, 'null withdrawal');
        assert.equal(c.status().phase, 'ready');
        assert.equal(oldRoute.status().state, 'closed');
        assert.equal(oldRoute.start().ok, false);
        assert.ok(released > 0);
        assert.equal(eventRoute.status().state, 'active');
        assert.equal(unavailable.length, 0);
        recover = true;
        wire.push(await p.request('position0'));
        await until(() => positions.length === 2, 'fresh ordinary route recovery');
        assert.equal(positions[1].value, 0);
        assert.notEqual(positionRoute, oldRoute);
        assert.equal(eventRoute.status().state, 'active');
        for (const o of [...positions, ...events]) {
            assert.equal(o.clockDomain, 'matter-ws-gateway-monotonic');
            assert.equal(o.timestamp, o.provenance.receivedAt);
            assert.equal(o.provenance.captureTimeKnown, false);
            assert.equal(o.provenance.physical, false);
            assert.equal(o.provenance.clockMapping, null);
        }
        assert.equal(events[0].provenance.nativeTimestamp, '18446744073709551615');
        assert.equal(events[0].provenance.nativeTimestampType, 0);
        assert.equal(events[1].provenance.nativeTimestampType, 2);
        wire.push(await p.request('offline'));
        await until(() => unavailable.length === 1, 'selected offline');
        assert.equal(positionRoute.status().state, 'closed');
        assert.equal(eventRoute.status().state, 'closed');
        await c.close();
        const final = c.status();
        for (const key of ['rawSockets', 'rawTcpSockets', 'rawWsSockets', 'rawWrites', 'timers', 'waiters'])
            assert.equal(final[key], 0);
        await p.close();
        p = undefined;
        result = { status: 'pass', checks: { deniedFirstOrdinaryRoutes: true, separateGrants: true, cacheNeverPublished: true, uint64Preserved: true, propertyStaleWhileEventsContinue: true, nullSourceOnlyWithdrawal: true, newAuthorizedPropertyRoute: true, eventRouteContinuous: true, offlineWithdrawn: true, actualChildClose: true, naturalExitCode: 0 }, positions: positions.map(o => ({ value: o.value, timestamp: o.timestamp, provenance: o.provenance })), events: events.map(o => ({ value: o.value, timestamp: o.timestamp, provenance: o.provenance })), wire, statusAfterStop: final };
    }
    catch (e) {
        error = new Error(JSON.stringify({ message: e.message, status: c?.status(), publishResults, wire }), { cause: e });
    }
    const cleanup = await Promise.allSettled([c?.close() ?? Promise.resolve(), p?.close() ?? Promise.resolve(), Promise.resolve().then(() => { positionRoute?.stop(); eventRoute?.stop(); runtime.close(); })]);
    const errors = [...(error ? [error] : []), ...cleanup.filter(r => r.status === 'rejected').map(r => r.reason)];
    if (errors.length)
        throw new AggregateError(errors, 'Matter caller failed');
    result.revocations = [];
    for (const kind of ['owner', 'caller', 'grant'])
        result.revocations.push(await revocationProof(device, kind));
    return Object.freeze(result);
}
async function revocationProof(device, kind) {
    const controls = { owner: new AbortController(), caller: new AbortController(), grant: new AbortController() }, readings = [], events = [];
    let unavailable = 0, c, p, routes = [];
    const runtime = createDeviceRuntime({ clockDomain: 'matter-ws-gateway-monotonic', now: () => performance.now(), authorize: r => r.principalId === scope.principalId && r.applicationId === scope.applicationId && r.sessionId === scope.sessionId ? { expiresAt: performance.now() + 10000, maxAgeMs: 1000, maxHz: 120 } : undefined });
    const positionSource = runtime.registerSource({ device, capability: 'position' }), eventSource = runtime.registerSource({ device, capability: 'press' }), positionSink = runtime.registerSink({ device, capability: 'position-view', apply: o => { readings.push(o); }, release() { } }), eventSink = runtime.registerSink({ device, capability: 'press-input', apply: o => { events.push(o); }, release() { } });
    const until = async (predicate) => { const end = performance.now() + 1500; while (!predicate()) {
        runtime.flush();
        assert.ok(performance.now() < end);
        await new Promise(r => setTimeout(r, 5));
    } };
    let proof, primary;
    try {
        p = producer();
        const ready = await p.ready;
        c = createMatterWsSwitchConnector({ endpoint: ready.endpoint, scope, ownerSignal: controls.owner.signal, authorize: r => ({ request: r, signal: controls.grant.signal, expiresAt: r.deadline }), onPosition: r => { assert.notEqual(r.value, null); assert.equal(runtime.publish(positionSource, r.value, { sequence: r.localSequence, timestamp: r.receivedAt, clockDomain: r.receiptClockId }).ok, true); runtime.flush(); }, onPress: r => { assert.equal(runtime.publish(eventSource, { newPosition: r.newPosition }, { sequence: r.localSequence, timestamp: r.receivedAt, clockDomain: r.receiptClockId, operationId: String(r.localSequence), deadline: r.receivedAt + 1000 }).ok, true); runtime.flush(); }, onUnavailable: () => { unavailable++; runtime.setReadiness(positionSource, 'unavailable'); runtime.setReadiness(eventSource, 'unavailable'); } });
        assert.equal((await c.start({ purpose: 'Bounded ' + kind + ' revocation proof', signal: controls.caller.signal, deadline: performance.now() + 10000 })).ok, true);
        for (const endpoint of [positionSource, eventSource, positionSink, eventSink])
            runtime.setReadiness(endpoint, 'available');
        routes = [runtime.route({ from: positionSource, to: positionSink, ...scope }), runtime.route({ from: eventSource, to: eventSink, ...scope })];
        for (const route of routes)
            assert.equal(route.start().ok, true);
        await p.request('position1');
        await p.request('press');
        await until(() => readings.length === 1 && events.length === 1);
        controls[kind].abort();
        assert.equal(unavailable, 1);
        for (const route of routes)
            assert.equal(route.status().state, 'closed');
        assert.equal(c.status().phase, 'retiring');
        await c.close();
        const before = c.status().localSequence;
        await p.request('position0');
        await p.request('next');
        assert.equal(c.status().localSequence, before);
        assert.equal(readings.length, 1);
        assert.equal(events.length, 1);
        for (const field of ['rawSockets', 'rawTcpSockets', 'rawWsSockets', 'rawWrites', 'timers', 'waiters'])
            assert.equal(c.status()[field], 0);
        await p.close();
        p = undefined;
        proof = { kind, immediateSdkWithdrawal: true, lateGenerationRejected: true, actualChildClose: true, naturalExitCode: 0, status: c.status() };
    }
    catch (e) {
        primary = e;
    }
    const results = await Promise.allSettled([c?.close() ?? Promise.resolve(), p?.close() ?? Promise.resolve(), Promise.resolve().then(() => { for (const route of routes)
            route.stop(); runtime.close(); })]);
    const errors = [...(primary ? [primary] : []), ...results.filter(r => r.status === 'rejected').map(r => r.reason)];
    if (errors.length)
        throw new AggregateError(errors, 'Matter ' + kind + ' revocation proof failed');
    return proof;
}
