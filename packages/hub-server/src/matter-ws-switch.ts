/** Selected read-only native-wire software profile. Fabric claims are inert provenance. */
import { createRequire } from 'node:module';
import { connect as connectTcp, Socket } from 'node:net';
import type { TcpNetConnectOpts } from 'node:net';
import { types } from 'node:util';
import type WebSocket from 'ws';
const NativeWs: typeof WebSocket = createRequire(import.meta.url)('ws');
export const MATTER_WS_SWITCH_PROFILE = Object.freeze({ id: 'example:matter-server-switch/1', revision: 1, nodeId: '7', endpointId: 1, clusterId: 59, eventId: 1, numberOfPositions: 2, featureMap: 2, schemaVersion: 13, minSupportedSchemaVersion: 11, sdkVersion: 'matter-server/1.4.0 (matter.js/0.17.9)' } as const);
export const MATTER_WS_SWITCH_LIMITS = Object.freeze({ messageBytes: 32768, messages: 256, totalBytes: 1048576, outboundBytes: 4096, inventoryNodes: 16, attributeKeys: 64, depth: 8, jsonNodes: 2048, stringBytes: 1024, attempts: 8, sessionMs: 30000, openingMs: 2000, maxAgeMs: 1000, closeMs: 2000, controls: 64, controlPayloadBytes: 125, controlBytes: 4096 } as const);
export const MATTER_WS_SWITCH_POSITION_SCHEMA = Object.freeze({ type: 'scalar', unit: '1', min: 0, max: 1 } as const);
export const MATTER_WS_SWITCH_EVENT_SCHEMA = Object.freeze({ type: 'record', fields: Object.freeze({ newPosition: MATTER_WS_SWITCH_POSITION_SCHEMA }) } as const);
class Num {
    readonly lexeme: string;
    constructor(lexeme: string) { this.lexeme = lexeme; Object.freeze(this); }
}
type Json = null | boolean | string | Num | Json[] | {
    [key: string]: Json;
};
function fail(reason: string): never { throw new Error('Matter wire ' + reason); }
function parse(bytes: Uint8Array): Json {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MATTER_WS_SWITCH_LIMITS.messageBytes)
        fail('bytes');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    let at = 0, nodes = 0;
    const ws = () => { while (/[\x20\t\r\n]/.test(text[at] ?? 'x'))
        at++; };
    function str(): string { const begin = at++; let escaped = false; for (; at < text.length; at++) {
        const c = text[at];
        if (!escaped && c === '"') {
            at++;
            const value: unknown = JSON.parse(text.slice(begin, at));
            if (typeof value !== 'string' || Buffer.byteLength(value) > 1024 || value.includes('__BIGINT__'))
                fail('string');
            return value;
        }
        if (!escaped && c === '\\')
            escaped = true;
        else
            escaped = false;
    } return fail('unterminated string'); }
    function value(depth: number): Json {
        ws();
        if (++nodes > 2048 || depth > 8)
            fail('complexity');
        const c = text[at];
        if (c === '"')
            return str();
        if (c === '{' || c === '[') {
            at++;
            ws();
            const object = c === '{', end = object ? '}' : ']';
            const result: Json[] | {
                [k: string]: Json;
            } = object ? Object.create(null) as {
                [k: string]: Json;
            } : [];
            const keys = new Set<string>();
            if (text[at] === end) {
                at++;
                return result;
            }
            for (;;) {
                ws();
                if (object) {
                    if (text[at] !== '"')
                        fail('key');
                    const k = str();
                    if (keys.has(k) || ['__proto__', 'prototype', 'constructor'].includes(k))
                        fail('duplicate or prototype key');
                    keys.add(k);
                    ws();
                    if (text[at++] !== ':')
                        fail('colon');
                    (result as {
                        [k: string]: Json;
                    })[k] = value(depth + 1);
                }
                else
                    (result as Json[]).push(value(depth + 1));
                ws();
                const next = text[at++];
                if (next === end)
                    return result;
                if (next !== ',')
                    fail('delimiter');
            }
        }
        for (const [literal, v] of [['true', true], ['false', false], ['null', null]] as const)
            if (text.startsWith(literal, at)) {
                at += literal.length;
                return v;
            }
        const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(at));
        if (!match)
            return fail('token');
        at += match[0].length;
        return new Num(match[0]);
    }
    const result = value(0);
    ws();
    if (at !== text.length)
        fail('trailing');
    return result;
}
function inert(v: Json): void { if (v instanceof Num) {
    if (!Number.isFinite(Number(v.lexeme)))
        fail('nonfinite inert number');
}
else if (Array.isArray(v)) {
    for (const item of v)
        inert(item);
}
else if (v && typeof v === 'object') {
    for (const item of Object.values(v))
        inert(item);
} }
function obj(v: Json | undefined): {
    [key: string]: Json;
} { if (!v || typeof v !== 'object' || Array.isArray(v) || v instanceof Num)
    return fail('object'); return v; }
