import { validateProcessorGraph } from '@101/device-model';
import type { ProcessorGraphPlan } from '@101/device-model';
import type { Connection, DeviceRuntime, EndpointHandle, PublishOptions } from './types.ts';
import type { ResolvedProcessor } from './processor-registry.ts';

export interface ProcessorFailureBinding {
  readonly node: string;
  readonly processor: ResolvedProcessor;
  /** One host-owned derived source per declared output port. */
  readonly outputs: Readonly<Record<string, EndpointHandle>>;
  /** Active, freshly authorized input route for every declared input port. */
  readonly inputRoutes: readonly Connection[];
}
export interface ProcessorFailureOptions {
  readonly plan: ProcessorGraphPlan;
  readonly runtime: DeviceRuntime;
  readonly bindings: readonly ProcessorFailureBinding[];
  readonly now?: () => number;
}
export type ProcessorRunResult = Readonly<{ ok: true; emitted: boolean }> |
  Readonly<{ ok: false; reason: 'inactive' | 'processor-failed' | 'timeout' | 'publish-failed' }>;
export interface ProcessorFailureController {
  /** Synchronous validated execution and publication, fenced by input route state. */
  run(node: string, inputs: unknown, options?: Readonly<Record<string, PublishOptions>>): ProcessorRunResult;
  /** Signal an input loss or revocation; also called by bound route close listeners. */
  invalidate(node: string, reason: string): void;
  status(node: string): Readonly<{ state: 'active' | 'failed'; reason?: string }>;
  /** Terminal cleanup. Build a new controller with fresh grants/routes for restart. */
  stop(): void;
}

interface Bound {
  readonly processor: ResolvedProcessor;
  readonly outputs: Readonly<Record<string, EndpointHandle>>;
  readonly inputRoutes: readonly Connection[];
  state: 'active' | 'failed';
  reason?: string;
}
function sameKeys(actual: readonly string[], expected: readonly string[]): boolean {
  return [...actual].sort().join('\0') === [...expected].sort().join('\0');
}
function cleanReason(reason: string): string {
  return typeof reason === 'string' && reason.length > 0 && reason.length <= 128 ? reason : 'input-loss';
}

