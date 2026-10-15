import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';

export const SCOPED_AGENT_IPC_PROFILE = 'private-node-agent-rss/1' as const;
export const SCOPED_AGENT_IPC_LIMITS = Object.freeze({ frameBytes: 4096, totalBytes: 65536, pending: 1,
  nativeClients: 2, connectionAttempts: 64, operations: 32, starts: 3, deadlineMs: 2500, lifetimeMs: 10000,
  terminateMs: 150, killMs: 400 });
export type AgentIpcFailure = 'invalid' | 'denied' | 'busy' | 'closed' | 'expired' | 'version-mismatch' | 'unavailable' | 'cancelled' | 'quota';
export type AgentIpcResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: AgentIpcFailure; issued?: boolean; uncertain?: boolean }>;
export type AgentIpcEpoch = Readonly<{ readonly agentIpcEpoch?: never }>;
export interface AgentIpcApprovalRequest {
  readonly action: 'register' | 'read'; readonly ownerId: string; readonly agentId: string;
  readonly epoch: number; readonly resourceId: 'rss'; readonly operation: 'read'; readonly purpose: string; readonly version: number;
}
/** expiresAt is in the host performance.now() domain, never the child clock. */
export interface AgentIpcApproval { readonly request: AgentIpcApprovalRequest; readonly signal: AbortSignal; readonly expiresAt: number }
export interface AgentIpcObservation { readonly pid: number; readonly socketPath: string; readonly epoch: number }
export interface ScopedAgentIpcOptions {
  readonly ownerId: string; readonly signal: AbortSignal;
  readonly authorizeRegistration: (request: AgentIpcApprovalRequest) => AgentIpcApproval | undefined;
  readonly authorizeRead: (request: AgentIpcApprovalRequest) => AgentIpcApproval | undefined;
  /** Trusted host diagnostics only; this does not receive a capability or grant. */
  readonly onAgent?: (observation: Readonly<AgentIpcObservation>) => void;
  /** Called once after retirement is reserved and admission is invalidated. */
  readonly onRetire?: (observation: Readonly<Pick<AgentIpcObservation, 'pid' | 'epoch'>>) => void;
}
export interface AgentIpcRssSample {
  readonly rssBytes: number; readonly sequence: number; readonly quality: 'valid';
  readonly sourceTime: Readonly<{ clockId: string; at: number }>; readonly receiptClockId: string; readonly receivedAt: number;
}
export interface ScopedAgentIpc {
  start(request: Readonly<{ purpose: string; version: number }>): Promise<AgentIpcResult<AgentIpcEpoch>>;
  readRss(epoch: AgentIpcEpoch, request: Readonly<{ purpose: string; signal: AbortSignal }>): Promise<AgentIpcResult<AgentIpcRssSample>>;
  stop(): Promise<void>; close(): Promise<void>;
  status(): Readonly<{ profile: typeof SCOPED_AGENT_IPC_PROFILE; phase: 'idle' | 'starting' | 'ready' | 'retiring' | 'closed';
    starts: number; attempts: number; reads: number; nativeChildren: number; nativePending: number; timers: number; cleanupVerified: boolean }>;
}

