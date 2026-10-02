import { parseDeviceDescriptor, parseSignalValue, schemasCompatible, snapshotJson } from "@101/device-model";
import type { DeviceCapability, DeviceDescriptor } from "@101/device-model";
import { LeaseBook } from "./lease.ts";
import { failure, LatestSlot, OperationQueue, success } from "./scheduler.ts";
import type { Evidence, Result } from "./scheduler.ts";
import type { AuthorizationRequest, Connection, DeliveryContext, DeviceRuntime, EndpointHandle,
  Observation, PublishOptions, Readiness, ResourceReference, RouteGrant, RouteRequest, RuntimeOptions, SinkProvider } from "./types.ts";

interface Registration {
  handle: EndpointHandle; descriptor: DeviceDescriptor; capability: DeviceCapability;
  role: "source" | "sink"; readiness: Readiness; sequence: number; operation: number;
  routes: Set<EmbeddedConnection>; provider?: Pick<SinkProvider, "apply" | "release">;
}
const READINESS: readonly string[] = ["available", "unavailable", "busy", "denied", "stale"];
const OPTIONS = ["sequence", "timestamp", "clockDomain", "quality", "provenance", "operationId", "deadline"];

function bound(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > maximum) throw new RangeError("Invalid runtime capacity");
  return result;
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}
function reference(entry: Registration): ResourceReference {
  return Object.freeze({ registrationId: entry.handle.id, deviceId: entry.descriptor.id,
    capabilityId: entry.capability.id, descriptorRevision: entry.descriptor.revision, schemaVersion: entry.capability.schemaVersion });
}
function parseGrant(input: unknown, now: number): RouteGrant | undefined {
  try {
    const value = snapshotJson(input);
    if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !["expiresAt", "maxAgeMs", "maxHz"].includes(key))) return;
    if (typeof value.expiresAt !== "number" || value.expiresAt <= now ||
      typeof value.maxAgeMs !== "number" || value.maxAgeMs < 1 || value.maxAgeMs > 60000 ||
      (value.maxHz !== undefined && (typeof value.maxHz !== "number" || value.maxHz < 1 || value.maxHz > 1000))) return;
    return value as unknown as RouteGrant;
  } catch { return; }
}

/** Embedded host authority. Registration handles are identity-bound, never wire credentials. */
export class EmbeddedRuntime implements DeviceRuntime {
  private readonly registry = new WeakMap<EndpointHandle, Registration>();
  private readonly entries = new Set<Registration>();
  private readonly active = new Set<EmbeddedConnection>();
  private readonly connections = new WeakSet<Connection>();
  private readonly leases = new LeaseBook();
  private readonly now: () => number;
  readonly clockDomain: string;
  private readonly authorize: RuntimeOptions["authorize"];
  private readonly maxRegistrations: number;
  private readonly maxRoutes: number;
  private readonly maxSubscribers: number;
  private readonly maxPendingDeliveries: number;
  private pendingDeliveries = 0;
  private registrationId = 0;
  private routeId = 0;
  private previousTime = -Infinity;
  private authorizing = false;
  private flushing = false;
  private closed = false;

  constructor(options: RuntimeOptions) {
    if (typeof options.authorize !== "function") throw new TypeError("Host authorization is required");
    this.authorize = options.authorize;
    this.now = options.now ?? (() => performance.now());
    this.clockDomain = options.clockDomain ?? "embedded";
    if (!identifier(this.clockDomain)) throw new TypeError("Invalid clock domain");
    this.maxRegistrations = bound(options.maxRegistrations, 1024, 4096);
    this.maxRoutes = bound(options.maxRoutes, 128, 128);
    this.maxSubscribers = bound(options.maxSubscribers, 32, 32);
    this.maxPendingDeliveries = bound(options.maxPendingDeliveries, 256, 4096);
  }

  time(): number {
    const now = this.now();
    if (!Number.isFinite(now) || now < 0 || now < this.previousTime) {
      this.close();
      throw new RangeError("Invalid monotonic clock");
    }
    this.previousTime = now;
    return now;
  }
  entry(handle: EndpointHandle): Registration | undefined { return this.registry.get(handle); }
  isOpen(): boolean { return !this.closed; }