/** Fail-closed execution for an acyclic, route-backed processor graph. */
export function createProcessorFailureController(options: ProcessorFailureOptions): ProcessorFailureController {
  if (!options || !options.plan || !options.runtime || !Array.isArray(options.bindings))
    throw new TypeError('Validated graph, runtime and bindings are required');
  // Revalidate caller-supplied plan data; executionOrder and requirements are never authority.
  const plan = validateProcessorGraph({ schemaVersion: 1, nodes: options.plan.nodes, edges: options.plan.edges });
  if (plan.edges.some(edge => edge.feedback)) throw new TypeError('Feedback execution needs a bounded scheduler');
  const processorNodes = plan.nodes.filter(node => node.kind === 'processor');
  if (options.bindings.length !== processorNodes.length) throw new TypeError('One binding per processor is required');
  const bindings = new Map<string, Bound>();
  const seenOutputs = new Set<EndpointHandle>();
  const seenRoutes = new Set<Connection>();
  for (const source of options.bindings) {
    const node = processorNodes.find(candidate => candidate.id === source.node);
    if (!node || bindings.has(node.id) || !source.processor || !source.outputs ||
        !Array.isArray(source.inputRoutes) || source.inputRoutes.length !== node.manifest.inputs.length ||
        !sameKeys(Object.keys(source.outputs), node.manifest.outputs.map(port => port.id)) ||
        source.processor.manifest.id !== node.manifest.id ||
        source.processor.manifest.version !== node.manifest.version ||
        source.processor.manifest.codeSha256 !== node.manifest.codeSha256) {
      throw new TypeError('Processor binding does not match its graph node');
    }
    if (typeof source.processor.process !== 'function' || typeof source.processor.reset !== 'function')
      throw new TypeError('Processor must be executable and resettable');
    for (const output of Object.values(source.outputs) as EndpointHandle[]) {
      if (!output || typeof output !== 'object' || seenOutputs.has(output))
        throw new TypeError('Derived sources must be distinct host handles');
      seenOutputs.add(output);
    }
    for (const route of source.inputRoutes) {
      if (!route || typeof route.onClose !== 'function' || typeof route.stop !== 'function' ||
          typeof route.limits !== 'function' || typeof route.status !== 'function' ||
          route.status().state !== 'active' || seenRoutes.has(route))
        throw new TypeError('Fresh active input routes are required');
      seenRoutes.add(route);
    }
    bindings.set(node.id, { processor: source.processor, outputs: Object.freeze({ ...source.outputs }),
      inputRoutes: Object.freeze([...source.inputRoutes]), state: 'active' });
  }
  const successors = new Map(plan.nodes.map(node => [node.id, [] as string[]]));
  for (const edge of plan.edges) successors.get(edge.from.node)!.push(edge.to.node);
  const now = options.now ?? (() => performance.now());
  if (typeof now !== 'function') throw new TypeError('Monotonic clock required');
  const unsubscribe: Array<() => void> = [];
  let stopped = false;
  function affected(root: string): string[] {
    if (!successors.has(root)) throw new TypeError('Unknown graph node');
    const reached = new Set([root]), queue = [root];
    for (let at = 0; at < queue.length; at++) for (const next of successors.get(queue[at]!)!) {
      if (!reached.has(next)) { reached.add(next); queue.push(next); }
    }
    return plan.executionOrder.filter(id => reached.has(id) && bindings.has(id));
  }
  function invalidate(root: string, reason: string): void {
    const selected = affected(root).filter(id => bindings.get(id)!.state === 'active');
    if (!selected.length) return;
    const why = cleanReason(reason);
    // Fence all dependent stages before route callbacks can reenter this controller.
    for (const id of selected) {
      const binding = bindings.get(id)!;
      binding.state = 'failed'; binding.reason = why;
    }
    for (const id of selected) {
      const binding = bindings.get(id)!;
      for (const source of Object.values(binding.outputs)) {
        try { options.runtime.setReadiness(source, 'unavailable'); } catch { /* Continue fencing routes. */ }
      }
      for (const route of binding.inputRoutes) try { route.stop(`processor:${why}`); } catch { /* Already fenced. */ }
    }
    for (const id of selected) {
      try { bindings.get(id)!.processor.reset(); }
      catch { bindings.get(id)!.reason = 'reset-failed'; }
    }
  }
  const controller: ProcessorFailureController = Object.freeze({
    run(node: string, inputs: unknown, publishOptions: Readonly<Record<string, PublishOptions>> = {}): ProcessorRunResult {
      const binding = bindings.get(node);
      if (!binding) throw new TypeError('Unknown processor node');
      if (stopped || binding.state !== 'active') return { ok: false, reason: 'inactive' };
      try {
        if (binding.inputRoutes.some(route => route.limits() === undefined || route.status().state !== 'active')) {
          invalidate(node, 'input-loss');
          return { ok: false, reason: 'inactive' };
        }
      } catch {
        invalidate(node, 'input-loss');
        return { ok: false, reason: 'inactive' };
      }
      let started: number, ended: number;
      let frame: ReturnType<ResolvedProcessor['process']>;
      try {
        started = now();
        if (!Number.isFinite(started) || started < 0) throw new RangeError('Invalid clock');
        frame = binding.processor.process(inputs);
        ended = now();
        if (!Number.isFinite(ended) || ended < started) throw new RangeError('Invalid clock');
      } catch {
        invalidate(node, 'processor-failed');
        return { ok: false, reason: 'processor-failed' };
      }
      if (binding.state !== 'active') return { ok: false, reason: 'inactive' };
      if (ended - started > binding.processor.manifest.budgets.maxComputeMs) {
        invalidate(node, 'timeout');
        return { ok: false, reason: 'timeout' };
      }
      if (frame === undefined) return { ok: true, emitted: false };
      for (const port of binding.processor.manifest.outputs) {
        try {
          const outcome = options.runtime.publish(binding.outputs[port.id]!, frame[port.id], publishOptions[port.id]);
          if (!outcome.ok || outcome.value.accepted === 0) throw new Error('No authorized output route');
        } catch {
          invalidate(node, 'publish-failed');
          return { ok: false, reason: 'publish-failed' };
        }
        if (binding.state !== 'active') return { ok: false, reason: 'inactive' };
      }
      return { ok: true, emitted: true };
    },
    invalidate,
    status(node: string) {
      const binding = bindings.get(node);
      if (!binding) throw new TypeError('Unknown processor node');
      return Object.freeze({ state: binding.state, ...(binding.reason ? { reason: binding.reason } : {}) });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      for (const release of unsubscribe) release();
      for (const node of processorNodes) invalidate(node.id, 'stop');
    },
  });
  for (const source of options.bindings) for (const route of source.inputRoutes as readonly Connection[])
    unsubscribe.push(route.onClose((reason: string) => controller.invalidate(source.node, reason)));
  return controller;
}
