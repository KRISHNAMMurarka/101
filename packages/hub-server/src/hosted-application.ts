import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { parseDeviceDescriptor, parseValueSchema, parseWorkloadRequirements } from '@101/device-model';
import type { JsonValue } from '@101/device-model';
import type { DeliveryContext, HandoffEpoch, HandoffHost } from '@101/device-runtime';

export const HOSTED_APPLICATION_PROFILE = 'owned-node-raster-application/1' as const;
export const HOSTED_APPLICATION_LIMITS = Object.freeze({ pending: 1, nativeClients: 2, starts: 3, attempts: 64, operations: 32,
  frameBytes: 4096, totalBytes: 65536, chunks: 64, deadlineMs: 2500, lifetimeMs: 10000, frameAgeMs: 250,
  pixels: 16, width: 4, height: 4, terminateMs: 150, killMs: 400 });
export type HostedApplicationFailure = 'invalid' | 'denied' | 'busy' | 'closed' | 'cancelled' | 'unavailable' | 'expired' | 'quota' | 'version-mismatch';
export type HostedApplicationResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: HostedApplicationFailure; issued?: true; uncertain?: true }>;
export type HostedApplicationEpoch = Readonly<{ readonly hostedApplicationEpoch?: never }>;
export interface HostedApplicationState { readonly x: number; readonly y: number; readonly revision: number }
export interface HostedApplicationFrame {
  readonly state: HostedApplicationState; readonly pixels: readonly number[]; readonly sequence: number; readonly providerEpoch: number;
  readonly sourceTime: Readonly<{ clockId: string; at: number }>; readonly quality: 'valid'; readonly receivedAt: number; readonly receiptClockId: string;
}
export interface HostedApplicationApprovalRequest {
  readonly profile: typeof HOSTED_APPLICATION_PROFILE; readonly ownerId: string; readonly providerId: string;
  readonly applicationId: string; readonly sessionId: string; readonly codeSha256: string; readonly epoch: number;
  readonly action: 'launch' | 'input' | 'frame' | 'pause' | 'stage' | 'resume';
  readonly resourceId: 'application' | 'cursor-input' | 'raster-frame'; readonly operation: 'invoke' | 'read'; readonly purpose: string; readonly version: 1;
}
/** Exact same request object and intrinsic signal are required. Expiry is host performance.now(), never child time. */
export interface HostedApplicationApproval { readonly request: HostedApplicationApprovalRequest; readonly signal: AbortSignal; readonly expiresAt: number }
export interface HostedApplicationOptions {
  readonly ownerId: string; readonly providerId: string; readonly applicationId: string; readonly sessionId: string; readonly signal: AbortSignal;
  readonly authorize: (request: HostedApplicationApprovalRequest) => HostedApplicationApproval | undefined;
  /** Trusted host diagnostics receive no capability, input, state, pixels or grants. */
  readonly onChild?: (observation: Readonly<{ pid: number; socketPath: string; epoch: number; codeSha256: string }>) => void;
  readonly onRetire?: (observation: Readonly<{ pid: number; epoch: number }>) => void;
}
export interface HostedApplication {
  start(request: Readonly<{ purpose: string; version: number }>): Promise<HostedApplicationResult<HostedApplicationEpoch>>;
  input(epoch: HostedApplicationEpoch, target: Readonly<{ x: number; y: number }>, request: Readonly<{ purpose: string; signal: AbortSignal; context: DeliveryContext }>): Promise<HostedApplicationResult<Readonly<{ revision: number }>>>;
  frame(epoch: HostedApplicationEpoch, request: Readonly<{ purpose: string; signal: AbortSignal }>): Promise<HostedApplicationResult<HostedApplicationFrame>>;
  /** Only the latest already approved, current and fresh native frame; no new native read or grant. */
  currentFrame(epoch: HostedApplicationEpoch): HostedApplicationFrame | undefined;
  epoch(): HostedApplicationEpoch | undefined;
  handoffHost(): HandoffHost;
  stop(): Promise<void>; close(): Promise<void>;
  status(): Readonly<{ profile: typeof HOSTED_APPLICATION_PROFILE; phase: 'idle' | 'starting' | 'paused' | 'active' | 'retiring' | 'closed';
    starts: number; attempts: number; operations: number; inputs: number; nativeChildren: number; nativePending: number; timers: number; cleanupVerified: boolean }>;
}

