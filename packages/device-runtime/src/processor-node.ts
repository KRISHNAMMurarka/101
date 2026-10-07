import { Worker } from 'node:worker_threads';
import { parseProcessorExtensionRelease, parseSignalValue, snapshotJson, snapshotResourceBytes,
  verifyProcessorExtensionRelease } from '@101/device-model';
import type { ProcessorManifest, ProcessorPort, SignalValue } from '@101/device-model';
import { compileComputeProcessor } from './processor-language.ts';
import type { ProcessorFrame } from './processor-registry.ts';

export interface NodeProcessorApproval {
  readonly expiresAt: number; readonly isCurrent: () => boolean; readonly signal?: AbortSignal;
}
export interface NodeProcessorExecutorOptions {
  readonly release: unknown; readonly source: Uint8Array; readonly publisherKey: CryptoKey;
  readonly minimumSequence: number;
  /** Fixed by the reviewed host; no release field can select a function or import. */
  readonly entrypoint: string; readonly configuration: unknown;
  /** Current signed-installation authority or equivalent fresh host review. No device grant is supplied by this API. */
  readonly approval: NodeProcessorApproval;
}
export type NodeProcessorExecutorResult = Readonly<{ ok: true; frame?: ProcessorFrame }> |
  Readonly<{ ok: false; reason: 'inactive' | 'busy' | 'input' | 'output' | 'timeout' | 'memory' | 'compute' | 'unavailable' }>;
export interface NodeProcessorExecutorStatus {
  readonly active: boolean; readonly rawExecutors: 0 | 1; readonly pending: boolean;
  /** Exactly the fixed guest data ArrayBuffer. Excludes source/parser/AST, host dictionaries, Worker/V8 heaps and RSS. */
  readonly guestMemoryBytes: number;
}
export interface NodeProcessorExecutor {
  readonly manifest: Readonly<ProcessorManifest>;
  process(inputs: unknown): Promise<NodeProcessorExecutorResult>;
  reset(): Promise<NodeProcessorExecutorResult>;
  status(): NodeProcessorExecutorStatus;
  /** Fences authority synchronously. Resolves after the actual owned worker exit, never from logical retirement alone. */
  close(): Promise<void>;
}
const bad = (reason: Extract<NodeProcessorExecutorResult, { ok: false }>['reason']): NodeProcessorExecutorResult => Object.freeze({ ok: false, reason });
function frame(input: unknown, ports: readonly ProcessorPort[]): ProcessorFrame {
  const copied = snapshotJson(input);
  if (!copied || typeof copied !== 'object' || Array.isArray(copied) ||
    Object.keys(copied).sort().join('\0') !== ports.map(port => port.id).sort().join('\0')) throw new Error('processor-frame');
  const result: Record<string, SignalValue> = {};
  for (const port of ports) result[port.id] = parseSignalValue((copied as Record<string, unknown>)[port.id], port.value);
  return Object.freeze(result);
}
function approvalSnapshot(input: NodeProcessorApproval): NodeProcessorApproval {
  const own = (key: string) => { const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor && !('value' in descriptor)) throw new Error('processor-approval'); return descriptor?.value; };
  const expiresAt = own('expiresAt'), isCurrent = own('isCurrent'), signal = own('signal');
  if (!Number.isSafeInteger(expiresAt) || typeof isCurrent !== 'function' ||
    (signal !== undefined && !(signal instanceof AbortSignal))) throw new Error('processor-approval');
  return Object.freeze({ expiresAt, isCurrent, ...(signal ? { signal } : {}) });
}
/** Explicit Node-only compute interpreter for signed dependency-free, asset-free local processor releases.
 * The Worker supplies scheduling and hard parent termination, not a JavaScript security sandbox.
 * Arbitrary JavaScript is never evaluated; unsupported source language fails before worker launch.
 */