  private register(device: unknown, capabilityId: string, role: Registration["role"], provider?: Registration["provider"]): EndpointHandle {
    if (this.closed) throw new Error("Runtime closed");
    if (this.entries.size >= this.maxRegistrations) throw new RangeError("Registration capacity reached");
    const descriptor = parseDeviceDescriptor(device);
    const capability = descriptor.capabilities.find((candidate) => candidate.id === capabilityId);
    if (!capability) throw new TypeError("Unknown capability");
    if (role === "source" ? (!capability.permissions.some((value) => value === "read" || value === "subscribe") || capability.kind === "command")
      : !capability.permissions.some((value) => value === "write" || value === "invoke")) throw new TypeError("Unsupported operation");
    if (capability.kind === "command" && capability.delivery.mode !== "reliable") throw new TypeError("Commands require reliable delivery");
    const handle = Object.freeze({ id: `registration-${++this.registrationId}` });
    const entry: Registration = { handle, descriptor, capability, role, readiness: "unavailable", sequence: -1,
      operation: 0, routes: new Set(), provider };
    this.registry.set(handle, entry); this.entries.add(entry);
    return handle;
  }
  registerSource(provider: { device: unknown; capability: string }): EndpointHandle {
    return this.register(provider.device, provider.capability, "source");
  }
  registerSink(provider: SinkProvider): EndpointHandle {
    if (typeof provider.apply !== "function" || typeof provider.release !== "function") throw new TypeError("Sink apply and release are required");
    // Capture the callbacks; later caller mutation cannot substitute another sink.
    return this.register(provider.device, provider.capability, "sink", { apply: provider.apply.bind(provider), release: provider.release.bind(provider) });
  }
  setReadiness(handle: EndpointHandle, readiness: Readiness): Result {
    const entry = this.registry.get(handle);
    if (this.closed || !entry) return failure("unknown-endpoint");
    if (!READINESS.includes(readiness)) return failure("invalid-readiness");
    entry.readiness = readiness;
    if (readiness !== "available") for (const route of [...entry.routes]) route.stop(readiness);
    return success();
  }
  unregister(handle: EndpointHandle): Result {
    const entry = this.registry.get(handle);
    if (!entry) return failure("unknown-endpoint");
    // Remove first so reentrant provider callbacks cannot reconnect this endpoint.
    this.registry.delete(handle); this.entries.delete(entry);
    for (const route of [...entry.routes]) route.stop("unregistered");
    return success();
  }
  route(request: RouteRequest): Connection {
    const route = new EmbeddedConnection(this, `route-${++this.routeId}`, { ...request });
    this.connections.add(route);
    return route;
  }
  activate(route: EmbeddedConnection, request: RouteRequest): Result<{ source: Registration; sink: Registration; grant: RouteGrant; now: number; leaseKey?: string }> {
    if (this.closed) return failure("closed");
    if (this.authorizing) return failure("authorization-reentry");
    const source = this.entry(request.from), sink = this.entry(request.to);
    if (!source || !sink || source.role !== "source" || sink.role !== "sink") return failure("unknown-endpoint");
    if (![request.principalId, request.applicationId, request.sessionId].every(identifier)) return failure("invalid-identity");
    if (source.readiness !== "available" || sink.readiness !== "available") return failure("unavailable");
    if (!schemasCompatible(source.capability, sink.capability) || source.capability.delivery.mode !== sink.capability.delivery.mode) return failure("incompatible");
    const ownership = sink.capability.ownership;
    if (ownership?.mode === "partitioned" ? !ownership.partitions.includes(request.partition ?? "") : request.partition !== undefined) return failure("invalid-partition");
    let now: number;
    try { now = this.time(); } catch { return failure("invalid-clock"); }
    this.sweep(now);
    if (this.closed || this.entry(request.from) !== source || this.entry(request.to) !== sink) return failure("unknown-endpoint");
    if (this.active.size >= this.maxRoutes || source.routes.size >= this.maxSubscribers) return failure("capacity");
    const authorization: AuthorizationRequest = Object.freeze({ principalId: request.principalId, applicationId: request.applicationId,
      sessionId: request.sessionId, source: reference(source), sink: reference(sink),
      sourceOperation: source.capability.permissions.includes("subscribe") ? "subscribe" : "read",
      sinkOperation: sink.capability.kind === "command" ? "invoke" : "write", ...(request.partition === undefined ? {} : { partition: request.partition }) });
    if (!sink.capability.permissions.includes(authorization.sinkOperation)) return failure("unsupported-operation");
    let grant: RouteGrant | undefined;
    this.authorizing = true;
    try { grant = parseGrant(this.authorize(authorization), now); } catch { grant = undefined; }
    finally { this.authorizing = false; }
    if (!grant) return failure("denied");
    // Host callbacks may remove endpoints, revoke readiness, or close the runtime.
    try { now = this.time(); } catch { return failure("invalid-clock"); }
    if (this.closed || this.entry(request.from) !== source || this.entry(request.to) !== sink ||
      source.readiness !== "available" || sink.readiness !== "available" || grant.expiresAt <= now || route.status().state !== "idle") return failure("unavailable");
    if (request.constraints !== undefined) {
      const constraints = parseGrant(request.constraints, now);
      if (!constraints) return failure("invalid-constraints");
      grant = { expiresAt: Math.min(grant.expiresAt, constraints.expiresAt), maxAgeMs: Math.min(grant.maxAgeMs, constraints.maxAgeMs),
        maxHz: Math.min(grant.maxHz ?? 1000, constraints.maxHz ?? 1000) };
    }
    const leaseKey = ownership?.mode === "observe" ? undefined : `${sink.handle.id}:${request.partition ?? ""}`;
    const expiresAt = Math.min(grant.expiresAt, now + (request.leaseMs ?? 1500));
    if (leaseKey && !this.leases.claim(leaseKey, route.id, expiresAt, now)) return failure("busy");
    this.active.add(route); source.routes.add(route); sink.routes.add(route);
    return success({ source, sink, grant, now, leaseKey });
  }
  detach(route: EmbeddedConnection, source: Registration, sink: Registration, leaseKey?: string): void {
    this.active.delete(route); source.routes.delete(route); sink.routes.delete(route);
    if (leaseKey) this.leases.release(leaseKey, route.id);
  }
  renewLease(key: string, owner: string, expiry: number, now: number): boolean { return this.leases.renew(key, owner, expiry, now); }
  reserveDelivery(): boolean {
    if (this.closed || this.pendingDeliveries >= this.maxPendingDeliveries) return false;
    this.pendingDeliveries++; return true;
  }
  releaseDelivery(): void { this.pendingDeliveries--; }
  private sweep(now: number): void { for (const route of [...this.active]) route.check(now); }

