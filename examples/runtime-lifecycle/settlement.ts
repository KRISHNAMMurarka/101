import { createDeviceRuntime } from '@101/connect';
import type { AuthorizationRequest, Connection, DeliveryContext, OperationRecord } from '@101/connect';

/** A caller-owned private software target, not a native device or resource grant.
 * The QA host implements this port with one actual Node Worker. */
export interface RouteSettlementTarget {
  apply(id: number, value: boolean): Promise<void>;
  held(id: number): Promise<void>;
  release(id: number, fail: boolean): void;
}
export interface RouteSettlementAttempt {
  readonly id: number;
  readonly failed: boolean;
  readonly retired: ReturnType<Connection['status']>;
  readonly before: readonly OperationRecord[];
  readonly after: readonly OperationRecord[];
  readonly currentAfterReturn: boolean;
}
function requireValue(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function device(id: string, sink: boolean) {
  return { schemaVersion: 1, id, label: id, revision: 1,
    adapter: { id: 'example:public-settlement', version: '1.0.0' }, runtime: { platform: 'owned-node-worker' },
    capabilities: [{ id: 'value', semantic: 'example:public-settlement', schemaVersion: 1,
      kind: sink ? 'command' : 'event', value: { type: 'boolean' },
      delivery: { mode: 'reliable', maxAgeMs: 5000 }, permissions: sink ? ['invoke'] : ['subscribe'] }] };
}

/** Public API only. Callback return and historical target ACK are separate from
 * terminal route authority, and target/process teardown is owned by the host. */
export async function runRouteSettlementCaller(target: Readonly<RouteSettlementTarget>) {
  const checks: string[] = [], attempts: RouteSettlementAttempt[] = [], raw = new Set<Promise<void>>();
  const pendingWork = () => raw.size;
  const contexts = new Map<number, DeliveryContext>(); let sourceId = '', sinkId = '', releases = 0, approvals = 0;
  const expiresAt = performance.now() + 9000;
  const runtime = createDeviceRuntime({ now: () => performance.now(), clockDomain: 'public-caller-monotonic',
    maxRegistrations: 2, maxRoutes: 2, maxSubscribers: 2, maxPendingDeliveries: 2, maxPendingDeliveriesPerScope: 1,
    authorize(request: Readonly<AuthorizationRequest>) {
      if (request.principalId !== 'software-owner' || request.applicationId !== 'route-settlement' || request.sessionId !== 'private-room' ||
          request.source.registrationId !== sourceId || request.sink.registrationId !== sinkId ||
          request.source.deviceId !== 'source' || request.sink.deviceId !== 'target' ||
          request.source.capabilityId !== 'value' || request.sink.capabilityId !== 'value' ||
          request.source.descriptorRevision !== 1 || request.sink.descriptorRevision !== 1 ||
          request.source.schemaVersion !== 1 || request.sink.schemaVersion !== 1 ||
          request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'invoke' || request.partition !== undefined) return;
      approvals++; return { expiresAt, maxAgeMs: 5000, maxHz: 100 };
    } });
  const source = runtime.registerSource({ device: device('source', false), capability: 'value' }); sourceId = source.id;
  const sink = runtime.registerSink({ device: device('target', true), capability: 'value',
    apply(observation, context) {
      requireValue(context.isCurrent() && !context.signal.aborted, 'Current runtime delivery required');
      const id = Number(context.operationId); requireValue(Number.isSafeInteger(id) && id >= 1 && id <= 2, 'Closed operation range');
      contexts.set(id, context);
      const work = target.apply(id, observation.value as boolean).then(() => { context.reportEvidence('target-acknowledged'); });
      raw.add(work); void work.then(() => raw.delete(work), () => raw.delete(work)); return work;
    }, release() { releases++; } }); sinkId = sink.id;
  requireValue(runtime.setReadiness(source, 'available').ok && runtime.setReadiness(sink, 'available').ok, 'Real registrations available');
  const routes: Connection[] = [];
  let releaseFailure: unknown, releaseFailed = false;
  const execute = async () => {
  try {
    let throwing = false;
    try { createDeviceRuntime({ authorize: () => undefined, maxRoutes: 0 }); } catch (error) { throwing = error instanceof RangeError; }
    requireValue(throwing, 'Invalid constructor capacity remains RangeError'); checks.push('constructor-throws-rangeerror');
    const denied = runtime.route({ from: source, to: sink, principalId: 'foreign-owner', applicationId: 'route-settlement', sessionId: 'private-room' });
    routes.push(denied); const refusal = denied.start();
    requireValue(!refusal.ok && refusal.reason === 'denied', 'Foreign exact source/sink request denied'); denied.stop();
    checks.push('denied-start-is-result-no-target-call');
    for (const id of [1, 2]) {
      const route = runtime.route({ from: source, to: sink, principalId: 'software-owner', applicationId: 'route-settlement', sessionId: 'private-room',
        leaseMs: 1500, queueCapacity: 2 }); routes.push(route);
      requireValue(route.start().ok, 'Actual independent host grant required');
      const now = performance.now(), admitted = runtime.publish(source, true, { operationId: String(id), timestamp: now, deadline: now + 1000 });
      requireValue(admitted.ok && admitted.value.accepted === 1, 'Canonical operation admitted');
      requireValue(!contexts.has(id), 'Admission is not dispatch'); checks.push('admission-not-dispatch-' + id);
      runtime.flush(); await target.held(id); const context = contexts.get(id)!;
      requireValue(context.isCurrent() && route.operations()[0]?.handlerResult === 'running', 'Actual target work held while current');
      route.stop('explicit-owner-stop'); const retired = route.status(), before = route.operations();
      requireValue(retired.state === 'closed' && retired.pending === 0 && context.signal.aborted && !context.isCurrent(), 'Immediate logical retirement');
      const wait = route.whenSettled; requireValue(typeof wait === 'function', 'Unsupported public route settlement capability');
      const done = wait.call(route); requireValue(wait.call(route) === done, 'Same retained settlement Promise');
      let settled = false; void done.then(() => { settled = true; });
      for (let turn = 0; turn < 6; turn++) await Promise.resolve();
      requireValue(!settled && pendingWork() === 1, 'Retirement cannot free actual issued work'); checks.push('terminal-pending-actual-work-' + id);
      target.release(id, id === 2); await done;
      const after = route.operations();
      requireValue(pendingWork() === 0 && !context.isCurrent(), 'Actual return settles bookkeeping without renewed authority');
      requireValue(after[0]?.handlerResult === (id === 2 ? 'failed' : 'returned'), 'Returned handler result is truthful');
      requireValue(after[0]?.effectEvidence === (id === 2 ? 'none' : 'target-acknowledged'), 'Only actual software target ACK supplies evidence');
      requireValue(id === 2 ? after[0]?.state === 'cancelled' : after[0]?.state === 'target-acknowledged', 'Historical effect evidence never reopens route');
      checks.push('actual-return-history-after-retirement-' + id);
      attempts.push(Object.freeze({ id, failed: id === 2, retired, before, after, currentAfterReturn: context.isCurrent() }));
    }
    requireValue(approvals === 2 && releases === 2, 'Exact separate grants and one release per active route');
    checks.push('exact-grants-releases-no-retry');
    return { profile: 'runtime-route-settlement/1', checks, attempts, approvals, releases,
      runtimeReturnedWork: pendingWork(), qualification: 'private owned Node software target; no physical effects or detached native cleanup established' };
  } finally {
    runtime.close(); for (const route of routes) route.stop('caller-finally');
    for (const id of contexts.keys()) {
      try { target.release(id, true); } catch (error) { if (!releaseFailed) releaseFailure = error; releaseFailed = true; }
    }
    // Host callbacks may throw after issuing real work. Retain ownership until
    // all actual returns and route barriers settle before reporting that error.
    await Promise.allSettled([...raw]);
    for (const route of routes) { const wait = route.whenSettled; if (typeof wait === 'function') await wait.call(route); }
  }
  };
  const result = await execute();
  if (releaseFailed) throw releaseFailure;
  return result;
}