// Fixed reviewed child application, not a caller-selected program or an RSS profile extension.
// Input changes application state; the native child renderer alone creates raster bytes.
const CHILD_SOURCE = String.raw`
import { createServer } from 'node:net';
import { chmod, unlink } from 'node:fs/promises';
import { createHmac, timingSafeEqual } from 'node:crypto';
let init,server,closing=false,active=false,sequence=0,traffic=0,attempts=0,permit,state={x:0,y:0,revision:0};
const sockets=new Set(),lifetime=setTimeout(()=>void stop(),10000);
function closed(o,keys){return o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k));}
function position(o,revision=false){return closed(o,revision?['x','y','revision']:['x','y'])&&Number.isInteger(o.x)&&o.x>=0&&o.x<=3&&Number.isInteger(o.y)&&o.y>=0&&o.y<=3&&(!revision||Number.isInteger(o.revision)&&o.revision>=0&&o.revision<=32);}
function same(a,b){return typeof a==='string'&&typeof b==='string'&&/^[a-f0-9]{64}$/.test(a)&&/^[a-f0-9]{64}$/.test(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));}
async function stop(){if(closing)return;closing=true;active=false;permit=undefined;clearTimeout(lifetime);for(const s of sockets)s.destroy();if(server)await new Promise(r=>server.close(r));if(init)await unlink(init.path).catch(()=>{});if(process.connected)process.disconnect();process.exit(0);}
function render(){const pixels=[];for(let y=0;y<4;y++)for(let x=0;x<4;x++){const selected=x===state.x&&y===state.y;pixels.push(selected?255:0,selected?0:32,selected?64:0,255);}return pixels;}
process.on('disconnect',()=>void stop());
process.on('message',async m=>{
 if(closing)return;
 if(!init){
  if(!closed(m,['kind','path','capability','epoch'])||m.kind!=='init'||typeof m.path!=='string'||!/^\/tmp\/101-ha-[A-Za-z0-9]+\/s$/.test(m.path)||typeof m.capability!=='string'||!/^[a-f0-9]{64}$/.test(m.capability)||!Number.isSafeInteger(m.epoch)||m.epoch<1)return void stop();
  init=m;server=createServer({allowHalfOpen:true},s=>{
   if(closing||sockets.size>=2||++attempts>64){s.destroy();return;}sockets.add(s);let chunks=[],size=0,turns=0,finished=false;
   s.setTimeout(2500,()=>s.destroy());s.on('error',()=>{});s.on('close',()=>sockets.delete(s));
   function deny(){if(finished)return;finished=true;s.end(JSON.stringify({ok:false,reason:'denied'})+'\n',()=>s.destroy());}
   s.on('data',c=>{
    if(finished){s.destroy();return;}size+=c.byteLength;traffic+=c.byteLength;if(size>4096||traffic>65536||++turns>64)return deny();chunks.push(c);if(!c.includes(10))return;
    let m;try{const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size));chunks=[];if(!text.endsWith('\n')||text.slice(0,-1).includes('\n'))return deny();m=JSON.parse(text);}catch{return deny();}
    const keys=['version','epoch','capability','id','action'];if(m?.action==='input')keys.push('target');if(m?.action==='stage')keys.push('state');
    if(!closed(m,keys)||m.version!==1||m.epoch!==init.epoch||!same(m.capability,init.capability)||typeof m.id!=='string'||m.id!==permit?.id||m.action!==permit?.action||sequence>=32)return deny();
    permit=undefined;
    if(m.action==='input'){if(!active||!position(m.target)||state.revision>=32)return deny();state={...m.target,revision:state.revision+1};}
    else if(m.action==='frame'){if(!active)return deny();}
    else if(m.action==='pause')active=false;
    else if(m.action==='stage'){if(active||!position(m.state,true))return deny();state={...m.state};}
    else if(m.action==='resume')active=true;
    else return deny();
    const pixels=m.action==='frame'?render():[];sequence++;
    const body={version:1,epoch:init.epoch,pid:process.pid,id:m.id,action:m.action,sequence,state:{...state},pixels,at:performance.now(),clockId:'hosted-raster:'+process.pid+':'+init.epoch,quality:'valid'};
    const response=JSON.stringify({body,mac:createHmac('sha256',init.capability).update(JSON.stringify(body)).digest('hex')})+'\n';traffic+=Buffer.byteLength(response);if(traffic>65536)return deny();finished=true;s.end(response);
   });s.on('end',()=>{if(!finished)deny();});
  });server.on('error',()=>void stop());server.listen(init.path,async()=>{try{await chmod(init.path,0o600);if(!closing)process.send({kind:'ready',version:1,epoch:init.epoch,pid:process.pid});}catch{void stop();}});return;
 }
 if(closed(m,['kind','id','action'])&&m.kind==='permit'&&typeof m.id==='string'&&/^[a-f0-9]{32}$/.test(m.id)&&['input','frame','pause','stage','resume'].includes(m.action)){
  permit={id:m.id,action:m.action};process.send({kind:'permitted',id:m.id});return;
 }
 if(closed(m,['kind'])&&m.kind==='stop')void stop();
});
`;
export const HOSTED_APPLICATION_SOURCE_SHA256 = createHash('sha256').update(CHILD_SOURCE).digest('hex');
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
const isAborted = (signal: AbortSignal) => Reflect.apply(aborted, signal, []) as boolean;
function actualSignal(value: unknown): value is AbortSignal { try { isAborted(value as AbortSignal); return true; } catch { return false; } }
function fields(input: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !keys.includes(key))) return;
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, property] of Object.entries(descriptors)) { if (!('value' in property)) return; result[key] = property.value; }
  return result;
}
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,79}$/.test(value);
function state(input: unknown): HostedApplicationState | undefined {
  const value = fields(input, ['x', 'y', 'revision']);
  if (!value || Object.keys(value).length !== 3 || !Number.isInteger(value.x) || (value.x as number) < 0 || (value.x as number) > 3 || !Number.isInteger(value.y) || (value.y as number) < 0 || (value.y as number) > 3 || !Number.isInteger(value.revision) || (value.revision as number) < 0 || (value.revision as number) > 32) return;
  return Object.freeze({ x: value.x as number, y: value.y as number, revision: value.revision as number });
}
const failed = <T = never>(reason: HostedApplicationFailure, issued = false): HostedApplicationResult<T> => Object.freeze({ ok: false, reason, ...(issued ? { issued: true as const, uncertain: true as const } : {}) });
const good = <T>(value: T): HostedApplicationResult<T> => Object.freeze({ ok: true, value });