  publish(source: EndpointHandle, input: unknown, options: PublishOptions = {}): Result<{ accepted: number; rejected: number }> {
    const entry = this.entry(source);
    if (this.closed || !entry || entry.role !== "source") return failure("unknown-endpoint");
    try {
      const copied = snapshotJson(options);
      if (!copied || typeof copied !== "object" || Array.isArray(copied) || Object.keys(copied).some((key) => !OPTIONS.includes(key))) return failure("invalid-options");
      const valueOptions = copied as unknown as PublishOptions;
      const now = this.time(); this.sweep(now);
      const timestamp = valueOptions.timestamp ?? now, sequence = valueOptions.sequence ?? entry.sequence + 1;
      if (valueOptions.clockDomain !== undefined && valueOptions.clockDomain !== this.clockDomain) return failure("foreign-clock");
      if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > now || now - timestamp > entry.capability.delivery.maxAgeMs) return failure("stale");
      if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 0xffffffff || sequence <= entry.sequence) return failure("out-of-order");
      if (valueOptions.quality === "unavailable" || valueOptions.quality === "stale") {
        entry.sequence = sequence;
        this.setReadiness(source, valueOptions.quality); return failure(valueOptions.quality);
      }
      if (entry.readiness !== "available" || this.closed) return failure("unavailable");
      if (valueOptions.quality !== undefined && valueOptions.quality !== "valid") return failure("invalid-quality");
      const value = parseSignalValue(input, entry.capability.value);
      if (valueOptions.provenance !== undefined && (valueOptions.provenance === null || typeof valueOptions.provenance !== "object" || Array.isArray(valueOptions.provenance))) return failure("invalid-provenance");
      const observation: Observation = Object.freeze({ value, sequence, timestamp, receivedAt: now, clockDomain: this.clockDomain, quality: "valid",
        ...(valueOptions.provenance === undefined ? {} : { provenance: valueOptions.provenance }),
        source: Object.freeze({ registrationId: entry.handle.id, deviceId: entry.descriptor.id, capabilityId: entry.capability.id }) });
      if (new TextEncoder().encode(JSON.stringify({ observation, options: copied })).length > 4096) return failure("payload-limit");
      const reliable = entry.capability.delivery.mode === "reliable";
      if (reliable) {
        const operation = Number(valueOptions.operationId);
        if (!Number.isSafeInteger(operation) || operation <= 0 || String(operation) !== valueOptions.operationId) return failure("invalid-operation-id");
        if (operation <= entry.operation) return failure("stale-operation");
        if (typeof valueOptions.deadline !== "number" || !Number.isFinite(valueOptions.deadline) || valueOptions.deadline <= now ||
          valueOptions.deadline > timestamp + entry.capability.delivery.maxAgeMs) return failure("invalid-deadline");
      } else if (valueOptions.operationId !== undefined || valueOptions.deadline !== undefined) return failure("invalid-options");
      let accepted = 0, rejected = 0, reason = "no-route";
      for (const route of [...entry.routes]) {
        const result = route.offer(observation, now, valueOptions);
        if (result.ok) accepted++; else { rejected++; reason = result.reason; }
      }
      if (reliable && accepted === 0) return failure(reason);
      entry.sequence = sequence;
      if (reliable) entry.operation = Number(valueOptions.operationId);
      return success({ accepted, rejected });
    } catch { return failure("invalid-observation"); }
  }
  flush(): void {
    if (this.closed || this.flushing) return;
    this.flushing = true;
    try {
      const now = this.time();
      // Freeze this flush's work before calling any provider. Derived work is a later turn.
      const work = [...this.active].flatMap((route) => route.prepare(now));
      for (const dispatch of work) dispatch();
    }
    catch { this.close(); }
    finally { this.flushing = false; }
  }
  revoke(connection: Connection): void { if (this.connections.has(connection)) connection.stop("revoked"); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const route of [...this.active]) route.stop("runtime-closed");
    for (const entry of this.entries) this.registry.delete(entry.handle);
    this.entries.clear(); this.leases.clear();
  }
}

