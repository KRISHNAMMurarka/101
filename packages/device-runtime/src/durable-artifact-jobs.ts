import { createAssetReference, parseAssetReference, snapshotJson, snapshotResourceBytes, verifyAssetContent } from '@101/device-model';
import type { AssetReference } from '@101/device-model';

export interface ArtifactJobWriteGuard {
  readonly signal?: AbortSignal;
  /** The adapter checks this at the atomic write, not at an earlier read. */
  readonly isCurrent?: () => boolean;
}
/** Compare and replace one owner document in one atomic transaction. Never ignore a supplied guard. */
export interface ArtifactJobStorage {
  read(key: string): Promise<string | undefined>;
  compareAndSwap(key: string, expected: string | undefined, value: string, guard?: ArtifactJobWriteGuard): Promise<boolean>;
}
export interface ArtifactJobRequest {
  readonly idempotencyKey: string;
  readonly applicationId: string;
  readonly profileId: '101:local-artifact';
  readonly profileRevision: 1;
  readonly destinationId: string;
  readonly totalUnits: number;
  readonly input: Readonly<AssetReference>;
}
export type ArtifactJobAction = 'start' | 'restart-reviewed' | 'cancel' | 'read-output' | 'recover-storage-reviewed';
export interface ArtifactJobAuthorization {
  readonly ownerId: string;
  readonly action: ArtifactJobAction;
  readonly request?: ArtifactJobRequest;
}
/** Fresh own data properties only. This object, its callbacks and its deadline are never persisted. */
export interface ArtifactJobGrant {
  readonly expiresAt: number;
  readonly isCurrent: () => boolean;
  readonly signal?: AbortSignal;
}
export type ArtifactJobFailure = 'invalid' | 'corrupt' | 'incompatible' | 'wrong-owner' | 'unavailable' | 'integrity'
  | 'idempotency-conflict' | 'capacity' | 'conflict' | 'denied' | 'not-found' | 'terminal' | 'review-required'
  | 'cancelled' | 'revoked' | 'expired' | 'closed' | 'superseded' | 'incomplete' | 'no-output' | 'invalid-clock';