/** Inert reviewed declaration; descriptors and metadata never grant execution.
 * Frame schema is available only after selecting exact observed source/receipt
 * clock identities. This binding does not authenticate them or map clocks. */
export function hostedApplicationRequirements(providerId: string, frameClocks?: Readonly<{ sourceClockId: string; receiptClockId: string }>) {
  if (!identifier(providerId)) throw new TypeError('Invalid hosted application provider');
  const clocks = frameClocks === undefined ? undefined : fields(frameClocks, ['sourceClockId', 'receiptClockId']);
  if (frameClocks !== undefined && (!clocks || Object.keys(clocks).length !== 2 || typeof clocks.sourceClockId !== 'string' ||
    !/^hosted-raster:[1-9][0-9]{0,9}:([1-9]|[1-5][0-9]|6[0-4])$/.test(clocks.sourceClockId) || typeof clocks.receiptClockId !== 'string' ||
    !/^hosted-receipt:[1-9][0-9]{0,9}:[a-f0-9]{16}$/.test(clocks.receiptClockId))) throw new TypeError('Invalid hosted application clocks');
  const inputValue = parseValueSchema({ type: 'record', fields: { x: { type: 'scalar', unit: '1', min: 0, max: 3, resolution: 1 }, y: { type: 'scalar', unit: '1', min: 0, max: 3, resolution: 1 } } });
  const frameValue = clocks ? parseValueSchema({ type: 'record', fields: {
    pixels: { type: 'array', items: { type: 'scalar', unit: '1', min: 0, max: 255, resolution: 1 }, minItems: 64, maxItems: 64 },
    sequence: { type: 'scalar', unit: '1', min: 1, max: 32 }, providerEpoch: { type: 'scalar', unit: '1', min: 1, max: 64 },
    sourceTime: { type: 'record', fields: { clockId: { type: 'enum', values: [clocks.sourceClockId] }, at: { type: 'scalar', unit: 'ms', min: 0, max: Number.MAX_SAFE_INTEGER } } },
    receivedAt: { type: 'scalar', unit: 'ms', min: 0, max: Number.MAX_SAFE_INTEGER }, receiptClockId: { type: 'enum', values: [clocks.receiptClockId] }, quality: { type: 'enum', values: ['valid'] },
  } }) : undefined;
  const inputSource = parseDeviceDescriptor({ schemaVersion: 1, id: providerId + ':input-source', label: 'Approved application input', revision: 1,
    adapter: { id: 'connect:hosted-input', version: '1.0.0' }, runtime: { platform: 'node' }, capabilities: [{ id: 'cursor', semantic: 'connect:hosted-cursor', schemaVersion: 1, kind: 'event', value: inputValue, delivery: { mode: 'reliable', maxAgeMs: 250 }, permissions: ['subscribe'] }] });
  const inputSink = parseDeviceDescriptor({ schemaVersion: 1, id: providerId, label: 'Owned raster application', revision: 1,
    adapter: { id: 'connect:owned-node-raster', version: '1.0.0' }, runtime: { platform: 'node' }, capabilities: [{ id: 'cursor', semantic: 'connect:hosted-cursor', schemaVersion: 1, kind: 'command', value: inputValue, delivery: { mode: 'reliable', maxAgeMs: 250 }, permissions: ['invoke'], ownership: { mode: 'exclusive' } }] });
  const workload = { schemaVersion: 1, id: 'connect:hosted-raster', version: '1.0.0', application: { codeSha256: HOSTED_APPLICATION_SOURCE_SHA256,
    runtime: { platform: 'node', minimumVersion: '24.14.0' }, budget: { maxComputeMs: 5, maxMemoryBytes: 67108864 } }, processors: [], assets: [],
    resources: [{ deviceId: providerId, capability: 'cursor', operation: 'invoke', required: true }], privacy: { mode: 'local-only', purpose: null, destinations: [], retention: 'none' },
    budget: { maxComputeMs: 5, maxMemoryBytes: 67108864 }, restart: { mode: 'snapshot', formatVersion: 1, applicationCodeSha256: HOSTED_APPLICATION_SOURCE_SHA256, processorState: 'reset-on-resume', onIncompatible: 'cold-restart' } };
  const context = Object.freeze({ devices: Object.freeze([inputSource, inputSink]), processors: Object.freeze([]) });
  const parsed = parseWorkloadRequirements(workload, context);
  return Object.freeze({ workload: Object.freeze({ schemaVersion: 1 as const, ...parsed }), context, inputSource, inputSink, frameValue });
}
interface Approved { signal: AbortSignal; expiresAt: number }
interface AgentState {
  epoch: number; generation: number; handle: HostedApplicationEpoch; child: ChildProcess; directory: string; path: string; capability: string;
  launch: Approved; born: number; phase: 'paused' | 'active'; retired: boolean; childClosed: boolean; closed: Promise<void>; ready: (ok: boolean) => void;
  removals: (() => void)[]; socket?: Socket; shutdown?: Promise<void>; permit?: { id: string; done: (ok: boolean) => void };
  authority?: HandoffEpoch; unwatchAuthority?: () => void; latest?: { value: HostedApplicationFrame; grant: Approved; signal: AbortSignal };
  lastSequence: number; lastSourceTime: number;
}
interface NativeReply { state: HostedApplicationState; pixels: readonly number[]; sequence: number; at: number; clockId: string; receivedAt: number }