// Fixed reviewed program. Caller input cannot select executable/source/paths.
// Capability and one-use permits arrive only on the inherited private IPC fd.
const CHILD_SOURCE = String.raw`
import { createServer } from 'node:net';
import { chmod, unlink } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
const frameLimit=4096,totalLimit=65536; let init,server,closing=false,sequence=0,bytes=0,attempts=0,permit;
const sockets=new Set(); const lifetime=setTimeout(()=>stop(),10000);
function closed(o,keys){return o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k));}
function same(a,b){if(typeof a!=='string'||typeof b!=='string'||!/^[a-f0-9]{64}$/.test(a)||!/^[a-f0-9]{64}$/.test(b))return false;return timingSafeEqual(Buffer.from(a),Buffer.from(b));}
async function stop(){if(closing)return;closing=true;permit=undefined;clearTimeout(lifetime);for(const s of sockets)s.destroy();
  if(server)await new Promise(r=>server.close(r));if(init)await unlink(init.path).catch(()=>{});if(process.connected)process.disconnect();process.exit(0);}
process.on('disconnect',()=>void stop());
process.on('message',async m=>{
  if(closing)return;
  if(!init){
    if(!closed(m,['kind','path','capability','epoch'])||m.kind!=='init'||typeof m.path!=='string'||!/^\/tmp\/101-ai-[A-Za-z0-9]+\/s$/.test(m.path)||
      typeof m.capability!=='string'||!/^[a-f0-9]{64}$/.test(m.capability)||!Number.isSafeInteger(m.epoch)||m.epoch<1)return void stop();
    init=m;
    server=createServer({allowHalfOpen:true},s=>{
      if(closing||sockets.size>=2||++attempts>64){s.destroy();return;}sockets.add(s);let chunks=[],size=0,turns=0,finished=false;
      s.setTimeout(2500,()=>s.destroy());s.on('error',()=>{});s.on('close',()=>sockets.delete(s));
      function deny(){if(finished)return;finished=true;s.end(JSON.stringify({ok:false,reason:'denied'})+'\n',()=>s.destroy());}
      s.on('data',c=>{
        if(finished){s.destroy();return;}size+=c.byteLength;bytes+=c.byteLength;if(size>frameLimit||bytes>totalLimit||++turns>64){deny();return;}
        chunks.push(c);if(!c.includes(10))return;const raw=Buffer.concat(chunks,size);chunks=[];
        let m;try{const text=new TextDecoder('utf-8',{fatal:true}).decode(raw);if(!text.endsWith('\n')||text.slice(0,-1).includes('\n'))return deny();m=JSON.parse(text);}catch{return deny();}
        if(!closed(m,['version','epoch','capability','action','id'])||m.version!==1||m.epoch!==init.epoch||m.action!=='read-rss'||
          typeof m.id!=='string'||!same(m.capability,init.capability)||m.id!==permit||sequence>=32)return deny();
        permit=undefined;finished=true;
        // Authentication/version/one-use permit checks precede the actual read.
        const at=performance.now(),rssBytes=process.memoryUsage().rss;sequence++;
        s.end(JSON.stringify({ok:true,version:1,epoch:init.epoch,id:m.id,rssBytes,sequence,at,
          clockId:'agent-rss:'+process.pid+':'+init.epoch,quality:'valid'})+'\n');
      });s.on('end',()=>{if(!finished)deny();});
    });
    server.on('error',()=>void stop());
    server.listen(init.path,async()=>{try{await chmod(init.path,0o600);if(closing)return;process.send({kind:'ready',version:1,epoch:init.epoch,pid:process.pid});}catch{void stop();}});
    return;
  }
  if(closed(m,['kind','id'])&&m.kind==='permit'&&typeof m.id==='string'&&/^[a-f0-9]{32}$/.test(m.id)&&sequence<32){
    permit=m.id;process.send({kind:'permitted',id:m.id});return;
  }
  if(closed(m,['kind'])&&m.kind==='stop')void stop();
});
`;
export const SCOPED_AGENT_IPC_SOURCE_SHA256 = createHash('sha256').update(CHILD_SOURCE).digest('hex');
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const addListener = EventTarget.prototype.addEventListener, removeListener = EventTarget.prototype.removeEventListener;
const isAborted = (signal: AbortSignal) => Reflect.apply(abortedGetter, signal, []) as boolean;
function actualSignal(value: unknown): value is AbortSignal { try { isAborted(value as AbortSignal); return true; } catch { return false; } }
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !keys.includes(key))) return;
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, descriptor] of Object.entries(descriptors)) { if (!('value' in descriptor)) return; result[key] = descriptor.value; }
    return result;
  } catch { return; }
}
function identifier(value: unknown, max = 80): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9:._ /-]*$/.test(value); }
function failed<T = never>(reason: AgentIpcFailure, issued = false): AgentIpcResult<T> {
  return Object.freeze({ ok: false, reason, ...(issued ? { issued: true, uncertain: true } : {}) });
}
interface Approved { signal: AbortSignal; expiresAt: number }
interface Agent {
  epoch: number; generation: number; agentId: string; handle: AgentIpcEpoch; child: ChildProcess; directory: string;
  path: string; capability: string; registration: Approved; born: number; retired: boolean; childClosed: boolean;
  socket?: Socket; shutdown?: Promise<void>; closed: Promise<void>; removers: (() => void)[]; ready: (value: boolean) => void;
  permit?: { id: string; done: (value: boolean) => void };
}