export async function createNodeProcessorExecutor(options: NodeProcessorExecutorOptions): Promise<NodeProcessorExecutor> {
  const release = parseProcessorExtensionRelease(options.release), source = snapshotResourceBytes(options.source);
  const approval = approvalSnapshot(options.approval);
  let active = true;
  function current(): boolean {
    try { return active && !approval.signal?.aborted && Date.now() < approval.expiresAt && approval.isCurrent() === true &&
      active && !approval.signal?.aborted && Date.now() < approval.expiresAt; } catch { return false; }
  }
  if (!Number.isSafeInteger(options.minimumSequence) || options.minimumSequence < 1 ||
    release.sequence < options.minimumSequence || !current() ||
    !await verifyProcessorExtensionRelease(release, source, options.publisherKey)) throw new Error('processor-untrusted');
  const configuration = parseSignalValue(options.configuration, release.manifest.configuration);
  const program = compileComputeProcessor(source, options.entrypoint);
  if (!current()) throw new Error('processor-inactive');
  let raw: 0 | 1 = 0, sequence = 0, worker: Worker;
  let completeExit!: () => void;
  const exited = new Promise<void>(resolve => { completeExit = resolve; });
  let pending: { id: number; resolve: (value: NodeProcessorExecutorResult) => void; timer: ReturnType<typeof setTimeout> } | undefined;
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const url = new URL(import.meta.url.endsWith('.ts') ? './processor-worker.ts' : './processor-worker.js', import.meta.url);
  try {
    worker = new Worker(url, { workerData: { program, configuration,
      memoryBytes: release.manifest.budgets.maxMemoryBytes, maxComputeMs: release.manifest.budgets.maxComputeMs },
      // Host implementation overhead has a separate coarse V8 bound; it is not the declared guest data memory limit.
      resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4, stackSizeMb: 2 },
      execArgv: [], env: {} });
    raw = 1;
  } catch { active = false; throw new Error('processor-unavailable'); }
  const finish = (value: NodeProcessorExecutorResult) => {
    if (!pending) return; const operation = pending; pending = undefined; clearTimeout(operation.timer); operation.resolve(value);
  };
  function retire(reason: Extract<NodeProcessorExecutorResult, { ok: false }>['reason']) {
    if (!active) return;
    active = false;
    clearTimeout(expiry);
    approval.signal?.removeEventListener('abort', abort);
    finish(bad(reason)); readyReject(new Error(`processor-${reason}`));
    // Reservation remains raw=1 until the actual 'exit' observer below.
    void worker.terminate().catch(() => {});
  }
  const abort = () => retire('inactive');
  function checkExpiry() {
    if (!current()) { retire('inactive'); return; }
    expiry = setTimeout(checkExpiry, Math.max(0, Math.min(approval.expiresAt - Date.now(), 60_000)));
  }
  let expiry = setTimeout(checkExpiry, Math.max(0, Math.min(approval.expiresAt - Date.now(), 60_000)));
  worker.on('exit', () => { raw = 0; retire('unavailable'); completeExit(); });
  worker.on('error', () => retire('unavailable'));
  worker.on('message', (message: { kind?: string; id?: number; ok?: boolean; frame?: unknown; reason?: string }) => {
    if (!current()) { retire('inactive'); return; }
    if (message.kind === 'ready') {
      if (message.ok === true) readyResolve(); else { const reason = message.reason === 'memory' || message.reason === 'timeout' ? message.reason : 'compute'; retire(reason); }
      return;
    }
    if (message.kind !== 'result' || !pending || message.id !== pending.id) { retire('unavailable'); return; }
    if (message.ok !== true) {
      const reason = message.reason === 'memory' || message.reason === 'timeout' || message.reason === 'output' ? message.reason : 'compute';
      retire(reason); return;
    }
    let output: ProcessorFrame | undefined;
    try { if (Object.hasOwn(message, 'frame')) output = frame(message.frame, release.manifest.outputs); }
    catch { retire('output'); return; }
    if (!current()) { retire('inactive'); return; }
    finish(Object.freeze({ ok: true, ...(output === undefined ? {} : { frame: output }) }));
  });
  approval.signal?.addEventListener('abort', abort, { once: true });

  // Host startup overhead is separate from each guest construction/process/reset compute budget.
  const startup = setTimeout(() => retire('unavailable'), 1000);
  try { await ready; if (!current()) { retire('inactive'); throw new Error('processor-inactive'); } }
  catch (error) { retire('unavailable'); await exited; throw error; }
  finally { clearTimeout(startup); }
  function dispatch(operation: 'process' | 'reset', inputs?: ProcessorFrame): Promise<NodeProcessorExecutorResult> {
    if (!current()) { retire('inactive'); return Promise.resolve(bad('inactive')); }
    if (pending) return Promise.resolve(bad('busy'));
    return new Promise(resolve => {
      const id = ++sequence;
      pending = { id, resolve, timer: setTimeout(() => retire('timeout'), release.manifest.budgets.maxComputeMs) };
      try { worker.postMessage({ id, operation, ...(inputs === undefined ? {} : { inputs }) }); }
      catch { retire('unavailable'); }
    });
  }
  return Object.freeze({ manifest: release.manifest,
    process(inputs: unknown): Promise<NodeProcessorExecutorResult> {
      if (!current()) { retire('inactive'); return Promise.resolve(bad('inactive')); }
      let admitted: ProcessorFrame; try { admitted = frame(inputs, release.manifest.inputs); } catch { return Promise.resolve(bad('input')); }
      return dispatch('process', admitted);
    },
    reset(): Promise<NodeProcessorExecutorResult> { return dispatch('reset'); },
    status(): NodeProcessorExecutorStatus {
      if (!current()) retire('inactive');
      return Object.freeze({ active, rawExecutors: raw, pending: pending !== undefined, guestMemoryBytes: release.manifest.budgets.maxMemoryBytes });
    },
    close(): Promise<void> { retire('inactive'); return exited; },
  });
}