class EmbeddedConnection implements Connection {
  private readonly runtime: EmbeddedRuntime;
  readonly id: string;
  private readonly request: RouteRequest;
  private state: "idle" | "active" | "closed" = "idle";
  private reason?: string;
  private starting = false;
  private source?: Registration;
  private sink?: Registration;
  private grant?: RouteGrant;
  private leaseKey?: string;
  private expiresAt = 0;
  private readonly leaseMs: number;
  private readonly latest = new LatestSlot<Observation>();
  private readonly queue: OperationQueue<Observation>;
  private readonly inFlight = new Map<string, AbortController>();
  private latestBusy = false;
  private lastDispatch = -Infinity;
  private generation = 0;
  private maxAgeMs = 0;
  private maxHz = 1;

  constructor(runtime: EmbeddedRuntime, id: string, request: RouteRequest) {
    this.runtime = runtime; this.id = id; this.request = { ...request };
    if (request.constraints !== undefined) {
      try { this.request.constraints = snapshotJson(request.constraints) as unknown as RouteGrant; }
      catch { this.request.constraints = {} as RouteGrant; }
    }
    this.leaseMs = bound(request.leaseMs, 1500, 30000);
    this.queue = new OperationQueue(request.queueCapacity);
  }
  start(): Result {
    if (this.state !== "idle" || this.starting) return failure(this.state === "active" ? "already-active" : "closed");
    this.starting = true;
    try {
      const result = this.runtime.activate(this, this.request);
      if (!result.ok) { this.reason = result.reason; return result; }
      const { source, sink, grant, now, leaseKey } = result.value;
      this.source = source; this.sink = sink; this.grant = grant; this.leaseKey = leaseKey;
      this.expiresAt = Math.min(grant.expiresAt, now + this.leaseMs);
      this.maxAgeMs = Math.min(grant.maxAgeMs, source.capability.delivery.maxAgeMs, sink.capability.delivery.maxAgeMs);
      this.maxHz = Math.min(grant.maxHz ?? 1000, source.capability.delivery.mode === "latest" ? source.capability.delivery.maxHz : 1000,
        sink.capability.delivery.mode === "latest" ? sink.capability.delivery.maxHz : 1000);
      this.state = "active"; this.reason = undefined; this.generation++;
      return success();
    } finally { this.starting = false; }
  }
  renew(principalId: string): Result {
    if (this.state !== "active" || principalId !== this.request.principalId) return failure("not-owner");
    let now: number;
    try { now = this.runtime.time(); } catch { return failure("invalid-clock"); }
    this.check(now);
    if (this.state !== "active") return failure("expired");
    const expiry = Math.min(this.grant!.expiresAt, now + this.leaseMs);
    if (this.leaseKey && !this.runtime.renewLease(this.leaseKey, this.id, expiry, now)) { this.stop("ownership-lost"); return failure("ownership-lost"); }
    this.expiresAt = expiry; return success();
  }
  stop(reason = "stopped"): void {
    if (this.state === "closed") return;
    const active = this.state === "active";
    this.state = "closed"; this.reason = reason;
    this.latest.clear(); this.queue.clear();
    if (active) this.runtime.detach(this, this.source!, this.sink!, this.leaseKey);
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear(); this.latestBusy = false;
    if (active) try { this.sink!.provider!.release(reason, Object.freeze({ routeId: this.id, partition: this.request.partition })); }
    catch { /* Authority is already revoked; release failures cannot reopen it. */ }
  }
  status(): ReturnType<Connection["status"]> {
    return Object.freeze({ state: this.state, reason: this.reason, pending: this.latest.size + this.queue.pending });
  }
  limits(): ReturnType<Connection["limits"]> {
    if (this.state !== "active") return;
    try { this.check(this.runtime.time()); } catch { return; }
    if (this.state !== "active") return;
    return Object.freeze({ maxHz: this.maxHz, maxAgeMs: this.maxAgeMs, expiresAt: this.expiresAt });
  }
  operations(): ReturnType<Connection["operations"]> { return this.queue.records(); }
  check(now: number): void {
    if (this.state !== "active") return;
    if (now >= this.expiresAt || now >= this.grant!.expiresAt) { this.stop("expired"); return; }
    for (const id of this.queue.expire(now)) this.inFlight.get(id)?.abort();
    this.queue.purge(now);
  }
  offer(observation: Observation, now: number, options: PublishOptions): Result {
    this.check(now);
    if (this.state !== "active" || now - observation.timestamp > this.maxAgeMs) return failure("stale");
    if (this.source!.capability.delivery.mode === "latest") {
      this.latest.offer(observation, observation.timestamp); return success();
    }
    if (options.deadline! > observation.timestamp + this.maxAgeMs) return failure("invalid-deadline");
    return this.queue.admit(options.operationId!, options.deadline!, observation, now);
  }
  prepare(now: number): (() => void)[] {
    this.check(now);
    if (this.state !== "active") return [];
    if (this.source!.capability.delivery.mode === "latest") {
      if (this.latestBusy || !this.latest.size || now - this.lastDispatch < 1000 / this.maxHz || !this.runtime.reserveDelivery()) return [];
      const observation = this.latest.take(now, this.maxAgeMs);
      if (!observation) { this.runtime.releaseDelivery(); return []; }
      this.lastDispatch = now; this.latestBusy = true;
      return [() => this.dispatch(observation)];
    } else {
      const capacity = this.request.queueCapacity ?? 64;
      if (this.inFlight.size >= capacity || now - this.lastDispatch < 1000 / this.maxHz || !this.runtime.reserveDelivery()) return [];
      const operation = this.queue.next(now);
      if (!operation) { this.runtime.releaseDelivery(); return []; }
      this.lastDispatch = now;
      return [() => this.dispatch(operation.value, operation.id, operation.deadline)];
    }
  }
  private dispatch(observation: Observation, operationId?: string, deadline?: number): void {
    let now: number;
    try { now = this.runtime.time(); } catch { this.runtime.releaseDelivery(); return; }
    this.check(now);
    if (this.state !== "active" || (deadline !== undefined && now >= deadline) || now - observation.timestamp > this.maxAgeMs) {
      if (operationId) this.queue.settle(operationId, "expired");
      else this.latestBusy = false;
      this.runtime.releaseDelivery(); return;
    }
    const controller = new AbortController();
    const key = operationId ?? "latest", generation = this.generation;
    this.inFlight.set(key, controller); if (!operationId) this.latestBusy = true;
    if (operationId) this.queue.pin(operationId);
    const context: DeliveryContext = Object.freeze({ signal: controller.signal, routeId: this.id, generation, operationId, partition: this.request.partition,
      isCurrent: () => {
        if (this.state !== "active" || this.generation !== generation || controller.signal.aborted) return false;
        try { const now = this.runtime.time(); this.check(now); return this.state === "active" && !controller.signal.aborted &&
          (deadline === undefined ? now - observation.timestamp <= this.maxAgeMs : now < deadline); } catch { return false; }
      },
      reportEvidence: (evidence: Evidence) => {
        if (operationId && ["dispatched", "unverified", "target-acknowledged", "observed"].includes(evidence)) this.queue.evidence(operationId, evidence);
      } });
    const complete = (failed: boolean): void => {
      this.runtime.releaseDelivery();
      this.inFlight.delete(key); if (!operationId) this.latestBusy = false;
      if (operationId) {
        this.queue.settle(operationId, failed ? "failed" : "unverified");
        let settledAt = observation.receivedAt;
        try { settledAt = this.runtime.time(); } catch { /* Closed on a bad clock; retain bounded evidence. */ }
        this.queue.unpin(operationId, settledAt);
      }
      if (failed && this.state === "active") this.stop("provider-failed");
    };
    try {
      const returned = this.sink!.provider!.apply(observation, context);
      if (returned && typeof returned.then === "function") Promise.resolve(returned).then(() => complete(false), () => complete(true));
      else complete(false);
    } catch { complete(true); }
  }
}