export type ArtifactJobResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: ArtifactJobFailure }>;
type StoredState = 'accepted' | 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
export interface ArtifactJobAttemptRecord {
  readonly generation: number;
  readonly startedAt: number;
  readonly outcome: 'running' | 'artifact-stored' | 'cancelled' | 'failed' | 'interrupted';
  readonly endedAt?: number;
}
export interface ArtifactJobRecord {
  readonly request: ArtifactJobRequest;
  readonly state: StoredState | 'review-required';
  readonly lastKnownState: StoredState;
  readonly requiresReview: boolean;
  readonly generation: number;
  readonly progress: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly attempts: readonly ArtifactJobAttemptRecord[];
  /** Only retained local bytes establish this evidence; no physical-device effect is implied. */
  readonly evidence: 'none' | 'artifact-stored';
  readonly output?: Readonly<AssetReference>;
}
export interface ArtifactJobDocument {
  readonly version: 1; readonly ownerId: string; readonly revision: number; readonly jobs: readonly ArtifactJobRecord[];
}
export interface ArtifactJobAttempt {
  readonly signal: AbortSignal;
  progress(completedUnits: number): Promise<ArtifactJobResult<ArtifactJobRecord>>;
  commit(outputBytes: Uint8Array): Promise<ArtifactJobResult<ArtifactJobRecord>>;
  fail(): Promise<ArtifactJobResult<ArtifactJobRecord>>;
}
export interface DurableArtifactJobStore {
  readonly key: string;
  submit(request: unknown): Promise<ArtifactJobResult<ArtifactJobRecord>>;
  inspect(): Promise<ArtifactJobResult<ArtifactJobDocument>>;
  start(idempotencyKey: string, inputBytes: Uint8Array): Promise<ArtifactJobResult<ArtifactJobAttempt>>;
  /** The caller obtains a new owner decision first. This never replays work automatically. */
  restartReviewed(idempotencyKey: string, inputBytes: Uint8Array): Promise<ArtifactJobResult<ArtifactJobAttempt>>;
  cancel(idempotencyKey: string): Promise<ArtifactJobResult<ArtifactJobRecord>>;
  readOutput(idempotencyKey: string): Promise<ArtifactJobResult<Readonly<{ reference: AssetReference; bytes: Uint8Array }>>>;
  /** Explicit owner-reviewed loss of unreadable local records, including their retained artifacts. */
  recoverStorageReviewed(): Promise<ArtifactJobResult<ArtifactJobDocument>>;
  /** Authority and signals retire synchronously; the returned promise records owned interruptions. */
  close(): Promise<void>;
}
export interface DurableArtifactJobStoreOptions {
  readonly ownerId: string;
  readonly storage: ArtifactJobStorage;
  readonly now?: () => number;
  readonly authorize: (request: ArtifactJobAuthorization) => ArtifactJobGrant | undefined | Promise<ArtifactJobGrant | undefined>;
}
interface StoredJob {
  request: ArtifactJobRequest; state: StoredState; generation: number; progress: number;
  createdAt: number; updatedAt: number; attempts: readonly ArtifactJobAttemptRecord[];
  output?: Readonly<AssetReference>; artifact?: string;
}
interface StoredDocument { version: 1; ownerId: string; revision: number; jobs: readonly StoredJob[] }
interface Active {
  generation: number; controller: AbortController; grant: ArtifactJobGrant; timer: ReturnType<typeof setTimeout>;
  detach: () => void; reason?: ArtifactJobFailure;
}
const MAX_JOBS = 8, MAX_DOCUMENT_BYTES = 65536, MAX_INPUT_BYTES = 65536, MAX_OUTPUT_BYTES = 4096;
const MAX_UNITS = 64, MAX_ATTEMPTS = 4, MAX_DURATION_MS = 60000, AUTHORIZATION_WAIT_MS = 1000;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const jobKey = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const ok = <T>(value: T): ArtifactJobResult<T> => Object.freeze({ ok: true, value });
const bad = (reason: ArtifactJobFailure): ArtifactJobResult<never> => Object.freeze({ ok: false, reason });
class JobError extends Error {
  readonly reason: ArtifactJobFailure;
  constructor(reason: ArtifactJobFailure) { super(reason); this.reason = reason; }
}
function fail(reason: ArtifactJobFailure): never { throw new JobError(reason); }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('corrupt');
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail('corrupt');
}
function parseRequest(input: unknown): ArtifactJobRequest {
  const value = object(snapshotJson(input));
  exact(value, ['idempotencyKey', 'applicationId', 'profileId', 'profileRevision', 'destinationId', 'totalUnits', 'input']);
  if (!jobKey(value.idempotencyKey) || !identifier(value.applicationId) || value.profileId !== '101:local-artifact' ||
    value.profileRevision !== 1 || !identifier(value.destinationId) || !integer(value.totalUnits) || value.totalUnits < 1 || value.totalUnits > MAX_UNITS) fail('invalid');
  const inputReference = parseAssetReference(value.input);
  if (inputReference.byteLength > MAX_INPUT_BYTES) fail('invalid');
  return Object.freeze({ idempotencyKey: value.idempotencyKey, applicationId: value.applicationId,
    profileId: '101:local-artifact', profileRevision: 1, destinationId: value.destinationId, totalUnits: value.totalUnits, input: inputReference });
}
function sameRequest(left: ArtifactJobRequest, right: ArtifactJobRequest): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function parseAttempt(input: unknown, position: number): ArtifactJobAttemptRecord {
  const value = object(input); exact(value, ['generation', 'startedAt', 'outcome'], ['endedAt']);
  if (value.generation !== position + 1 || !integer(value.startedAt) ||
    !['running', 'artifact-stored', 'cancelled', 'failed', 'interrupted'].includes(value.outcome as string) ||
    (value.outcome === 'running' ? value.endedAt !== undefined : !integer(value.endedAt) || value.endedAt < value.startedAt)) fail('corrupt');
  return Object.freeze({ generation: value.generation as number, startedAt: value.startedAt,
    outcome: value.outcome as ArtifactJobAttemptRecord['outcome'], ...(value.endedAt === undefined ? {} : { endedAt: value.endedAt as number }) });
}
function parseJob(input: unknown): StoredJob {
  const value = object(input); exact(value, ['request', 'state', 'generation', 'progress', 'createdAt', 'updatedAt', 'attempts'], ['output', 'artifact']);
  const request = parseRequest(value.request);
  if (!['accepted', 'running', 'completed', 'cancelled', 'failed', 'interrupted'].includes(value.state as string) ||
    !integer(value.generation) || value.generation > MAX_ATTEMPTS || !integer(value.progress) || value.progress > request.totalUnits ||
    !integer(value.createdAt) || !integer(value.updatedAt) || value.updatedAt < value.createdAt ||
    !Array.isArray(value.attempts) || value.attempts.length !== value.generation) fail('corrupt');
  const attempts = value.attempts.map(parseAttempt), last = attempts.at(-1);
  if (value.state === 'accepted' ? value.generation !== 0 || value.progress !== 0 : value.state !== 'cancelled' && value.state !== 'interrupted' && !last) fail('corrupt');
  if (last && (last.startedAt < value.createdAt || last.startedAt > value.updatedAt ||
    (value.state === 'running' ? last.outcome !== 'running' : last.outcome === 'running') ||
    last.endedAt !== undefined && last.endedAt > value.updatedAt)) fail('corrupt');
  if (last && value.state !== 'cancelled' && last.outcome !== (value.state === 'completed' ? 'artifact-stored' : value.state) ||
    value.state === 'cancelled' && last?.outcome === 'artifact-stored') fail('corrupt');
  if (attempts.some((attempt, index) => attempt.startedAt < (value.createdAt as number) || attempt.startedAt > (value.updatedAt as number) ||
    attempt.endedAt !== undefined && attempt.endedAt > (value.updatedAt as number) ||
    index > 0 && attempt.startedAt < (attempts[index - 1]?.endedAt ?? Number.MAX_SAFE_INTEGER))) fail('corrupt');
  if (attempts.slice(0, -1).some(attempt => attempt.outcome === 'running' || attempt.outcome === 'artifact-stored')) fail('corrupt');
  let output: AssetReference | undefined;
  if (value.state === 'completed') {
    output = parseAssetReference(value.output);
    if (value.progress !== request.totalUnits || last?.outcome !== 'artifact-stored' ||
      output.id !== `artifact:${request.idempotencyKey}` || output.kind !== 'blob' || output.byteLength > MAX_OUTPUT_BYTES ||
      typeof value.artifact !== 'string' || value.artifact.length > Math.ceil(MAX_OUTPUT_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.artifact)) fail('corrupt');
  } else if (value.output !== undefined || value.artifact !== undefined) fail('corrupt');
  return Object.freeze({ request, state: value.state as StoredState, generation: value.generation, progress: value.progress,
    createdAt: value.createdAt, updatedAt: value.updatedAt, attempts: Object.freeze(attempts),
    ...(output ? { output, artifact: value.artifact as string } : {}) });
}
function encodeBytes(bytes: Uint8Array): string {
  let value = ''; for (const byte of bytes) value += String.fromCharCode(byte); return btoa(value);
}
function decodeBytes(encoded: string): Uint8Array {
  try { return Uint8Array.from(atob(encoded), character => character.charCodeAt(0)); } catch { return fail('corrupt'); }
}
function finish(job: StoredJob, state: Exclude<StoredState, 'accepted' | 'running'>, now: number): StoredJob {
  const outcome = state === 'completed' ? 'artifact-stored' : state;
  const attempts = job.attempts.map((attempt, index) => index === job.attempts.length - 1 && attempt.outcome === 'running'
    ? Object.freeze({ ...attempt, outcome, endedAt: Math.max(now, attempt.startedAt) }) : attempt);
  return Object.freeze({ ...job, state, updatedAt: Math.max(job.updatedAt, now), attempts: Object.freeze(attempts) });
}