function keys(v: {
    [key: string]: Json;
}, required: string[], optional: string[] = []) { for (const k of required)
    if (!(k in v))
        fail('missing ' + k); for (const k of Object.keys(v))
    if (!required.includes(k) && !optional.includes(k))
        fail('unknown ' + k); }
function uint(v: Json | undefined): string { if (!(v instanceof Num) || !/^(?:0|[1-9][0-9]*)$/.test(v.lexeme) || BigInt(v.lexeme) > 18446744073709551615n)
    return fail('uint64'); return v.lexeme; }
function integer(v: Json | undefined, min: number, max: number): number { const s = uint(v), n = BigInt(s); if (n < BigInt(min) || n > BigInt(max))
    fail('range'); return Number(n); }
function string(v: Json | undefined, max = 256): string { if (typeof v !== 'string' || Buffer.byteLength(v) > max)
    return fail('text'); return v; }
function bool(v: Json | undefined): boolean { if (typeof v !== 'boolean')
    return fail('boolean'); return v; }
function position(v: Json | undefined): 0 | 1 | null { return v === null ? null : integer(v, 0, 1) as 0 | 1; }
function node(v: Json): Readonly<{
    nodeId: string;
    available: boolean;
}> {
    const n = obj(v);
    keys(n, ['node_id', 'date_commissioned', 'last_interview', 'interview_version', 'available', 'is_bridge', 'attributes', 'attribute_subscriptions'], ['matter_version']);
    const nodeId = uint(n.node_id);
    for (const k of ['date_commissioned', 'last_interview']) {
        const s = string(n[k], 64);
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s) || !Number.isFinite(Date.parse(s)))
            fail('date');
    }
    integer(n.interview_version, 0, 65535);
    const available = bool(n.available);
    bool(n.is_bridge);
    if (!Array.isArray(n.attribute_subscriptions) || n.attribute_subscriptions.length !== 0)
        fail('subscriptions');
    if (n.matter_version !== undefined)
        string(n.matter_version, 64);
    const attrs = obj(n.attributes);
    if (Object.keys(attrs).length > 64)
        fail('attributes');
    for (const k of Object.keys(attrs))
        if (!/^\d{1,5}\/\d{1,10}\/\d{1,10}$/.test(k))
            fail('path');
    if (nodeId === '7') {
        integer(attrs['1/59/0'], 2, 2);
        position(attrs['1/59/1']);
        integer(attrs['1/59/65532'], 2, 2);
    }
    for (const [path, value] of Object.entries(attrs))
        if (nodeId !== '7' || !['1/59/0', '1/59/1', '1/59/65532'].includes(path))
            inert(value);
    return Object.freeze({ nodeId, available });
}
function info(v: Json): Readonly<{
    kind: 'serverInfo';
    fabricId: string;
    compressedFabricId: string;
}> { const n = obj(v); keys(n, ['fabric_id', 'compressed_fabric_id', 'schema_version', 'min_supported_schema_version', 'sdk_version', 'wifi_credentials_set', 'thread_credentials_set', 'bluetooth_enabled'], ['fabric_index', 'wifi_ssid', 'ble_proxy_enabled', 'controller_node_id']); integer(n.schema_version, 13, 13); integer(n.min_supported_schema_version, 11, 11); if (string(n.sdk_version, 128) !== MATTER_WS_SWITCH_PROFILE.sdkVersion)
    fail('SDK'); for (const k of ['wifi_credentials_set', 'thread_credentials_set', 'bluetooth_enabled'])
    bool(n[k]); if (n.fabric_index !== undefined)
    integer(n.fabric_index, 1, 254); if (n.wifi_ssid !== undefined)
    string(n.wifi_ssid, 256); if (n.ble_proxy_enabled !== undefined)
    bool(n.ble_proxy_enabled); if (n.controller_node_id !== undefined)
    uint(n.controller_node_id); return Object.freeze({ kind: 'serverInfo', fabricId: uint(n.fabric_id), compressedFabricId: uint(n.compressed_fabric_id) }); }