/** Local same-user capability boundary; not an account/OS sandbox. Native work
 * already issued can complete before revocation reaches the child. Revocation
 * immediately fences outputs and then awaits actual socket/child settlement. */
export function createScopedAgentIpc(input: ScopedAgentIpcOptions): ScopedAgentIpc {
  const option = fields(input, ['ownerId', 'signal', 'authorizeRegistration', 'authorizeRead', 'onAgent', 'onRetire']);
  if (!option || !identifier(option.ownerId, 64) || !actualSignal(option.signal) ||
    typeof option.authorizeRegistration !== 'function' || typeof option.authorizeRead !== 'function' ||
    (option.onAgent !== undefined && typeof option.onAgent !== 'function') ||
    (option.onRetire !== undefined && typeof option.onRetire !== 'function')) throw new TypeError('Invalid agent IPC options');
  const ownerId = option.ownerId, ownerSignal = option.signal;
  const authorizeRegistration = option.authorizeRegistration as ScopedAgentIpcOptions['authorizeRegistration'];
  const authorizeRead = option.authorizeRead as ScopedAgentIpcOptions['authorizeRead'];
  const onAgent = option.onAgent as ScopedAgentIpcOptions['onAgent'];
  const onRetire = option.onRetire as ScopedAgentIpcOptions['onRetire'];
  const timers = new Set<ReturnType<typeof setTimeout>>(), handles = new WeakMap<object, Agent>();
  const receiptClockId = 'agent-host:' + process.pid + ':' + randomBytes(8).toString('hex');
  let generation = 0, epoch = 0, starts = 0, attempts = 0, reads = 0, nativePending = 0;
  let terminal = isAborted(ownerSignal), starting = false, agent: Agent | undefined, startWork: Promise<AgentIpcResult<AgentIpcEpoch>> | undefined;
  let cleanupFailed = false, rawDone: Promise<void> | undefined;
  function timer(delay: number, callback: () => void) {
    const id = setTimeout(() => { timers.delete(id); callback(); }, Math.max(0, delay)); timers.add(id);
    return () => { clearTimeout(id); timers.delete(id); };
  }
  function watch(signal: AbortSignal, callback: () => void) {
    Reflect.apply(addListener, signal, ['abort', callback, { once: true }]);
    return () => Reflect.apply(removeListener, signal, ['abort', callback]);
  }
  function approved(value: unknown, request: AgentIpcApprovalRequest): Approved | undefined {
    const grant = fields(value, ['request', 'signal', 'expiresAt']), now = performance.now();
    if (!grant || grant.request !== request || !actualSignal(grant.signal) || isAborted(grant.signal) ||
      typeof grant.expiresAt !== 'number' || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= now ||
      grant.expiresAt > now + SCOPED_AGENT_IPC_LIMITS.lifetimeMs) return;
    return { signal: grant.signal, expiresAt: grant.expiresAt };
  }
  function current(a: Agent) {
    return !terminal && agent === a && !a.retired && a.generation === generation && !a.childClosed && !isAborted(ownerSignal) &&
      !isAborted(a.registration.signal) && performance.now() < a.registration.expiresAt && performance.now() < a.born + SCOPED_AGENT_IPC_LIMITS.lifetimeMs;
  }
  function retire(a: Agent) {
    if (a.shutdown) return a.shutdown;
    a.retired = true; a.permit?.done(false); a.permit = undefined; a.socket?.destroy(); a.ready(false);
    for (const remove of a.removers.splice(0)) remove();
    a.capability = ''; // no capability is persisted or exposed to diagnostics
    a.shutdown = (async () => {
      const terminate = timer(SCOPED_AGENT_IPC_LIMITS.terminateMs, () => { if (!a.childClosed) a.child.kill('SIGTERM'); });
      const kill = timer(SCOPED_AGENT_IPC_LIMITS.killMs, () => { if (!a.childClosed) a.child.kill('SIGKILL'); });
      if (a.child.connected) a.child.send({ kind: 'stop' }, () => {});
      await a.closed; terminate(); kill();
      try { await rm(a.directory, { recursive: true, force: true }); } catch { cleanupFailed = true; }
      if (agent === a) agent = undefined;
    })();
    if (a.child.pid !== undefined) { try { onRetire?.(Object.freeze({ pid: a.child.pid, epoch: a.epoch })); } catch { /* retirement remains reserved */ } }
    return a.shutdown;
  }
  async function stop() {
    generation++;
    const existing = agent; if (existing) await retire(existing);
    if (startWork) await startWork;
    if (rawDone) await rawDone;
  }
  const removeOwner = watch(ownerSignal, () => { terminal = true; void stop(); });
  async function runStart(raw: Readonly<{ purpose: string; version: number }>): Promise<AgentIpcResult<AgentIpcEpoch>> {
    const selected = fields(raw, ['purpose', 'version']);
    if (!selected || !identifier(selected.purpose) || !Number.isSafeInteger(selected.version) || (selected.version as number) < 1 || (selected.version as number) > 16) return failed('invalid');
    if (terminal || isAborted(ownerSignal)) return failed('closed');
    if (starting || agent || nativePending) return failed('busy');
    if (starts >= SCOPED_AGENT_IPC_LIMITS.starts || ++attempts > SCOPED_AGENT_IPC_LIMITS.connectionAttempts) return failed('quota');
    starting = true; const turn = ++generation, thisEpoch = ++epoch, agentId = 'agent:' + randomBytes(8).toString('hex');
    let directory: string | undefined, owned: Agent | undefined;
    try {
      const request: AgentIpcApprovalRequest = Object.freeze({ action: 'register', ownerId, agentId, epoch: thisEpoch,
        resourceId: 'rss', operation: 'read', purpose: selected.purpose, version: selected.version as number });
      let registration: Approved | undefined;
      try { registration = approved(authorizeRegistration(request), request); } catch { return failed('denied'); }
      if (!registration) return failed('denied');
      if (terminal || turn !== generation || isAborted(ownerSignal) || isAborted(registration.signal)) return failed('cancelled');
      directory = await mkdtemp('/tmp/101-ai-'); await chmod(directory, 0o700);
      if (terminal || turn !== generation || isAborted(ownerSignal) || isAborted(registration.signal) || performance.now() >= registration.expiresAt) return failed('cancelled');
      const path = directory + '/s', capability = randomBytes(32).toString('hex'), born = performance.now();
      const startupEnvironment = process.platform === 'darwin' ? { __CF_USER_TEXT_ENCODING: `0x${process.getuid!().toString(16).toUpperCase()}:0:0` } : {};
      const child = spawn(process.execPath, ['--max-old-space-size=32', '--input-type=module', '--eval', CHILD_SOURCE], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: '/usr/bin:/bin', NODE_ENV: 'production', NODE_OPTIONS: '', NODE_PATH: '', ...startupEnvironment } });
      starts++;
      let resolveClosed!: () => void, resolveReady!: (value: boolean) => void;
      const closed = new Promise<void>(resolve => { resolveClosed = resolve; }), ready = new Promise<boolean>(resolve => { resolveReady = resolve; });
      owned = { epoch: thisEpoch, generation: turn, agentId, handle: Object.freeze({}), child, directory, path, capability,
        registration, born, retired: false, childClosed: false, closed, ready: resolveReady, removers: [] };
      agent = owned; const a = owned; handles.set(a.handle, a);
      child.once('error', () => { resolveReady(false); void retire(a); });
      child.once('exit', () => { void retire(a); });
      child.once('close', () => { a.childClosed = true; resolveClosed(); void retire(a); });
      child.on('message', message => {
        if (!current(a)) return;
        const frame = fields(message, ['kind', 'version', 'epoch', 'pid', 'id']);
        if (frame?.kind === 'ready' && Object.keys(frame).length === 4 && frame.version === 1 && frame.epoch === a.epoch && frame.pid === child.pid) resolveReady(true);
        else if (frame?.kind === 'permitted' && Object.keys(frame).length === 2 && frame.id === a.permit?.id) a.permit?.done(true);
      });
      a.removers.push(watch(registration.signal, () => { void retire(a); }),
        timer(Math.min(registration.expiresAt - born, SCOPED_AGENT_IPC_LIMITS.lifetimeMs), () => { void retire(a); }));
      const readyDeadline = timer(SCOPED_AGENT_IPC_LIMITS.deadlineMs, () => { resolveReady(false); void retire(a); });
      child.send({ kind: 'init', path, capability, epoch: a.epoch }, error => { if (error) { resolveReady(false); void retire(a); } });
      const initialized = await ready; readyDeadline();
      if (!initialized || !current(a)) { await retire(a); return failed('unavailable'); }
      if (selected.version !== 1) { await retire(a); return failed('version-mismatch'); }
      try { onAgent?.(Object.freeze({ pid: child.pid!, socketPath: path, epoch: a.epoch })); } catch { await retire(a); return failed('unavailable'); }
      if (!current(a)) { await retire(a); return failed('cancelled'); }
      return Object.freeze({ ok: true, value: a.handle });
    } catch { if (owned) await retire(owned); return failed('unavailable'); }
    finally {
      starting = false;
      if (directory && !owned) { try { await rm(directory, { recursive: true, force: true }); } catch { cleanupFailed = true; } }
    }
  }
  function start(request: Readonly<{ purpose: string; version: number }>) {
    const wasStarting = starting, work = runStart(request);
    if (!wasStarting && starting) { startWork = work; void work.finally(() => { if (startWork === work) startWork = undefined; }); }
    return work;
  }
  async function readRss(handle: AgentIpcEpoch, raw: Readonly<{ purpose: string; signal: AbortSignal }>): Promise<AgentIpcResult<AgentIpcRssSample>> {
    const selected = fields(raw, ['purpose', 'signal']);
    if (!selected || !identifier(selected.purpose) || !actualSignal(selected.signal)) return failed('invalid');
    const signal = selected.signal;
    if (terminal || isAborted(ownerSignal)) return failed('closed');
    const a = typeof handle === 'object' && handle !== null ? handles.get(handle) : undefined;
    if (!a || !current(a)) return failed('denied');
    if (nativePending) return failed('busy');
    if (++attempts > SCOPED_AGENT_IPC_LIMITS.connectionAttempts || reads >= SCOPED_AGENT_IPC_LIMITS.operations) return failed('quota');
    nativePending = 1; let releaseRaw!: () => void;
    const thisRawDone = new Promise<void>(resolve => { releaseRaw = resolve; }); rawDone = thisRawDone;
    let issued = false, socket: Socket | undefined, grant: Approved | undefined;
    const removers: (() => void)[] = [];
    const stillApproved = () => current(a) && !!grant && !isAborted(signal) && !isAborted(grant.signal) && performance.now() < grant.expiresAt;
    try {
      if (isAborted(signal)) return failed('cancelled');
      const request: AgentIpcApprovalRequest = Object.freeze({ action: 'read', ownerId, agentId: a.agentId, epoch: a.epoch,
        resourceId: 'rss', operation: 'read', purpose: selected.purpose, version: 1 });
      try { grant = approved(authorizeRead(request), request); } catch { return failed('denied'); }
      if (!grant) return failed('denied');
      if (!stillApproved()) return failed('cancelled');
      removers.push(watch(signal, () => { void retire(a); }), watch(grant.signal, () => { void retire(a); }),
        timer(Math.min(grant.expiresAt - performance.now(), SCOPED_AGENT_IPC_LIMITS.deadlineMs), () => { void retire(a); }));
      if (!stillApproved()) return failed('cancelled');
      const id = randomBytes(16).toString('hex');
      let permitResolve!: (value: boolean) => void;
      const permit = new Promise<boolean>(resolve => { permitResolve = resolve; }); a.permit = { id, done: permitResolve };
      const sent = new Promise<void>(resolve => a.child.send({ kind: 'permit', id }, error => { if (error) { permitResolve(false); void retire(a); } resolve(); }));
      issued = true;
      const permitted = await permit; await sent; a.permit = undefined;
      if (!permitted || !stillApproved()) { await retire(a); return failed('cancelled', issued); }
      socket = createConnection(a.path); a.socket = socket;
      let resolveClosed!: () => void, resolveWrite!: () => void;
      const socketClosed = new Promise<void>(resolve => { resolveClosed = resolve; }), writeSettled = new Promise<void>(resolve => { resolveWrite = resolve; });
      let wrote = false, response: unknown, receivedAt: number | undefined, size = 0, turns = 0; const chunks: Buffer[] = [];
      socket.on('error', () => { void retire(a); });
      socket.once('close', () => { resolveClosed(); if (!wrote) resolveWrite(); });
      socket.once('connect', () => {
        if (!stillApproved()) { socket!.destroy(); return; }
        const frame = JSON.stringify({ version: 1, epoch: a.epoch, capability: a.capability, action: 'read-rss', id }) + '\n';
        wrote = true; reads++;
        socket!.end(frame, () => resolveWrite());
      });
      socket.on('data', chunk => {
        size += chunk.byteLength;
        if (size > SCOPED_AGENT_IPC_LIMITS.frameBytes || ++turns > 64) { void retire(a); return; }
        receivedAt = performance.now(); chunks.push(Buffer.from(chunk));
      });
      await socketClosed; await writeSettled;
      if (a.socket === socket) a.socket = undefined;
      if (stillApproved()) { try { response = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); } catch { /* fixed unavailable result below */ } }
      if (!stillApproved()) { await retire(a); return failed('cancelled', issued); }
      const frame = fields(response, ['ok', 'version', 'epoch', 'id', 'rssBytes', 'sequence', 'at', 'clockId', 'quality']);
      if (!frame || Object.keys(frame).length !== 9 || frame.ok !== true || frame.version !== 1 || frame.epoch !== a.epoch || frame.id !== id ||
        !Number.isSafeInteger(frame.rssBytes) || (frame.rssBytes as number) <= 0 || !Number.isSafeInteger(frame.sequence) ||
        (frame.sequence as number) < 1 || (frame.sequence as number) > SCOPED_AGENT_IPC_LIMITS.operations || typeof frame.at !== 'number' || !Number.isFinite(frame.at) || frame.at < 0 ||
        frame.clockId !== `agent-rss:${a.child.pid}:${a.epoch}` || frame.quality !== 'valid' || receivedAt === undefined) { await retire(a); return failed('unavailable', issued); }
      const value: AgentIpcRssSample = Object.freeze({ rssBytes: frame.rssBytes as number, sequence: frame.sequence as number, quality: 'valid',
        sourceTime: Object.freeze({ clockId: frame.clockId as string, at: frame.at }), receiptClockId, receivedAt });
      if (!stillApproved()) { await retire(a); return failed('cancelled', issued); }
      return Object.freeze({ ok: true, value });
    } catch { await retire(a); return failed('unavailable', issued); }
    finally { for (const remove of removers) remove(); nativePending = 0; releaseRaw(); if (rawDone === thisRawDone) rawDone = undefined; }
  }
  return Object.freeze({ start, readRss, stop, async close() { terminal = true; removeOwner(); await stop(); }, status() {
    const cleanupVerified = !cleanupFailed && !starting && !agent && nativePending === 0 && timers.size === 0;
    return Object.freeze({ profile: SCOPED_AGENT_IPC_PROFILE, phase: terminal ? 'closed' : starting ? 'starting' : agent ? agent.retired ? 'retiring' : 'ready' : 'idle',
      starts, attempts, reads, nativeChildren: agent && !agent.childClosed ? 1 : 0, nativePending, timers: timers.size, cleanupVerified });
  } });
}