/** A local retained-artifact profile only: no print, recording, remote submission or automatic job execution. */
export function createDurableArtifactJobStore(options: DurableArtifactJobStoreOptions): DurableArtifactJobStore {
  if (!identifier(options.ownerId) || typeof options.storage?.read !== 'function' || typeof options.storage?.compareAndSwap !== 'function' ||
    typeof options.authorize !== 'function' || options.now !== undefined && typeof options.now !== 'function') throw new TypeError('Invalid artifact job scope');
  const owner = options.ownerId, storage = options.storage, authorize = options.authorize, now = options.now ?? (() => Date.now());
  const key = `101.artifact-jobs:${owner}`, acceptedHere = new Set<string>(), active = new Map<string, Active>(), lifetime = new AbortController();
  let closed = false, highestRevision = 0, previousTime = -Infinity, pendingApprovals = 0, closing: Promise<void> | undefined;
  function time(): number {
    let value: number;
    try { value = now(); } catch { value = NaN; }
    if (!integer(value) || value < previousTime) {
      closed = true; lifetime.abort('invalid-clock');
      for (const [id, entry] of [...active]) void interrupt(id, entry, 'invalid-clock');
      fail('invalid-clock');
    }
    previousTime = value; return value;
  }
  function open(): void { if (closed) fail('closed'); }
  async function attempt<T>(work: () => Promise<ArtifactJobResult<T>>, invalid: ArtifactJobFailure = 'corrupt'): Promise<ArtifactJobResult<T>> {
    try { return await work(); }
    catch (error) {
      if (error instanceof JobError) return bad(error.reason);
      if (error instanceof SyntaxError || error instanceof TypeError || error instanceof Error && error.name === 'DeviceValidationError') return bad(invalid);
      return bad('unavailable');
    }
  }
  async function rawRead(): Promise<string | undefined> {
    try { return await storage.read(key); } catch { return fail('unavailable'); }
  }
  async function read(): Promise<{ raw: string | undefined; document: StoredDocument }> {
    const raw = await rawRead();
    if (raw === undefined) {
      if (highestRevision > 0) fail('corrupt');
      return { raw, document: Object.freeze({ version: 1, ownerId: owner, revision: 0, jobs: Object.freeze([]) }) };
    }
    if (typeof raw !== 'string' || raw.length > MAX_DOCUMENT_BYTES || new TextEncoder().encode(raw).length > MAX_DOCUMENT_BYTES) fail('corrupt');
    const value = object(snapshotJson(JSON.parse(raw)));
    if (value.ownerId !== owner) fail('wrong-owner');
    if (value.version !== 1) fail('incompatible');
    exact(value, ['version', 'ownerId', 'revision', 'jobs']);
    if (!integer(value.revision) || value.revision < highestRevision || !Array.isArray(value.jobs) || value.jobs.length > MAX_JOBS) fail('corrupt');
    const jobs = value.jobs.map(parseJob);
    if (new Set(jobs.map(job => job.request.idempotencyKey)).size !== jobs.length) fail('corrupt');
    for (const job of jobs) if (job.output && !await verifyAssetContent(job.output, decodeBytes(job.artifact!))) fail('integrity');
    highestRevision = Math.max(highestRevision, value.revision);
    return { raw, document: Object.freeze({ version: 1, ownerId: owner, revision: value.revision, jobs: Object.freeze(jobs) }) };
  }
  async function write(raw: string | undefined, document: StoredDocument, guard?: ArtifactJobWriteGuard): Promise<void> {
    if (document.revision >= Number.MAX_SAFE_INTEGER) fail('capacity');
    const encoded = JSON.stringify(snapshotJson({ ...document, revision: document.revision + 1 }));
    if (new TextEncoder().encode(encoded).length > MAX_DOCUMENT_BYTES) fail('capacity');
    let stored: boolean;
    try { stored = await storage.compareAndSwap(key, raw, encoded, guard); } catch { return fail('unavailable'); }
    if (stored !== true) fail('conflict');
    highestRevision = Math.max(highestRevision, document.revision + 1);
  }
  function current(job: StoredJob): boolean { return job.state === 'running' && active.get(job.request.idempotencyKey)?.generation === job.generation; }
  function view(job: StoredJob): ArtifactJobRecord {
    const requiresReview = job.state === 'interrupted' || job.state === 'failed' ||
      (job.state === 'running' && !current(job)) || job.state === 'accepted' && !acceptedHere.has(job.request.idempotencyKey);
    return Object.freeze({ request: job.request,
      state: requiresReview && (job.state === 'running' || job.state === 'accepted') ? 'review-required' : job.state,
      lastKnownState: job.state, requiresReview, generation: job.generation, progress: job.progress,
      createdAt: job.createdAt, updatedAt: job.updatedAt, attempts: job.attempts,
      evidence: job.state === 'completed' ? 'artifact-stored' : 'none', ...(job.output ? { output: job.output } : {}) });
  }
  function documentView(document: StoredDocument): ArtifactJobDocument {
    return Object.freeze({ version: 1, ownerId: owner, revision: document.revision, jobs: Object.freeze(document.jobs.map(view)) });
  }
  function replace(document: StoredDocument, job: StoredJob): StoredDocument {
    return Object.freeze({ ...document, jobs: Object.freeze(document.jobs.map(previous => previous.request.idempotencyKey === job.request.idempotencyKey ? job : previous)) });
  }
  function retire(id: string, entry: Active, reason: ArtifactJobFailure): void {
    entry.reason ??= reason;
    clearTimeout(entry.timer); entry.detach(); entry.controller.abort(entry.reason);
    if (active.get(id) === entry) active.delete(id);
  }
  async function interrupt(id: string, entry: Active, reason: ArtifactJobFailure): Promise<void> {
    retire(id, entry, reason);
    try {
      const stored = await read(), job = stored.document.jobs.find(candidate => candidate.request.idempotencyKey === id);
      if (job?.generation === entry.generation && job.state === 'running')
        await write(stored.raw, replace(stored.document, finish(job, 'interrupted', Math.max(previousTime, 0))));
    } catch { /* A failed journal write remains review-required; no artifact or authority is recreated. */ }
  }
  function grantReason(grant: ArtifactJobGrant): ArtifactJobFailure | undefined {
    if (closed) return 'closed';
    if (grant.signal?.aborted) return 'revoked';
    if (time() >= grant.expiresAt) return 'expired';
    try { if (grant.isCurrent() !== true) return 'revoked'; } catch { return 'revoked'; }
    if (closed) return 'closed';
    if (grant.signal?.aborted) return 'revoked';
    if (time() >= grant.expiresAt) return 'expired';
    return;
  }
  async function approval(action: ArtifactJobAction, request?: ArtifactJobRequest): Promise<ArtifactJobGrant> {
    open(); if (pendingApprovals >= MAX_JOBS) fail('capacity');
    const at = time(), scope = Object.freeze({ ownerId: owner, action, ...(request ? { request } : {}) });
    pendingApprovals++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort!: () => void;
    try {
      const grant = await new Promise<ArtifactJobGrant | undefined>((resolve, reject) => {
        abort = () => reject(new JobError('closed')); lifetime.signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => reject(new JobError('denied')), AUTHORIZATION_WAIT_MS);
        Promise.resolve().then(() => authorize(scope)).then(resolve, () => reject(new JobError('denied')));
      });
      open();
      if (!grant || typeof grant !== 'object') fail('denied');
      let expiry: PropertyDescriptor | undefined, current: PropertyDescriptor | undefined, cancellation: PropertyDescriptor | undefined;
      try {
        expiry = Object.getOwnPropertyDescriptor(grant, 'expiresAt');
        current = Object.getOwnPropertyDescriptor(grant, 'isCurrent');
        cancellation = Object.getOwnPropertyDescriptor(grant, 'signal');
      } catch { return fail('denied'); }
      open();
      if (!expiry || !current || !Object.hasOwn(expiry, 'value') || !Object.hasOwn(current, 'value') ||
        cancellation && !Object.hasOwn(cancellation, 'value')) fail('denied');
      const expiresAt: unknown = expiry.value, isCurrent: unknown = current.value, signal: unknown = cancellation?.value;
      if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= at || expiresAt - at > MAX_DURATION_MS ||
        typeof isCurrent !== 'function' || signal !== undefined && !(signal instanceof AbortSignal)) fail('denied');
      // Capture callbacks and limits once. Later caller mutation cannot extend an attempt.
      const captured: ArtifactJobGrant = Object.freeze({ expiresAt,
        isCurrent: Function.prototype.bind.call(isCurrent, grant) as () => boolean, ...(signal ? { signal } : {}) });
      const reason = grantReason(captured); if (reason) fail(reason);
      return captured;
    } finally { pendingApprovals--; if (timer) clearTimeout(timer); lifetime.signal.removeEventListener('abort', abort); }
  }
  async function ready(id: string, entry: Active): Promise<{ raw: string | undefined; document: StoredDocument; job: StoredJob }> {
    open(); if (entry.reason) fail(entry.reason);
    const reason = grantReason(entry.grant);
    if (reason) { await interrupt(id, entry, reason); fail(reason); }
    const stored = await read(); open();
    if (entry.reason) fail(entry.reason);
    const job = stored.document.jobs.find(candidate => candidate.request.idempotencyKey === id);
    if (!job || job.generation !== entry.generation || job.state !== 'running') {
      retire(id, entry, job?.state === 'cancelled' ? 'cancelled' : 'superseded'); fail(entry.reason!);
    }
    const after = grantReason(entry.grant);
    if (after) { await interrupt(id, entry, after); fail(after); }
    return { ...stored, job };
  }
  function guard(entry: Active): ArtifactJobWriteGuard {
    return Object.freeze({ signal: entry.controller.signal, isCurrent: () => !closed && !entry.reason && !grantReason(entry.grant) });
  }
  async function writeActive(id: string, entry: Active, raw: string | undefined, document: StoredDocument): Promise<void> {
    try { await write(raw, document, guard(entry)); }
    catch (error) {
      if (closed) fail('closed');
      if (entry.reason) fail(entry.reason);
      const reason = grantReason(entry.grant);
      if (reason) { await interrupt(id, entry, reason); fail(reason); }
      if (error instanceof JobError && error.reason === 'conflict') await ready(id, entry);
      if (error instanceof JobError && error.reason === 'unavailable') retire(id, entry, 'unavailable');
      throw error;
    }
  }
  function attemptHandle(id: string, entry: Active): ArtifactJobAttempt {
    return Object.freeze({
      signal: entry.controller.signal,
      progress: (units: number) => attempt(async () => {
        const stored = await ready(id, entry);
        if (!integer(units) || units < stored.job.progress || units > stored.job.request.totalUnits) return bad('invalid');
        if (units === stored.job.progress) return ok(view(stored.job));
        const job = Object.freeze({ ...stored.job, progress: units, updatedAt: time() });
        await writeActive(id, entry, stored.raw, replace(stored.document, job)); return ok(view(job));
      }, 'invalid'),
      commit: (bytes: Uint8Array) => attempt(async () => {
        open(); if (entry.reason) fail(entry.reason);
        const copied = snapshotResourceBytes(bytes); if (copied.byteLength > MAX_OUTPUT_BYTES) return bad('capacity');
        const output = await createAssetReference(`artifact:${id}`, 'blob', copied);
        const stored = await ready(id, entry);
        if (stored.job.progress !== stored.job.request.totalUnits) return bad('incomplete');
        const job = Object.freeze({ ...finish(stored.job, 'completed', time()), output, artifact: encodeBytes(copied) });
        await writeActive(id, entry, stored.raw, replace(stored.document, job));
        retire(id, entry, 'terminal'); return ok(view(job));
      }, 'invalid'),
      fail: () => attempt(async () => {
        const stored = await ready(id, entry), job = finish(stored.job, 'failed', time());
        await writeActive(id, entry, stored.raw, replace(stored.document, job));
        retire(id, entry, 'terminal'); return ok(view(job));
      }),
    });
  }
  async function start(id: string, bytes: Uint8Array, reviewed: boolean): Promise<ArtifactJobResult<ArtifactJobAttempt>> {
    return attempt(async () => {
      open(); if (!jobKey(id)) return bad('invalid');
      const copied = snapshotResourceBytes(bytes); if (copied.byteLength > MAX_INPUT_BYTES) return bad('capacity');
      const stored = await read(), previous = stored.document.jobs.find(job => job.request.idempotencyKey === id);
      if (!previous) return bad('not-found');
      if (previous.state === 'completed' || previous.state === 'cancelled') return bad('terminal');
      if (previous.attempts.length >= MAX_ATTEMPTS) return bad('capacity');
      if (!reviewed && (previous.state !== 'accepted' || !acceptedHere.has(id))) return bad('review-required');
      if (!await verifyAssetContent(previous.request.input, copied)) return bad('integrity');
      open(); const grant = await approval(reviewed ? 'restart-reviewed' : 'start', previous.request), at = time();
      const ended = previous.state === 'running' ? finish(previous, 'interrupted', at) : previous;
      const generation = previous.generation + 1;
      const job = Object.freeze({ ...ended, state: 'running' as const, generation, progress: 0, updatedAt: at,
        attempts: Object.freeze([...ended.attempts, Object.freeze({ generation, startedAt: at, outcome: 'running' as const })]) });
      await write(stored.raw, replace(stored.document, job), { signal: lifetime.signal, isCurrent: () => !closed && !grantReason(grant) });
      open();
      const old = active.get(id); if (old) retire(id, old, 'superseded');
      const controller = new AbortController();
      const entry: Active = { generation, controller, grant,
        timer: setTimeout(() => { void interrupt(id, entry, 'expired'); }, Math.max(0, grant.expiresAt - time())), detach: () => {} };
      const revoke = () => { void interrupt(id, entry, 'revoked'); };
      grant.signal?.addEventListener('abort', revoke, { once: true }); entry.detach = () => grant.signal?.removeEventListener('abort', revoke);
      active.set(id, entry); acceptedHere.delete(id);
      if (grant.signal?.aborted) { await interrupt(id, entry, 'revoked'); return bad('revoked'); }
      return ok(attemptHandle(id, entry));
    }, 'invalid');
  }
  return Object.freeze<DurableArtifactJobStore>({
    key,
    submit: input => attempt(async () => {
      open(); let request: ArtifactJobRequest;
      try { request = parseRequest(input); } catch { return bad('invalid'); }
      const stored = await read(); open();
      const previous = stored.document.jobs.find(job => job.request.idempotencyKey === request.idempotencyKey);
      if (previous) return sameRequest(previous.request, request) ? ok(view(previous)) : bad('idempotency-conflict');
      if (stored.document.jobs.length >= MAX_JOBS) return bad('capacity');
      const at = time(), job: StoredJob = Object.freeze({ request, state: 'accepted', generation: 0, progress: 0,
        createdAt: at, updatedAt: at, attempts: Object.freeze([]) });
      await write(stored.raw, Object.freeze({ ...stored.document, jobs: Object.freeze([...stored.document.jobs, job]) }),
        { signal: lifetime.signal, isCurrent: () => !closed });
      acceptedHere.add(request.idempotencyKey); return ok(view(job));
    }, 'invalid'),
    inspect: () => attempt(async () => { open(); const stored = await read(); open(); return ok(documentView(stored.document)); }),
    start: (id, bytes) => start(id, bytes, false),
    restartReviewed: (id, bytes) => start(id, bytes, true),
    cancel: id => attempt(async () => {
      open(); if (!jobKey(id)) return bad('invalid');
      const stored = await read(), job = stored.document.jobs.find(candidate => candidate.request.idempotencyKey === id);
      if (!job) return bad('not-found');
      if (job.state === 'completed') return bad('terminal');
      if (job.state === 'cancelled') return ok(view(job));
      const grant = await approval('cancel', job.request), entry = active.get(id);
      if (entry) retire(id, entry, 'cancelled');
      const cancelled = finish(job, 'cancelled', time());
      await write(stored.raw, replace(stored.document, cancelled), { signal: lifetime.signal, isCurrent: () => !closed && !grantReason(grant) });
      acceptedHere.delete(id); return ok(view(cancelled));
    }),
    readOutput: id => attempt(async () => {
      open(); if (!jobKey(id)) return bad('invalid');
      const stored = await read(), job = stored.document.jobs.find(candidate => candidate.request.idempotencyKey === id);
      if (!job) return bad('not-found');
      if (!job.output || job.artifact === undefined) return bad('no-output');
      const grant = await approval('read-output', job.request), bytes = decodeBytes(job.artifact);
      if (!await verifyAssetContent(job.output, bytes)) return bad('integrity');
      open(); const reason = grantReason(grant); if (reason) return bad(reason);
      return ok(Object.freeze({ reference: job.output, bytes }));
    }),
    recoverStorageReviewed: () => attempt(async () => {
      open(); const raw = await rawRead();
      if (typeof raw === 'string' && raw.length > MAX_DOCUMENT_BYTES) return bad('corrupt');
      try { await read(); return bad('invalid'); }
      catch (error) {
        const unreadable = error instanceof JobError && ['corrupt', 'incompatible', 'integrity'].includes(error.reason) ||
          error instanceof SyntaxError || error instanceof TypeError || error instanceof Error && error.name === 'DeviceValidationError';
        if (!unreadable) throw error;
      }
      if (typeof raw === 'string' && new TextEncoder().encode(raw).length <= MAX_DOCUMENT_BYTES) {
        try { const header = object(JSON.parse(raw)); if (identifier(header.ownerId) && header.ownerId !== owner) fail('wrong-owner');
          if (header.ownerId === owner && integer(header.revision)) highestRevision = Math.max(highestRevision, header.revision);
        } catch (error) { if (error instanceof JobError && error.reason === 'wrong-owner') throw error; }
      }
      const grant = await approval('recover-storage-reviewed');
      for (const [id, entry] of active) retire(id, entry, 'superseded');
      acceptedHere.clear();
      const document = Object.freeze({ version: 1 as const, ownerId: owner, revision: highestRevision, jobs: Object.freeze([]) });
      await write(raw, document, { signal: lifetime.signal, isCurrent: () => !closed && !grantReason(grant) });
      return ok(documentView({ ...document, revision: highestRevision }));
    }),
    close() {
      if (closing) return closing;
      closed = true; lifetime.abort('closed');
      const owned = [...active]; for (const [id, entry] of owned) retire(id, entry, 'closed');
      const accepted = new Set(acceptedHere); acceptedHere.clear();
      closing = (async () => {
        try {
          const stored = await read(); let changed = false;
          const jobs = stored.document.jobs.map(job => {
            if (job.state === 'accepted' && accepted.has(job.request.idempotencyKey) || job.state === 'running' &&
              owned.some(([id, entry]) => id === job.request.idempotencyKey && entry.generation === job.generation)) {
              changed = true; return finish(job, 'interrupted', Math.max(previousTime, 0));
            }
            return job;
          });
          if (changed) await write(stored.raw, Object.freeze({ ...stored.document, jobs: Object.freeze(jobs) }));
        } catch { /* Storage failure cannot restore grants; the next host must review prior accepted/running records. */ }
      })();
      return closing;
    },
  });
}