export type MatterSwitchMessage = Readonly<{
    kind: 'serverInfo' | 'serverInfoUpdate';
    fabricId: string;
    compressedFabricId: string;
} | {
    kind: 'inventory';
    nodes: readonly Readonly<{
        nodeId: string;
        available: boolean;
    }>[];
} | {
    kind: 'position';
    value: 0 | 1 | null;
} | {
    kind: 'press';
    newPosition: 0 | 1;
    eventNumber: string;
    timestamp: string;
    timestampType: 0 | 1 | 2;
} | {
    kind: 'offline';
    reason: string;
} | {
    kind: 'ignored';
}>;
export function decodeMatterSwitchMessage(bytes: Uint8Array): MatterSwitchMessage {
    const n = obj(parse(bytes));
    if ('schema_version' in n)
        return info(n);
    if ('message_id' in n) {
        if (string(n.message_id, 32) !== 'listen-1')
            fail('result id');
        if ('error_code' in n) {
            keys(n, ['message_id', 'error_code'], ['details']);
            integer(n.error_code, 0, 65535);
            if (n.details !== undefined)
                string(n.details);
            return fail('native error');
        }
        keys(n, ['message_id', 'result']);
        if (!Array.isArray(n.result) || n.result.length > 16)
            fail('inventory');
        const nodes = n.result.map(node);
        if (nodes.filter(v => v.nodeId === '7').length !== 1)
            fail('selected inventory');
        if (!nodes.find(v => v.nodeId === '7')!.available)
            return Object.freeze({ kind: 'offline', reason: 'unavailable' });
        return Object.freeze({ kind: 'inventory', nodes: Object.freeze(nodes) });
    }
    keys(n, ['event', 'data']);
    const event = string(n.event, 64), data = n.data!;
    if (event === 'server_info_updated') {
        const updated = info(data);
        return Object.freeze({ ...updated, kind: 'serverInfoUpdate' });
    }
    if (event === 'server_shutdown') {
        keys(obj(data), []);
        return Object.freeze({ kind: 'offline', reason: 'server-shutdown' });
    }
    if (event === 'node_removed')
        return uint(data) === '7' ? Object.freeze({ kind: 'offline', reason: 'node-removed' }) : Object.freeze({ kind: 'ignored' });
    if (event === 'node_added' || event === 'node_updated') {
        const d = node(data);
        return d.nodeId === '7' && !d.available ? Object.freeze({ kind: 'offline', reason: 'unavailable' }) : Object.freeze({ kind: 'ignored' });
    }
    if (event === 'endpoint_added' || event === 'endpoint_removed') {
        const d = obj(data);
        keys(d, ['node_id', 'endpoint_id']);
        const id = uint(d.node_id), endpoint = integer(d.endpoint_id, 0, 65535);
        return event === 'endpoint_removed' && id === '7' && endpoint === 1 ? Object.freeze({ kind: 'offline', reason: 'endpoint-removed' }) : Object.freeze({ kind: 'ignored' });
    }
    if (event === 'attribute_updated') {
        if (!Array.isArray(data) || data.length !== 3)
            fail('attribute tuple');
        const id = uint(data[0]), path = string(data[1], 32);
        if (!/^\d{1,5}\/\d{1,10}\/\d{1,10}$/.test(path))
            fail('path');
        if (id === '7') {
            if (path === '1/59/1')
                return Object.freeze({ kind: 'position', value: position(data[2]) });
            if (path === '1/59/0' || path === '1/59/65532')
                integer(data[2], 2, 2);
        }
        inert(data[2]!);
        return Object.freeze({ kind: 'ignored' });
    }
    if (event === 'node_event') {
        const d = obj(data);
        keys(d, ['node_id', 'endpoint_id', 'cluster_id', 'event_id', 'event_number', 'priority', 'timestamp', 'timestamp_type', 'data']);
        const id = uint(d.node_id), endpoint = integer(d.endpoint_id, 0, 65535), cluster = integer(d.cluster_id, 0, 4294967295), eventId = integer(d.event_id, 0, 4294967295);
        uint(d.event_number);
        uint(d.timestamp);
        if (id !== '7' || endpoint !== 1 || cluster !== 59 || eventId !== 1) {
            inert(d.data!);
            return Object.freeze({ kind: 'ignored' });
        }
        const fields = obj(d.data);
        keys(fields, ['newPosition']);
        return Object.freeze({ kind: 'press', newPosition: integer(fields.newPosition, 0, 1) as 0 | 1, eventNumber: uint(d.event_number), timestamp: uint(d.timestamp), timestampType: integer(d.timestamp_type, 0, 2) as 0 | 1 | 2, ...(integer(d.priority, 1, 1) === 1 ? {} : {}) });
    }
    if (['thread_diagnostics_updated', 'network_topology_updated'].includes(event)) {
        obj(data);
        inert(data);
        return Object.freeze({ kind: 'ignored' });
    }
    if (event === 'webrtc_callback') {
        const d = obj(data);
        uint(d.node_id);
        integer(d.endpoint_id, 0, 65535);
        string(d.event_type, 32);
        return Object.freeze({ kind: 'ignored' });
    }
    return fail('unknown event');
}
export interface MatterSwitchRequest {
    readonly authority: 'matter-fabric-inventory-event-stream';
    readonly endpoint: string;
    readonly profile: typeof MATTER_WS_SWITCH_PROFILE;
    readonly limits: typeof MATTER_WS_SWITCH_LIMITS;
    readonly scope: Readonly<{
        principalId: string;
        applicationId: string;
        sessionId: string;
    }>;
    readonly generation: number;
    readonly purpose: string;
    readonly deadline: number;
}
interface Receipt {
    readonly fabricId: string;
    readonly compressedFabricId: string;
    readonly receivedAt: number;
    readonly receiptClockId: 'matter-ws-gateway-monotonic';
    readonly localSequence: number;
    readonly generation: number;
    readonly maxAgeMs: 1000;
    readonly clockMapping: null;
    readonly captureTimeKnown: false;
    readonly physical: false;
}
export type MatterPositionReceipt = Readonly<Receipt & {
    kind: 'position';
    value: 0 | 1 | null;
}>;
export type MatterPressReceipt = Readonly<Receipt & {
    kind: 'press';
    newPosition: 0 | 1;
    eventNumber: string;
    timestamp: string;
    timestampType: 0 | 1 | 2;
}>;
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const add = AbortSignal.prototype.addEventListener, remove = AbortSignal.prototype.removeEventListener;
function genuine(v: unknown): v is AbortSignal { if (!v || typeof v !== 'object' || types.isProxy(v) || Object.getPrototypeOf(v) !== AbortSignal.prototype)
    return false; try {
    Reflect.apply(abortedGetter, v, []);
    return true;
}
catch {
    return false;
} }
const aborted = (s: AbortSignal): boolean => Reflect.apply(abortedGetter, s, []) as boolean;
/** Inspect descriptors without invoking caller accessors or proxy traps. */
function ownRecord<T extends object>(value: unknown, fields: readonly (keyof T)[]): Readonly<T> {
    if (!value || typeof value !== 'object' || types.isProxy(value)) throw new Error('Inert own-data record required');
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('Inherited record rejected');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const names = Reflect.ownKeys(descriptors);
    if (names.length !== fields.length || names.some(name => typeof name !== 'string' || !fields.includes(name as keyof T))) throw new Error('Exact record fields required');
    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const field of fields) {
        const descriptor = descriptors[String(field)];
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('Record accessors rejected');
        snapshot[String(field)] = descriptor.value;
    }
    return Object.freeze(snapshot) as Readonly<T>;
}