/** Fixed trusted Node application. Same-user private capability boundary, not OS/account authentication or a CPU/RSS sandbox.
 * Native issued input can finish before cancellation reaches the child; aborted results are explicitly uncertain.
 * Source pause quiesces after the handoff token is revoked and stop awaits actual native settlement. */
export function createHostedApplication(input: HostedApplicationOptions): HostedApplication {
  const option = fields(input, ['ownerId', 'providerId', 'applicationId', 'sessionId', 'signal', 'authorize', 'onChild', 'onRetire']);
  if (!option || ![option.ownerId, option.providerId, option.applicationId, option.sessionId].every(identifier) || !actualSignal(option.signal) || typeof option.authorize !== 'function' || (option.onChild !== undefined && typeof option.onChild !== 'function') || (option.onRetire !== undefined && typeof option.onRetire !== 'function')) throw new TypeError('Invalid hosted application options');
  const selected = Object.freeze(option), owner = selected.signal as AbortSignal, authorize = selected.authorize as HostedApplicationOptions['authorize'];
  const receiptClockId = `hosted-receipt:${process.pid}:${randomBytes(8).toString('hex')}`;
  const handles = new WeakMap<object, AgentState>(), timers = new Set<ReturnType<typeof setTimeout>>();
  let terminal = isAborted(owner), generation = 0, sequence = 0, starts = 0, attempts = 0, operations = 0, inputs = 0, lastClock = -1, cleanupFailed = false;
  let agent: AgentState | undefined, startDone: Promise<void> | undefined, rawDone: Promise<void> | undefined;
  let lifecycle: { epoch: HandoffEpoch; generation: number } | undefined;
  function watch(signal: AbortSignal, callback: () => void): () => void { Reflect.apply(add, signal, ['abort', callback, { once: true }]); return () => { Reflect.apply(remove, signal, ['abort', callback]); }; }
  function timer(ms: number, callback: () => void): () => void {
    const value = setTimeout(() => { timers.delete(value); callback(); }, Math.max(1, ms)); timers.add(value);
    return () => { clearTimeout(value); timers.delete(value); };
  }
  function now(): number { const value = performance.now(); if (!Number.isFinite(value) || value < 0 || value < lastClock) { terminal = true; void stop(); return NaN; } lastClock = value; return value; }
  function base(a: AgentState): boolean { const at = now(); return !terminal && !isAborted(owner) && agent === a && !a.retired && !a.childClosed && a.generation === generation && !isAborted(a.launch.signal) && at < a.launch.expiresAt && at < a.born + HOSTED_APPLICATION_LIMITS.lifetimeMs; }
  function token(value: unknown): value is HandoffEpoch {
    const item = fields(value, ['hostId', 'epoch', 'signal', 'isCurrent']); return !!item && Object.isFrozen(value) && Object.keys(item).length === 4 && item.hostId === selected.providerId && Number.isSafeInteger(item.epoch) && (item.epoch as number) > 0 && actualSignal(item.signal) && typeof item.isCurrent === 'function';
  }
  function active(a: AgentState): boolean {
    if (!base(a) || a.phase !== 'active' || !a.authority || isAborted(a.authority.signal)) return false;
    let current = false; try { current = a.authority.isCurrent(); } catch { /* fixed denial */ }
    return current && base(a) && a.phase === 'active' && !!a.authority && !isAborted(a.authority.signal);
  }
  function approval(action: HostedApplicationApprovalRequest['action'], epoch: number, purpose: string): Approved | undefined {
    const request: HostedApplicationApprovalRequest = Object.freeze({ profile: HOSTED_APPLICATION_PROFILE, ownerId: selected.ownerId as string, providerId: selected.providerId as string,
      applicationId: selected.applicationId as string, sessionId: selected.sessionId as string, codeSha256: HOSTED_APPLICATION_SOURCE_SHA256, epoch, action,
      resourceId: action === 'input' ? 'cursor-input' : action === 'frame' ? 'raster-frame' : 'application', operation: action === 'frame' ? 'read' : 'invoke', purpose, version: 1 });
    let grant: Record<string, unknown> | undefined; try { grant = fields(authorize(request), ['request', 'signal', 'expiresAt']); } catch { return; }
    const at = now();
    if (!grant || Object.keys(grant).length !== 3 || grant.request !== request || !actualSignal(grant.signal) || isAborted(grant.signal) || typeof grant.expiresAt !== 'number' || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= at || grant.expiresAt > at + HOSTED_APPLICATION_LIMITS.lifetimeMs) return;
    return Object.freeze({ signal: grant.signal, expiresAt: grant.expiresAt });
  }
  function retire(a: AgentState): Promise<void> {
    if (a.shutdown) return a.shutdown;
    a.retired = true; a.phase = 'paused'; a.latest = undefined; a.unwatchAuthority?.(); a.unwatchAuthority = undefined;
    a.permit?.done(false); a.permit = undefined; a.ready(false); a.socket?.destroy(); for (const unwatch of a.removals.splice(0)) unwatch();
    a.capability = '';
    a.shutdown = (async () => {
      const terminate = timer(150, () => { if (!a.childClosed) a.child.kill('SIGTERM'); }), kill = timer(400, () => { if (!a.childClosed) a.child.kill('SIGKILL'); });
      const sent = new Promise<void>(resolve => {
        if (!a.child.connected) { resolve(); return; }
        try { a.child.send({ kind: 'stop' }, () => { resolve(); }); } catch { resolve(); }
      });
      await a.closed; await sent; terminate(); kill(); try { await rm(a.directory, { recursive: true, force: true }); } catch { cleanupFailed = true; }
      if (agent === a) agent = undefined;
    })();
    if (a.child.pid !== undefined) { try { (selected.onRetire as HostedApplicationOptions['onRetire'])?.(Object.freeze({ pid: a.child.pid, epoch: a.epoch })); } catch { /* retirement already fenced */ } }
    return a.shutdown;
  }
  async function stop() { generation++; const existing = agent; if (existing) await retire(existing); if (startDone) await startDone; if (rawDone) await rawDone; }
  const removeOwner = watch(owner, () => { terminal = true; void stop(); });
  async function start(raw: Readonly<{ purpose: string; version: number }>): Promise<HostedApplicationResult<HostedApplicationEpoch>> {
    if (terminal || isAborted(owner)) return failed('closed'); if (startDone || rawDone || agent) return failed('busy');
    if (starts >= 3 || ++attempts > 64) return failed('quota');
    let finish!: () => void; const reserved = new Promise<void>(resolve => { finish = resolve; }); startDone = reserved;
    const turn = ++generation, epoch = ++sequence; let directory: string | undefined, owned: AgentState | undefined;
    try {
      const value = fields(raw, ['purpose', 'version']); if (!value || Object.keys(value).length !== 2 || !identifier(value.purpose) || !Number.isInteger(value.version)) return failed('invalid');
      if (terminal || turn !== generation || isAborted(owner)) return failed('cancelled'); if (value.version !== 1) return failed('version-mismatch');
      const launch = approval('launch', epoch, value.purpose); if (!launch) return failed('denied');
      if (terminal || turn !== generation || isAborted(owner) || isAborted(launch.signal) || now() >= launch.expiresAt) return failed('cancelled');
      directory = await mkdtemp('/tmp/101-ha-'); await chmod(directory, 0o700);
      if (terminal || turn !== generation || isAborted(owner) || isAborted(launch.signal) || now() >= launch.expiresAt) return failed('cancelled');
      const path = directory + '/s', capability = randomBytes(32).toString('hex'), born = now();
      const child = spawn(process.execPath, ['--max-old-space-size=32', '--input-type=module', '--eval', CHILD_SOURCE], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: '/usr/bin:/bin', NODE_ENV: 'production', NODE_OPTIONS: '', NODE_PATH: '' } }); starts++;
      let closeResolve!: () => void, readyResolve!: (ok: boolean) => void;
      const closed = new Promise<void>(resolve => { closeResolve = resolve; }), ready = new Promise<boolean>(resolve => { readyResolve = resolve; });
      owned = { epoch, generation: turn, handle: Object.freeze({}), child, directory, path, capability, launch, born, phase: 'paused', retired: false, childClosed: false, closed, ready: readyResolve, removals: [], lastSequence: 0, lastSourceTime: -1 };
      agent = owned; const a = owned; handles.set(a.handle, a);
      child.once('error', () => { void retire(a); }); child.once('exit', () => { void retire(a); }); child.once('close', () => { a.childClosed = true; closeResolve(); void retire(a); });
      child.on('message', message => {
        if (!base(a)) return;
        const ready = fields(message, ['kind', 'version', 'epoch', 'pid']);
        if (ready && Object.keys(ready).length === 4 && ready.kind === 'ready' && ready.version === 1 && ready.epoch === a.epoch && ready.pid === child.pid) readyResolve(true);
        const permitted = fields(message, ['kind', 'id']); if (permitted && Object.keys(permitted).length === 2 && permitted.kind === 'permitted' && permitted.id === a.permit?.id) a.permit?.done(true);
      });
      a.removals.push(watch(launch.signal, () => { void retire(a); }), timer(Math.min(launch.expiresAt - born, 10000), () => { void retire(a); }));
      const readiness = timer(2500, () => { void retire(a); });
      let sentResolve!: () => void; const sent = new Promise<void>(resolve => { sentResolve = resolve; });
      child.send({ kind: 'init', path, capability, epoch }, error => { if (error) void retire(a); sentResolve(); });
      const initialized = await ready; await sent; readiness();
      if (!initialized || !base(a)) { await retire(a); return failed('unavailable'); }
      try { (selected.onChild as HostedApplicationOptions['onChild'])?.(Object.freeze({ pid: child.pid!, socketPath: path, epoch, codeSha256: HOSTED_APPLICATION_SOURCE_SHA256 })); } catch { await retire(a); return failed('unavailable'); }
      if (!base(a)) { await retire(a); return failed('cancelled'); } return good(a.handle);
    } catch { if (owned) await retire(owned); return failed('unavailable'); }
    finally { if (directory && !owned) { try { await rm(directory, { recursive: true, force: true }); } catch { cleanupFailed = true; } } if (startDone === reserved) startDone = undefined; finish(); }
  }
  async function operation(handle: HostedApplicationEpoch, action: Exclude<HostedApplicationApprovalRequest['action'], 'launch'>, payload: unknown, raw: unknown, lifecycle = false): Promise<HostedApplicationResult<{ reply: NativeReply; grant: Approved; signal: AbortSignal }>> {
    if (terminal || isAborted(owner)) return failed('closed'); if (rawDone || startDone) return failed('busy');
    if (operations >= 32 || ++attempts > 64) return failed('quota');
    let finish!: () => void; const reserved = new Promise<void>(resolve => { finish = resolve; }); rawDone = reserved;
    let a: AgentState | undefined, socket: Socket | undefined, issued = false; const cancellation: { reason: HostedApplicationFailure } = { reason: 'cancelled' }; const removals: (() => void)[] = [];
    try {
      a = handle && typeof handle === 'object' ? handles.get(handle) : undefined;
      if (!a || !base(a) || !lifecycle && !active(a)) return failed('denied'); const owned = a;
      const value = fields(raw, action === 'input' ? ['purpose', 'signal', 'context'] : ['purpose', 'signal']);
      if (!value || Object.keys(value).length !== (action === 'input' ? 3 : 2) || !identifier(value.purpose) || !actualSignal(value.signal)) return failed('invalid');
      const signal = value.signal;
      let input: Record<string, unknown> | undefined, restored: HostedApplicationState | undefined;
      if (action === 'input') { input = fields(payload, ['x', 'y']); if (!input || Object.keys(input).length !== 2 || !Number.isInteger(input.x) || (input.x as number) < 0 || (input.x as number) > 3 || !Number.isInteger(input.y) || (input.y as number) < 0 || (input.y as number) > 3) return failed('invalid'); }
      if (action === 'stage') { restored = state(payload); if (!restored) return failed('invalid'); }
      let delivery: { signal: AbortSignal; isCurrent: () => boolean } | undefined;
      if (action === 'input') {
        const descriptor = Object.getOwnPropertyDescriptors(value.context as object);
        if (!descriptor.signal || !('value' in descriptor.signal) || !actualSignal(descriptor.signal.value) || !descriptor.isCurrent || !('value' in descriptor.isCurrent) || typeof descriptor.isCurrent.value !== 'function') return failed('invalid');
        delivery = { signal: descriptor.signal.value, isCurrent: descriptor.isCurrent.value.bind(value.context) };
      }
      const grant = approval(action, a.epoch, value.purpose); if (!grant) return failed('denied');
      const still = () => {
        if (now() >= grant.expiresAt) { cancellation.reason = 'expired'; return false; }
        if (!base(owned) || isAborted(signal) || isAborted(grant.signal) || now() >= grant.expiresAt || !lifecycle && !active(owned)) return false;
        if (delivery) { let current = false; try { current = delivery.isCurrent(); } catch { /* fail closed */ } if (!current || isAborted(delivery.signal)) return false; }
        return base(owned) && !isAborted(signal) && !isAborted(grant.signal) && now() < grant.expiresAt && (lifecycle || active(owned));
      };
      if (!still()) return failed(cancellation.reason);
      removals.push(watch(signal, () => { void retire(owned); }), watch(grant.signal, () => { void retire(owned); }), timer(Math.min(2500, grant.expiresAt - now()), () => { cancellation.reason = 'expired'; void retire(owned); }));
      if (delivery) removals.push(watch(delivery.signal, () => { void retire(owned); }));
      if (!still()) return failed(cancellation.reason);
      const id = randomBytes(16).toString('hex'); let permitResolve!: (ok: boolean) => void, sentResolve!: () => void;
      const permitted = new Promise<boolean>(resolve => { permitResolve = resolve; }), sent = new Promise<void>(resolve => { sentResolve = resolve; }); owned.permit = { id, done: permitResolve };
      owned.child.send({ kind: 'permit', id, action }, error => { if (error) void retire(owned); sentResolve(); });
      const allowed = await permitted; await sent; owned.permit = undefined;
      if (!allowed || !still()) { if (owned.retired) await retire(owned); return failed(cancellation.reason); }
      socket = createConnection(owned.path); owned.socket = socket;
      let closeResolve!: () => void, writeResolve!: () => void, wrote = false, size = 0, chunks = 0, receivedAt = NaN;
      const closed = new Promise<void>(resolve => { closeResolve = resolve; }), write = new Promise<void>(resolve => { writeResolve = resolve; }); const buffers: Buffer[] = [];
      socket.on('error', () => { void retire(owned); }); socket.once('close', () => { closeResolve(); if (!wrote) writeResolve(); });
      socket.once('connect', () => {
        if (!still()) { socket!.destroy(); return; }
        const frame = JSON.stringify({ version: 1, epoch: owned.epoch, capability: owned.capability, id, action, ...(input ? { target: input } : {}), ...(restored ? { state: restored } : {}) }) + '\n';
        issued = true; operations++; if (action === 'input') inputs++; wrote = true; socket!.end(frame, () => { writeResolve(); });
      });
      socket.on('data', chunk => { size += chunk.byteLength; if (size > 4096 || ++chunks > 64) { void retire(owned); return; } receivedAt = now(); buffers.push(Buffer.from(chunk)); });
      await closed; await write; if (owned.socket === socket) owned.socket = undefined;
      if (!still()) { if (owned.retired) await retire(owned); return failed(cancellation.reason, issued && action === 'input'); }
      let envelope: Record<string, unknown> | undefined; try { envelope = fields(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(buffers, size))), ['body', 'mac']); } catch { /* fixed failure below */ }
      const body = envelope && fields(envelope.body, ['version', 'epoch', 'pid', 'id', 'action', 'sequence', 'state', 'pixels', 'at', 'clockId', 'quality']);
      const parsedState = body && state(body.state), pixels = body?.pixels;
      if (!envelope || Object.keys(envelope).length !== 2 || typeof envelope.mac !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.mac) || !timingSafeEqual(Buffer.from(envelope.mac, 'hex'), createHmac('sha256', owned.capability).update(JSON.stringify(envelope.body)).digest()) || !body || Object.keys(body).length !== 11 || body.version !== 1 || body.epoch !== owned.epoch || body.pid !== owned.child.pid || body.id !== id || body.action !== action || !Number.isInteger(body.sequence) || (body.sequence as number) <= owned.lastSequence || (body.sequence as number) > 32 || !parsedState || !Array.isArray(pixels) || pixels.length !== (action === 'frame' ? 64 : 0) || pixels.some(pixel => !Number.isInteger(pixel) || pixel < 0 || pixel > 255) || typeof body.at !== 'number' || !Number.isFinite(body.at) || body.at < owned.lastSourceTime || body.clockId !== `hosted-raster:${owned.child.pid}:${owned.epoch}` || body.quality !== 'valid' || !Number.isFinite(receivedAt)) { await retire(owned); return failed('unavailable', issued && action === 'input'); }
      if (!still()) return failed(cancellation.reason, issued && action === 'input');
      owned.lastSequence = body.sequence as number; owned.lastSourceTime = body.at;
      return good({ reply: { state: parsedState, pixels: Object.freeze(pixels.slice()), sequence: body.sequence as number, at: body.at, clockId: body.clockId as string, receivedAt }, grant, signal });
    } catch { if (a) await retire(a); return failed(cancellation.reason === 'expired' ? 'expired' : 'unavailable', issued && action === 'input'); }
    finally { for (const unwatch of removals) unwatch(); if (socket && !socket.closed) { socket.destroy(); await new Promise<void>(resolve => socket!.once('close', () => resolve())); } if (rawDone === reserved) rawDone = undefined; finish(); }
  }
  const host: HandoffHost = Object.freeze({ id: selected.providerId as string, assets: Object.freeze([]),
    async pause(epoch: HandoffEpoch, signal: AbortSignal): Promise<JsonValue> {
      if (lifecycle) throw new Error('Application unavailable');
      const reservation = { epoch, generation }; lifecycle = reservation;
      try {
        const a = agent; if (!token(epoch) || !a || a.authority !== epoch || !actualSignal(signal) || !base(a) || generation !== reservation.generation) throw new Error('Application unavailable');
        // The old handoff signal is intentionally already aborted. It cannot
        // dispatch input; the new transfer signal only permits quiescence.
        a.phase = 'paused'; a.latest = undefined; if (rawDone) await rawDone;
        if (!base(a) || a.authority !== epoch || generation !== reservation.generation || isAborted(signal)) throw new Error('Application unavailable');
        const result = await operation(a.handle, 'pause', undefined, { purpose: 'handoff-pause', signal }, true);
        if (!result.ok || a.authority !== epoch || isAborted(signal)) throw new Error('Application unavailable'); return { ...result.value.reply.state };
      } finally { if (lifecycle === reservation) lifecycle = undefined; }
    },
    async stage(next: JsonValue, epoch: HandoffEpoch) {
      if (lifecycle) throw new Error('Application unavailable');
      const reservation = { epoch, generation }; lifecycle = reservation;
      try {
        if (!token(epoch) || isAborted(epoch.signal) || !state(next) || terminal || generation !== reservation.generation) throw new Error('Application unavailable');
        if (!agent) { const launched = await start({ purpose: 'handoff-stage', version: 1 }); if (!launched.ok) throw new Error('Application unavailable'); }
        const a = agent!; a.authority = epoch;
        if (!base(a) || a.phase !== 'paused' || isAborted(epoch.signal)) { await retire(a); throw new Error('Application unavailable'); }
        const staged = await operation(a.handle, 'stage', next, { purpose: 'handoff-stage', signal: epoch.signal }, true); if (!staged.ok || isAborted(epoch.signal)) { await retire(a); throw new Error('Application unavailable'); }
      } finally { if (lifecycle === reservation) lifecycle = undefined; }
    },
    async resume(epoch: HandoffEpoch) {
      if (lifecycle) throw new Error('Application unavailable');
      const reservation = { epoch, generation }; lifecycle = reservation;
      try {
        if (!token(epoch) || isAborted(epoch.signal) || !epoch.isCurrent() || terminal || generation !== reservation.generation || isAborted(epoch.signal)) throw new Error('Application unavailable');
        // A missing source without captured/restaged state cannot truthfully
        // recover by launching the default state. Cold launch is explicit.
        if (!agent) throw new Error('Application unavailable');
        const a = agent; a.authority = epoch;
        if (!base(a) || isAborted(epoch.signal) || !epoch.isCurrent() || !base(a) || isAborted(epoch.signal)) { await retire(a); throw new Error('Application unavailable'); }
        const resumed = await operation(a.handle, 'resume', undefined, { purpose: 'handoff-resume', signal: epoch.signal }, true);
        if (!resumed.ok || !base(a) || isAborted(epoch.signal) || !epoch.isCurrent() || !base(a) || isAborted(epoch.signal)) { await retire(a); throw new Error('Application unavailable'); }
        a.phase = 'active'; a.unwatchAuthority?.(); a.unwatchAuthority = watch(epoch.signal, () => { if (a.authority === epoch) { a.phase = 'paused'; a.latest = undefined; } });
        if (!active(a)) { a.phase = 'paused'; throw new Error('Application unavailable'); }
      } finally { if (lifecycle === reservation) lifecycle = undefined; }
    },
    async stop(epoch: HandoffEpoch) { const a = agent; if (lifecycle?.epoch === epoch) await stop(); else if (a?.authority === epoch) { await retire(a); if (rawDone) await rawDone; } },
    async abort(epoch: HandoffEpoch) { const a = agent; if (lifecycle?.epoch === epoch) await stop(); else if (a?.authority === epoch) { await retire(a); if (rawDone) await rawDone; } },
  });
  function currentFrame(handle: HostedApplicationEpoch): HostedApplicationFrame | undefined {
    const a = handle && typeof handle === 'object' ? handles.get(handle) : undefined; if (!a || !active(a) || !a.latest) return;
    const latest = a.latest; if (isAborted(latest.signal) || isAborted(latest.grant.signal) || now() >= latest.grant.expiresAt || now() - latest.value.receivedAt >= HOSTED_APPLICATION_LIMITS.frameAgeMs) { a.latest = undefined; return; }
    if (active(a) && a.latest === latest && !isAborted(latest.signal) && !isAborted(latest.grant.signal)) return latest.value;
  }
  return Object.freeze({ start, handoffHost: () => host, epoch: () => agent && base(agent) ? agent.handle : undefined, currentFrame,
    async input(epoch: HostedApplicationEpoch, target: Readonly<{ x: number; y: number }>, request: Readonly<{ purpose: string; signal: AbortSignal; context: DeliveryContext }>) {
      const result = await operation(epoch, 'input', target, request); return result.ok ? good(Object.freeze({ revision: result.value.reply.state.revision })) : result;
    },
    async frame(epoch: HostedApplicationEpoch, request: Readonly<{ purpose: string; signal: AbortSignal }>) {
      const result = await operation(epoch, 'frame', undefined, request); if (!result.ok) return result;
      const a = handles.get(epoch as object); if (!a || !active(a) || isAborted(result.value.signal) || isAborted(result.value.grant.signal) || now() >= result.value.grant.expiresAt) return failed('cancelled');
      const reply = result.value.reply, value: HostedApplicationFrame = Object.freeze({ state: reply.state, pixels: reply.pixels, sequence: reply.sequence, providerEpoch: a.epoch,
        sourceTime: Object.freeze({ clockId: reply.clockId, at: reply.at }), receivedAt: reply.receivedAt, receiptClockId, quality: 'valid' });
      a.latest = { value, grant: result.value.grant, signal: result.value.signal }; if (currentFrame(epoch) !== value) return failed('cancelled'); return good(value);
    },
    stop, async close() { terminal = true; removeOwner(); await stop(); }, status() {
      return Object.freeze({ profile: HOSTED_APPLICATION_PROFILE, phase: terminal ? 'closed' : startDone ? 'starting' : agent ? agent.retired ? 'retiring' : agent.phase : 'idle',
        starts, attempts, operations, inputs, nativeChildren: agent && !agent.childClosed ? 1 : 0, nativePending: Number(rawDone !== undefined), timers: timers.size,
        cleanupVerified: !cleanupFailed && !agent && !startDone && !rawDone && timers.size === 0 });
    } });
}