export interface IndexedDbArtifactJobStorage extends ArtifactJobStorage { close(): void }
/** A separate caller-owned database. Output and completed receipt live in the same atomic owner document. */
export function createIndexedDbArtifactJobStorage(factory: IDBFactory, databaseName = '101-artifact-jobs'): IndexedDbArtifactJobStorage {
  if (!factory || typeof factory.open !== 'function' || !identifier(databaseName)) throw new TypeError('Invalid artifact job database');
  let retired = false;
  const database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(databaseName, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('jobs'); };
    request.onerror = () => reject(new Error('Artifact job storage unavailable'));
    request.onblocked = () => { retired = true; reject(new Error('Artifact job storage unavailable')); };
    request.onsuccess = () => {
      const db = request.result;
      if (retired || !db.objectStoreNames.contains('jobs')) { db.close(); reject(new Error('Artifact job storage unavailable')); return; }
      db.onversionchange = () => { retired = true; db.close(); }; resolve(db);
    };
  });
  void database.catch(() => {});
  async function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore, set: (value: T) => void) => void,
    guard?: ArtifactJobWriteGuard): Promise<T> {
    const db = await database;
    if (retired || guard?.signal?.aborted) throw new Error('Artifact job storage unavailable');
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction('jobs', mode); let value: T;
      const abort = () => { try { tx.abort(); } catch { /* Already committed/aborted. */ } };
      const detach = () => guard?.signal?.removeEventListener('abort', abort);
      guard?.signal?.addEventListener('abort', abort, { once: true });
      tx.oncomplete = () => { detach(); resolve(value); };
      tx.onabort = tx.onerror = () => { detach(); reject(new Error('Artifact job storage unavailable')); };
      try { if (guard?.signal?.aborted) { abort(); return; } run(tx.objectStore('jobs'), next => { value = next; }); } catch { abort(); }
    });
  }
  return Object.freeze<IndexedDbArtifactJobStorage>({
    read: key => transaction<string | undefined>('readonly', (store, set) => {
      const request = store.get(key);
      request.onsuccess = () => {
        if (request.result !== undefined && typeof request.result !== 'string') { request.transaction?.abort(); return; }
        set(request.result as string | undefined);
      };
    }),
    compareAndSwap: (key, expected, value, guard) => transaction<boolean>('readwrite', (store, set) => {
      const request = store.get(key);
      request.onsuccess = () => {
        try {
          if (request.result !== expected || guard?.signal?.aborted || guard?.isCurrent && guard.isCurrent() !== true) { set(false); return; }
          store.put(value, key); set(true);
        } catch { request.transaction?.abort(); }
      };
    }, guard),
    close() { retired = true; void database.then(db => db.close()).catch(() => {}); },
  });
}
