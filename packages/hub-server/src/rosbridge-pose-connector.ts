import { parseSignalValue, parseValueSchema, snapshotJson } from '@101/connect';
import type { JsonObject, ValueSchema } from '@101/connect';
import { createRequire } from 'node:module';
import { connect as connectTcp } from 'node:net';
import type { Socket, TcpNetConnectOpts } from 'node:net';
import type { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
export const ROSBRIDGE_POSE_PROFILE = Object.freeze({ profileId: 'app:rosbridge2-pose-stamped-readonly/1', profileVersion: '1.0.0', topic: '/101/robot/pose', interfaceType: 'geometry_msgs/msg/PoseStamped', frameId: 'map' } as const);
export const ROSBRIDGE_POSE_LIMITS = Object.freeze({ messageBytes: 2048, totalBytes: 65536, messages: 128, attempts: 8, openingMs: 500, subscriptionMs: 30000, maxAgeMs: 250 });
const qos = Object.freeze({ history: 'keep_last', depth: 1, reliability: 'best_effort', durability: 'volatile', deadline: 'infinite', lifespan: 'infinite' } as const);
export const ROSBRIDGE_POSE_VALUE_SCHEMA: ValueSchema = parseValueSchema({ type: 'record', fields: {
        position: { type: 'record', fields: { x: { type: 'scalar', unit: 'm', min: -100, max: 100 }, y: { type: 'scalar', unit: 'm', min: -100, max: 100 }, z: { type: 'scalar', unit: 'm', min: -100, max: 100 } } },
        orientation: { type: 'record', fields: { x: { type: 'scalar', unit: '1', min: -1, max: 1 }, y: { type: 'scalar', unit: '1', min: -1, max: 1 }, z: { type: 'scalar', unit: '1', min: -1, max: 1 }, w: { type: 'scalar', unit: '1', min: -1, max: 1 } } },
        poseSource: { type: 'enum', values: ['software-bridge-fixture'] }, physical: { type: 'boolean' }, physicalState: { type: 'enum', values: ['unverified'] }, captureTimeKnown: { type: 'boolean' }, freshnessBasis: { type: 'enum', values: ['gateway-receipt'] }, qosStatus: { type: 'enum', values: ['requested-unverified'] },
    } } as ValueSchema);
export interface RosbridgePoseSelection {
    readonly endpoint: string;
    readonly profileId: typeof ROSBRIDGE_POSE_PROFILE.profileId;
    readonly profileVersion: '1.0.0';
    readonly topic: '/101/robot/pose';
    readonly interfaceType: 'geometry_msgs/msg/PoseStamped';
    readonly frameId: 'map';
}
export interface RosbridgePoseRequest extends RosbridgePoseSelection {
    readonly action: 'subscribe-ros-pose';
    readonly principalId: string;
    readonly applicationId: string;
    readonly sessionId: string;
    readonly generation: number;
    readonly purpose: string;
    readonly deadline: number;
    readonly qos: typeof qos;
}
export interface RosbridgePoseGrant {
    readonly request: RosbridgePoseRequest;
    readonly signal: AbortSignal;
    readonly expiresAt: number;
}
export interface DecodedRosbridgePose {
    readonly value: Readonly<{
        position: Readonly<{
            x: number;
            y: number;
            z: number;
        }>;
        orientation: Readonly<{
            x: number;
            y: number;
            z: number;
            w: number;
        }>;
        poseSource: 'software-bridge-fixture';
        physical: false;
        physicalState: 'unverified';
        captureTimeKnown: false;
        freshnessBasis: 'gateway-receipt';
        qosStatus: 'requested-unverified';
    }>;
    readonly rosStamp: Readonly<{
        sec: number;
        nanosec: number;
    }>;
    readonly frameId: 'map';
}
export interface RosbridgePoseReceipt extends DecodedRosbridgePose {
    readonly timestamp: number;
    readonly clockDomain: 'rosbridge-pose-gateway-monotonic';
    readonly gatewayReceiptSequence: number;
    readonly generation: number;
    readonly provenance: JsonObject;
}
export interface RosbridgePoseConnectorOptions {
    readonly selection: RosbridgePoseSelection;
    readonly scope: Readonly<{
        principalId: string;
        applicationId: string;
        sessionId: string;
    }>;
    readonly ownerSignal: AbortSignal;
    readonly authorizeSubscription: (request: RosbridgePoseRequest) => RosbridgePoseGrant | undefined;
    readonly onPose: (receipt: RosbridgePoseReceipt) => void;
    readonly onUnavailable: (reason: string) => void;
}
export interface RosbridgePoseConnector {
    connect(input: Readonly<{
        purpose: string;
        deadline: number;
        signal: AbortSignal;
    }>): Promise<Readonly<{
        ok: true;
        state: 'subscription-requested-unverified';
    } | {
        ok: false;
        reason: string;
    }>>;
    close(): Promise<void>;
    status(): Readonly<{
        phase: 'idle' | 'connecting' | 'subscribed' | 'retiring' | 'closed';
        generation: number;
        attempts: number;
        receivedMessages: number;
        receivedBytes: number;
        sentBytes: number;
        rawSockets: number;
        rawWrites: number;
        timers: number;
        waiters: number;
        reason: string;
    }>;
}
interface NativeWs extends EventEmitter {
    readonly readyState: number;
    send(data: string, options: {
        binary: boolean;
    }, done: (error?: Error) => void): void;
    close(): void;
    terminate(): void;
}
const library = createRequire(import.meta.url)('ws') as {
    WebSocket: new (endpoint: string, options: object) => NativeWs;
};
const now = performance.now.bind(performance);
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
function isAborted(s: AbortSignal): boolean { return Reflect.apply(aborted, s, []) as boolean; }
function signal(input: unknown): AbortSignal {
    try {
        if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== AbortSignal.prototype)
            invalid();
        isAborted(input as AbortSignal);
        return input as AbortSignal;
    }
    catch {
        throw new TypeError('native signal required');
    }
}
function invalid(): never { throw new TypeError('invalid selected ROS bridge input'); }
function closed(v: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!v || typeof v !== 'object' || types.isProxy(v) || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v)))
        invalid();
    const own = Reflect.ownKeys(v);
    if (own.length !== keys.length || own.some(k => typeof k !== 'string' || !keys.includes(k)))
        invalid();
    const out: Record<string, unknown> = {};
    for (const k of keys) {
        const d = Object.getOwnPropertyDescriptor(v, k);
        if (!d?.enumerable || !('value' in d))
            invalid();
        out[k] = d.value;
    }
    return out;
}
function text(v: unknown): string {
    if (typeof v !== 'string' || !v.length || v.length > 128 || v.trim() !== v || [...v].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
        invalid();
    return v;
}
function number(v: unknown, min: number, max: number, integer = false): number {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || integer && !Number.isInteger(v))
        invalid();
    return v;
}
// JSON.parse erases duplicates. Scan each object's own key set before parsing.
function duplicateKeys(raw: string): void {
    const stack: {
        object: boolean;
        keys: Set<string>;
    }[] = [];
    for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (c === '{' || c === '[') {
            stack.push({ object: c === '{', keys: new Set() });
            continue;
        }
        if (c === '}' || c === ']') {
            stack.pop();
            continue;
        }
        if (c !== '"')
            continue;
        const start = i;
        for (i++; i < raw.length; i++) {
            if (raw[i] === '\\') {
                i++;
                continue;
            }
            if (raw[i] === '"')
                break;
        }
        let j = i + 1;
        while (/\s/.test(raw[j] ?? '') && j < raw.length)
            j++;
        const top = stack.at(-1);
        if (raw[j] === ':' && top?.object) {
            const key = JSON.parse(raw.slice(start, i + 1)) as string;
            if (top.keys.has(key))
                invalid();
            top.keys.add(key);
        }
    }
}
export function decodeRosbridgePose(bytes: Uint8Array): DecodedRosbridgePose {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > 2048)
        invalid();
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    duplicateKeys(raw);
    const envelope = closed(JSON.parse(raw), ['op', 'topic', 'msg']);
    if (envelope.op !== 'publish' || envelope.topic !== ROSBRIDGE_POSE_PROFILE.topic)
        invalid();
    const msg = closed(envelope.msg, ['header', 'pose']), header = closed(msg.header, ['stamp', 'frame_id']), stamp = closed(header.stamp, ['sec', 'nanosec']);
    if (header.frame_id !== 'map')
        invalid();
    const sec = number(stamp.sec, -2147483648, 2147483647, true), nanosec = number(stamp.nanosec, 0, 999999999, true);
    const pose = closed(msg.pose, ['position', 'orientation']), position = closed(pose.position, ['x', 'y', 'z']), orientation = closed(pose.orientation, ['x', 'y', 'z', 'w']);
    const p = { x: number(position.x, -100, 100), y: number(position.y, -100, 100), z: number(position.z, -100, 100) };
    const q = { x: number(orientation.x, -1, 1), y: number(orientation.y, -1, 1), z: number(orientation.z, -1, 1), w: number(orientation.w, -1, 1) };
    if (Math.abs(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w - 1) > 0.002)
        invalid();
    const value = parseSignalValue({ position: p, orientation: q, poseSource: 'software-bridge-fixture', physical: false, physicalState: 'unverified', captureTimeKnown: false, freshnessBasis: 'gateway-receipt', qosStatus: 'requested-unverified' }, ROSBRIDGE_POSE_VALUE_SCHEMA) as DecodedRosbridgePose['value'];
    return Object.freeze({ value, rosStamp: Object.freeze({ sec, nanosec }), frameId: 'map' });
}
function selected(input: unknown): RosbridgePoseSelection {
    const v = closed(input, ['endpoint', ...Object.keys(ROSBRIDGE_POSE_PROFILE)]);
    const endpoint = text(v.endpoint), match = /^ws:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/rosbridge$/.exec(endpoint);
    if (!match || Number(match[1]) > 65535)
        invalid();
    for (const [k, value] of Object.entries(ROSBRIDGE_POSE_PROFILE))
        if (v[k] !== value)
            invalid();
    return Object.freeze({ ...ROSBRIDGE_POSE_PROFILE, endpoint });
}
/** Selected documented read-only protocol; receipt time is not ROS capture time. */
export function createRosbridgePoseConnector(options: RosbridgePoseConnectorOptions): RosbridgePoseConnector {
    const o = closed(options, ['selection', 'scope', 'ownerSignal', 'authorizeSubscription', 'onPose', 'onUnavailable']);
    const selection = selected(o.selection), s = closed(o.scope, ['principalId', 'applicationId', 'sessionId']);
    const scope = Object.freeze({ principalId: text(s.principalId), applicationId: text(s.applicationId), sessionId: text(s.sessionId) }), owner = signal(o.ownerSignal);
    const authorize = o.authorizeSubscription as RosbridgePoseConnectorOptions['authorizeSubscription'], onPose = o.onPose as RosbridgePoseConnectorOptions['onPose'], onUnavailable = o.onUnavailable as RosbridgePoseConnectorOptions['onUnavailable'];
    if (typeof authorize !== 'function' || typeof onPose !== 'function' || typeof onUnavailable !== 'function')
        invalid();
    let phase: ReturnType<RosbridgePoseConnector['status']>['phase'] = 'idle', generation = 0, attempts = 0, reason = 'inactive', receivedMessages = 0, receivedBytes = 0, sentBytes = 0, sequence = 0;
    let ws: NativeWs | undefined, tcp: Socket | undefined, sealed = true, tcpClosed = false, wsClosed = false, rawSockets = 0, caller: AbortSignal | undefined, grant: AbortSignal | undefined, deadline = 0;
    let readyResolve: ((v: Awaited<ReturnType<RosbridgePoseConnector['connect']>>) => void) | undefined;
    let retirement: Promise<void> | undefined, finishRaw: (() => void) | undefined;
    const timers = new Set<ReturnType<typeof setTimeout>>(), watches: {
        signal: AbortSignal;
        fn: () => void;
    }[] = [], writes = new Set<Promise<void>>();
    let pending: RosbridgePoseReceipt | undefined, quiet: ReturnType<typeof setTimeout> | undefined, opening: ReturnType<typeof setTimeout> | undefined;
    function schedule(fn: () => void, ms: number) { const id = setTimeout(() => { timers.delete(id); fn(); }, Math.max(0, ms)); timers.add(id); return id; }
    function cancel(id: ReturnType<typeof setTimeout> | undefined) {
        if (id) {
            clearTimeout(id);
            timers.delete(id);
        }
    }
    function current(run: number): boolean { return generation === run && (phase === 'connecting' || phase === 'subscribed') && !isAborted(owner) && !!caller && !isAborted(caller) && (!grant || !isAborted(grant)) && now() < deadline; }
    function check(run: number): boolean {
        if (current(run))
            return true;
        if (generation === run && (phase === 'connecting' || phase === 'subscribed'))
            void retire('expired-or-revoked');
        return false;
    }
    function watch(s: AbortSignal) {
        const fn = () => { void retire('revoked'); };
        Reflect.apply(add, s, ['abort', fn, { once: true }]);
        watches.push({ signal: s, fn });
        if (isAborted(s))
            fn();
    }
    function rawDone() {
        if (sealed && (!tcp || tcpClosed) && (!ws || wsClosed)) {
            rawSockets = 0;
            finishRaw?.();
        }
    }
    function write(message: object): Promise<void> {
        const raw = JSON.stringify(message), bytes = Buffer.byteLength(raw);
        if (bytes > 2048 || sentBytes + bytes > 65536 || writes.size >= 2)
            throw new Error('write-limit');
        const held = ws;
        if (!held || held.readyState !== 1)
            throw new Error('transport-unavailable');
        sentBytes += bytes;
        let finish!: () => void, fail!: (e: Error) => void;
        const p = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
        void p.catch(() => { });
        writes.add(p);
        void p.finally(() => writes.delete(p)).catch(() => { });
        try {
            held.send(raw, { binary: false }, error => {
                if (error)
                    fail(error);
                else
                    finish();
            });
        }
        catch (e) {
            fail(e instanceof Error ? e : new Error('send-fault'));
        }
        return p;
    }
    let subscriptionId = '';
    function retire(code: string): Promise<void> {
        if (retirement)
            return retirement;
        let settle!: () => void;
        retirement = new Promise(resolve => { settle = resolve; });
        phase = 'retiring';
        reason = code;
        generation++;
        pending = undefined;
        for (const id of timers)
            clearTimeout(id);
        timers.clear();
        quiet = undefined;
        opening = undefined;
        for (const w of watches)
            Reflect.apply(remove, w.signal, ['abort', w.fn]);
        watches.length = 0;
        readyResolve?.({ ok: false, reason: code });
        readyResolve = undefined;
        const raw = new Promise<void>(resolve => { finishRaw = resolve; rawDone(); });
        try {
            onUnavailable(code);
        }
        catch { /* withdrawal remains terminal */ }
        // Capture exact owned native transport; effectful callbacks are detached below.
        ws?.removeListener('open', onOpen);
        ws?.removeListener('message', onMessage);
        let unsub: Promise<void> | undefined;
        try {
            if (ws?.readyState === 1 && subscriptionId)
                unsub = write({ op: 'unsubscribe', id: subscriptionId, topic: selection.topic });
        }
        catch { /* attempted cleanup; native close still required */ }
        const destroy = () => {
            try {
                ws?.terminate();
            }
            catch { /* raw close remains required */ }
            tcp?.destroy();
            rawDone();
        };
        if (ws?.readyState === 1) {
            void (unsub ?? Promise.resolve()).then(() => {
                try {
                    ws?.close();
                }
                catch {
                    destroy();
                }
            }, destroy);
            schedule(destroy, 50);
        }
        else
            destroy();
        // Every issued callback retains its own reservation even if a sibling fails.
        void Promise.allSettled([raw, ...writes]).then(() => {
            for (const id of timers)
                clearTimeout(id);
            timers.clear();
            phase = 'closed';
            settle();
        });
        return retirement;
    }
    function publish(receipt: RosbridgePoseReceipt, run: number) {
        if (!check(run) || now() - receipt.timestamp >= 250)
            return;
        try {
            onPose(receipt);
        }
        catch {
            void retire('callback-fault');
        }
        check(run);
    }
    function onMessage(data: Buffer, binary: boolean) {
        const run = generation, at = now();
        if (!check(run))
            return;
        receivedMessages++;
        receivedBytes += data.length;
        if (binary || receivedMessages > 128 || receivedBytes > 65536 || data.length > 2048) {
            void retire('protocol-limit');
            return;
        }
        try {
            const d = decodeRosbridgePose(new Uint8Array(data));
            if (!check(run))
                return;
            const provenance: JsonObject = { profileId: selection.profileId, profileVersion: selection.profileVersion, topic: selection.topic, interfaceType: selection.interfaceType, frameId: d.frameId, rosStamp: { ...d.rosStamp }, sourceClockMapping: null, rosClockKind: 'unverified', spatialCompatibility: 'raw-components-unmapped', sourceBasisEstablished: false, sourceOriginEstablished: false, frameTransformVerified: false, qos: { ...qos }, qosStatus: 'requested-unverified', softwareOnly: true, physical: false, generation: run, gatewayReceiptSequence: ++sequence };
            const receipt = Object.freeze({ ...d, timestamp: at, clockDomain: 'rosbridge-pose-gateway-monotonic' as const, generation: run, gatewayReceiptSequence: sequence, provenance: snapshotJson(provenance) as JsonObject });
            cancel(quiet);
            quiet = schedule(() => { void retire('source-quiet'); }, at + 250 - now());
            if (phase === 'connecting')
                pending = receipt;
            else
                publish(receipt, run);
        }
        catch {
            void retire('malformed-message');
        }
    }
    function onOpen() {
        const run = generation;
        if (!check(run))
            return;
        let sent: Promise<void>;
        try {
            sent = write({ op: 'subscribe', id: subscriptionId, topic: selection.topic, type: selection.interfaceType, throttle_rate: 50, queue_length: 1, compression: 'none', qos });
        }
        catch {
            void retire('send-fault');
            return;
        }
        void sent.then(() => {
            if (!check(run))
                return;
            cancel(opening);
            phase = 'subscribed';
            readyResolve?.({ ok: true, state: 'subscription-requested-unverified' });
            readyResolve = undefined;
            if (pending) {
                const p = pending;
                pending = undefined;
                publish(p, run);
            }
            else
                quiet = schedule(() => { void retire('no-first-pose'); }, 250);
        }, () => { void retire('send-fault'); });
    }
    return {
        async connect(input) {
            const v = closed(input, ['purpose', 'deadline', 'signal']), purpose = text(v.purpose), inputSignal = signal(v.signal), at = now(), original = number(v.deadline, 0, Number.MAX_SAFE_INTEGER);
            if (isAborted(owner) || isAborted(inputSignal) || original <= at || original - at > 30000)
                return { ok: false, reason: 'expired-or-revoked' };
            if (phase !== 'idle' || attempts >= 8)
                return { ok: false, reason: 'unavailable' };
            attempts++;
            phase = 'connecting';
            const run = ++generation;
            caller = inputSignal;
            deadline = original;
            watch(owner);
            watch(caller);
            const request = Object.freeze({ ...selection, ...scope, action: 'subscribe-ros-pose' as const, generation: run, purpose, deadline: original, qos });
            let approval: RosbridgePoseGrant | undefined;
            try {
                approval = authorize(request);
            }
            catch {
                await retire('authorization-fault');
                return { ok: false, reason };
            }
            if (!approval) {
                if (!current(run)) {
                    await retire('expired-or-revoked');
                    return { ok: false, reason };
                }
                for (const w of watches)
                    Reflect.apply(remove, w.signal, ['abort', w.fn]);
                watches.length = 0;
                phase = 'idle';
                return { ok: false, reason: 'denied' };
            }
            try {
                const a = closed(approval, ['request', 'signal', 'expiresAt']);
                if (a.request !== request)
                    invalid();
                grant = signal(a.signal);
                deadline = Math.min(original, number(a.expiresAt, 0, Number.MAX_SAFE_INTEGER));
            }
            catch {
                await retire('invalid-grant');
                return { ok: false, reason };
            }
            if (!check(run)) {
                await retirement;
                return { ok: false, reason };
            }
            watch(grant!);
            if (!check(run)) {
                await retirement;
                return { ok: false, reason };
            }
            const ready = new Promise<Awaited<ReturnType<RosbridgePoseConnector['connect']>>>(resolve => { readyResolve = resolve; });
            subscriptionId = randomUUID();
            rawSockets = 1;
            sealed = false;
            tcpClosed = false;
            wsClosed = false;
            schedule(() => { void retire('expired'); }, deadline - now());
            opening = schedule(() => { void retire('opening-expired'); }, Math.min(deadline, now() + 500) - now());
            try {
                ws = new library.WebSocket(selection.endpoint, { agent: undefined, followRedirects: false, perMessageDeflate: false, maxPayload: 2048, handshakeTimeout: Math.max(1, Math.ceil(Math.min(deadline - now(), 500))),
                    createConnection(opts: TcpNetConnectOpts) {
                        const socket = connectTcp({ ...opts, path: undefined } as TcpNetConnectOpts);
                        tcp = socket;
                        socket.once('close', () => { tcpClosed = true; rawDone(); });
                        if (!current(run))
                            socket.destroy();
                        return socket;
                    } });
                ws.once('close', () => {
                    wsClosed = true;
                    rawDone();
                    if (generation === run)
                        void retire('peer-closed');
                });
                ws.on('error', () => {
                    if (generation === run)
                        void retire('peer-error');
                });
                ws.on('open', onOpen);
                ws.on('message', onMessage);
            }
            catch {
                wsClosed = true;
                void retire('construction-fault');
            }
            finally {
                sealed = true;
                rawDone();
            }
            if (!check(run)) {
                await retirement;
                return { ok: false, reason };
            }
            return ready;
        },
        close() { return retire('closed'); },
        status() {
            if (phase === 'connecting' || phase === 'subscribed')
                check(generation);
            return Object.freeze({ phase, generation, attempts, receivedMessages, receivedBytes, sentBytes, rawSockets, rawWrites: writes.size, timers: timers.size, waiters: readyResolve ? 1 : 0, reason });
        },
    };
}