export function createMatterWsSwitchConnector(options: Readonly<{
    endpoint: string;
    scope: MatterSwitchRequest['scope'];
    ownerSignal: AbortSignal;
    authorize: (r: MatterSwitchRequest) => Readonly<{
        request: MatterSwitchRequest;
        signal: AbortSignal;
        expiresAt: number;
    }> | undefined;
    onPosition: (r: MatterPositionReceipt) => void;
    onPress: (r: MatterPressReceipt) => void;
    onUnavailable: (reason: string) => void;
}>) {
    const captured = ownRecord<typeof options>(options, ['endpoint', 'scope', 'ownerSignal', 'authorize', 'onPosition', 'onPress', 'onUnavailable']);
    const endpoint = captured.endpoint, scope = ownRecord<MatterSwitchRequest['scope']>(captured.scope, ['principalId', 'applicationId', 'sessionId']), owner = captured.ownerSignal, authorize = captured.authorize, onPosition = captured.onPosition, onPress = captured.onPress, onUnavailable = captured.onUnavailable;
    if (typeof endpoint !== 'string' || !/^ws:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/ws$/.test(endpoint) || Number(new URL(endpoint).port) > 65535) throw new Error('Exact loopback endpoint required');
    if (!genuine(owner)) throw new Error('Native owner signal required');
    for (const value of Object.values(scope)) if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 128) throw new Error('Scope required');
    for (const callback of [authorize, onPosition, onPress, onUnavailable]) if (typeof callback !== 'function') throw new Error('Callbacks required');
    let phase: 'idle' | 'opening' | 'ready' | 'retiring' | 'closed' = 'idle', reason = 'idle', generation = 0, attempts = 0, localSequence = 0, terminal = false, rawTcpSockets = 0, rawWsSockets = 0, rawWrites = 0, messages = 0, receivedBytes = 0, controls = 0, controlReceivedBytes = 0, sentBytes = 0, controlSentBytes = 0;
    let socket: WebSocket | undefined, tcp: Socket | undefined, caller: AbortSignal | undefined, grant: AbortSignal | undefined, expiresAt = 0, watermark = -1n, retirement: Promise<void> | undefined;
    const failures: string[] = [], detach: (() => void)[] = [], timers = new Set<ReturnType<typeof setTimeout>>(), waiters = new Set<(e: Error) => void>(), writes = new Set<Promise<void>>();
    let wsClosed: Promise<void> | undefined, tcpClosed: Promise<void> | undefined;
    const diagnostic = (value: unknown): string => {
        if (typeof value === 'string') return value.slice(0, 256);
        if (value && typeof value === 'object' && !types.isProxy(value) && types.isNativeError(value)) {
            const message = Object.getOwnPropertyDescriptor(value, 'message');
            if (message && Object.hasOwn(message, 'value') && typeof message.value === 'string') return message.value.slice(0, 256);
        }
        return 'Unknown failure';
    };
    const note = (e: unknown) => { if (failures.length < 32) failures.push(diagnostic(e)); };
    const schedule = (fn: () => void, ms: number) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, Math.max(1, ms)); timers.add(timer); return timer; };
    function clear(timer: ReturnType<typeof setTimeout>) { clearTimeout(timer); timers.delete(timer); }
    const current = (run: number) => run === generation && (phase === 'opening' || phase === 'ready') && !!caller && !!grant && !aborted(owner) && !aborted(caller) && !aborted(grant) && performance.now() < expiresAt;
    function retire(code: string, cause?: unknown): Promise<void> {
        if (retirement)
            return retirement;
        if (phase === 'closed')
            return Promise.resolve();
        if (phase === 'idle') {
            if (terminal)
                phase = 'closed';
            return Promise.resolve();
        }
        phase = 'retiring';
        reason = code;
        generation++;
        if (cause !== undefined) note(cause);
        for (const timer of timers)
            clear(timer);
        for (const fn of detach.splice(0))
            fn();
        for (const cancel of [...waiters])
            cancel(new Error(code));
        // Publish the ownership promise before the external withdrawal callback.
        let resolveFull!: () => void, rejectFull!: (e: unknown) => void;
        const full = new Promise<void>((res, rej) => { resolveFull = res; rejectFull = rej; });
        void full.catch(() => { });
        retirement = full;
        const active = socket;
        const wsWasOpen = active?.readyState === NativeWs.OPEN;
        const legs = [...writes, ...(wsClosed ? [wsClosed] : []), ...(tcpClosed ? [tcpClosed] : [])];
        if (active) {
            try {
                if (active.readyState === NativeWs.OPEN)
                    active.close();
                else if (active.readyState !== NativeWs.CLOSED)
                    active.terminate();
            }
            catch (e) {
                note(e);
                try {
                    tcp?.destroy();
                }
                catch (inner) {
                    note(inner);
                }
            }
        }
        // The HTTP request may have failed before adopting this issued TCP object.
        if (!wsWasOpen) { try { tcp?.destroy(); } catch (e) { note(e); } }
        void Promise.allSettled(legs).then(results => { const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map(r => r.reason); socket = undefined; tcp = undefined; wsClosed = undefined; tcpClosed = undefined; caller = undefined; grant = undefined; phase = terminal ? 'closed' : 'idle'; retirement = undefined; if (errors.length) {
            const error = new AggregateError(errors, 'Matter native settlement failed');
            note(error);
            rejectFull(error);
        }
        else
            resolveFull(); });
        try {
            onUnavailable(code);
        }
        catch (e) {
            note(e);
        }
        return full;
    }
    function observe(p: Promise<void>): Promise<void> { let timer: ReturnType<typeof setTimeout>; const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { note('Matter native close unconfirmed'); reject(new Error('Matter native close unconfirmed')); }, 2000); }); return Promise.race([p, timeout]).finally(() => clearTimeout(timer)); }
    const withdraw = (r: string, e?: unknown) => { void retire(r, e).catch(note); };
    function watch(s: AbortSignal, r: string) { const fn = () => withdraw(r); Reflect.apply(add, s, ['abort', fn, { once: true }]); detach.push(() => Reflect.apply(remove, s, ['abort', fn])); if (aborted(s))
        fn(); }
    function write(issue: (cb: (e?: Error) => void) => void): Promise<void> { rawWrites++; let finish!: (e?: Error) => void; const p = new Promise<void>((res, rej) => { let done = false; finish = e => { if (done)
        return; done = true; rawWrites--; if (e)
        rej(e);
    else
        res(); }; }); writes.add(p); void p.then(() => writes.delete(p), e => { writes.delete(p); withdraw('write-failed', e); }); try {
        issue(finish);
    }
    catch (e) {
        finish(new Error(diagnostic(e)));
    } return p; }
    async function start(input: Readonly<{
        purpose: string;
        deadline: number;
        signal: AbortSignal;
    }>): Promise<Readonly<{
        ok: true;
    } | {
        ok: false;
        reason: string;
    }>> {
        const bad = (r: string) => Object.freeze({ ok: false as const, reason: r });
        const started = performance.now();
        let captured: Readonly<typeof input>;
        try { captured = ownRecord<typeof input>(input, ['purpose', 'deadline', 'signal']); } catch { return bad('invalid-input'); }
        const signal = captured.signal, purpose = captured.purpose, deadline = captured.deadline;
        if (phase !== 'idle' || terminal)
            return bad('busy-or-closed');
        if (!genuine(signal) || typeof purpose !== 'string' || !purpose.trim() || Buffer.byteLength(purpose) > 256 || !Number.isFinite(deadline) || deadline <= started || deadline - started > 30000 || aborted(owner) || aborted(signal))
            return bad('invalid-or-expired');
        if (attempts >= 8 || generation >= Number.MAX_SAFE_INTEGER - 2)
            return bad('attempt-limit');
        attempts++;
        generation++;
        const run = generation;
        phase = 'opening';
        reason = 'opening';
        caller = signal;
        messages = 0;
        receivedBytes = 0;
        controls = 0;
        controlReceivedBytes = 0;
        sentBytes = 0;
        controlSentBytes = 0;
        watermark = -1n;
        const request: MatterSwitchRequest = Object.freeze({ authority: 'matter-fabric-inventory-event-stream', endpoint, profile: MATTER_WS_SWITCH_PROFILE, limits: MATTER_WS_SWITCH_LIMITS, scope, generation: run, purpose, deadline: deadline });
        let approval: ReturnType<typeof authorize>;
        try {
            const proposed = authorize(request);
            if (generation !== run || phase !== 'opening') return bad(reason);
            approval = proposed === undefined ? undefined : ownRecord<NonNullable<ReturnType<typeof authorize>>>(proposed, ['request', 'signal', 'expiresAt']);
        }
        catch (e) {
            withdraw('authorizer-failed', e);
            return bad(reason);
        }
        if (generation !== run || phase !== 'opening') return bad(reason);
        if (aborted(owner) || aborted(signal) || performance.now() >= request.deadline) { withdraw('cancelled-or-expired'); return bad(reason); }
        if (!approval || approval.request !== request || !genuine(approval.signal) || aborted(approval.signal) || !Number.isFinite(approval.expiresAt) || approval.expiresAt > request.deadline || approval.expiresAt <= performance.now()) {
            withdraw('denied');
            return bad('denied');
        }
        grant = approval.signal;
        expiresAt = approval.expiresAt;
        watch(owner, 'owner-aborted');
        watch(caller, 'caller-aborted');
        watch(grant, 'grant-revoked');
        if (!current(run))
            return bad(reason);
        let readyResolve!: (value: Readonly<{
            ok: true;
        } | {
            ok: false;
            reason: string;
        }>) => void;
        const ready = new Promise<Readonly<{
            ok: true;
        } | {
            ok: false;
            reason: string;
        }>>(r => { readyResolve = r; });
        const cancel = () => { waiters.delete(cancel); readyResolve(bad(reason)); };
        waiters.add(cancel);
        let handshake = false, inventory = false, commandSettled = false, fabricId = '', compressedFabricId = '';
        const opening = schedule(() => withdraw('opening-expired'), Math.min(expiresAt, started + 2000) - performance.now());
        schedule(() => withdraw('expired'), expiresAt - performance.now());
        const complete = () => { if (current(run) && handshake && inventory && commandSettled) {
            phase = 'ready';
            reason = 'ready';
            clear(opening);
            waiters.delete(cancel);
            readyResolve(Object.freeze({ ok: true }));
        } };
        try {
            socket = new NativeWs(endpoint, { perMessageDeflate: false, maxPayload: 32768, autoPong: false, createConnection: ((nativeOptions: TcpNetConnectOpts) => { tcp = new Socket(); rawTcpSockets++; const raw = tcp; tcpClosed = new Promise<void>(res => { raw.once('close', () => { rawTcpSockets--; res(); }); }); raw.on('error', e => withdraw('tcp-error', e)); raw.connect(nativeOptions); return raw; }) as typeof connectTcp });
            rawWsSockets++;
            const active = socket;
            wsClosed = new Promise<void>(res => { active.once('close', () => { rawWsSockets--; res(); if (current(run))
                withdraw('transport-closed'); }); });
            active.on('error', e => withdraw('transport-error', e));
            const control = (payload: Buffer, ping: boolean) => { if (run !== generation)
                return; controls++; controlReceivedBytes += payload.byteLength; if (!current(run) || controls > 64 || payload.byteLength > 125 || controlReceivedBytes > 4096) {
                withdraw('control-quota');
                return;
            } if (ping) {
                controlSentBytes += payload.byteLength;
                if (controlSentBytes > 4096) {
                    withdraw('control-quota');
                    return;
                }
                void write(cb => active.pong(payload, undefined, cb));
            } };
            active.on('ping', b => control(b, true));
            active.on('pong', b => control(b, false));
            active.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
                if (run !== generation)
                    return;
                messages++;
                const b = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
                receivedBytes += b.byteLength;
                if (messages > 256 || receivedBytes > 1048576 || isBinary) {
                    withdraw('message-quota-or-binary');
                    return;
                }
                if (!current(run)) {
                    withdraw('expired-or-revoked');
                    return;
                }
                const receivedAt = performance.now();
                try {
                    const d = decodeMatterSwitchMessage(b);
                    if (!handshake) {
                        if (d.kind !== 'serverInfo')
                            throw new Error('Missing server info');
                        handshake = true;
                        fabricId = d.fabricId;
                        compressedFabricId = d.compressedFabricId;
                        const command = '{"message_id":"listen-1","command":"start_listening","args":{}}';
                        sentBytes += Buffer.byteLength(command);
                        if (sentBytes > 4096)
                            throw new Error('Application outbound quota');
                        void write(cb => active.send(command, cb)).then(() => { commandSettled = true; complete(); }, () => { });
                        return;
                    }
                    if (d.kind === 'offline') {
                        withdraw(d.reason);
                        return;
                    }
                    if (d.kind === 'serverInfo' || d.kind === 'serverInfoUpdate') {
                        if (d.fabricId !== fabricId || d.compressedFabricId !== compressedFabricId) withdraw('fabric-claim-changed');
                        return;
                    }
                    if (d.kind === 'inventory') {
                        if (inventory)
                            throw new Error('Duplicate result');
                        inventory = true;
                        complete();
                        return;
                    }
                    if (phase !== 'ready')
                        return;
                    if (d.kind === 'ignored')
                        return;
                    if (d.kind === 'press') {
                        const event = BigInt(d.eventNumber);
                        if (event <= watermark)
                            return;
                        watermark = event;
                    }
                    if (localSequence >= Number.MAX_SAFE_INTEGER)
                        throw new Error('Sequence exhausted');
                    const receipt = Object.freeze({ ...d, fabricId, compressedFabricId, receivedAt, receiptClockId: 'matter-ws-gateway-monotonic' as const, localSequence: ++localSequence, generation: run, maxAgeMs: 1000 as const, clockMapping: null, captureTimeKnown: false as const, physical: false as const });
                    if (d.kind === 'position')
                        onPosition(receipt as MatterPositionReceipt);
                    else
                        onPress(receipt as MatterPressReceipt);
                    if (generation !== run) return;
                    if (!current(run)) withdraw('expired-or-revoked');
                }
                catch (e) {
                    withdraw('protocol-or-callback', e);
                }
            });
        }
        catch (e) {
            withdraw('opening-failed', e);
        }
        return ready;
    }
    return Object.freeze({ start, stop: () => observe(retire('stopped')), close: () => { terminal = true; return observe(retire('closed')); }, status: () => Object.freeze({ phase, reason, generation, attempts, localSequence, messages, receivedBytes, controls, controlReceivedBytes, sentBytes, controlSentBytes, rawSockets: Math.max(rawTcpSockets, rawWsSockets), nativeClients: Math.max(rawTcpSockets, rawWsSockets), rawTcpSockets, rawWsSockets, rawWrites, timers: timers.size, waiters: waiters.size, failures: Object.freeze([...failures]) }) });
}
