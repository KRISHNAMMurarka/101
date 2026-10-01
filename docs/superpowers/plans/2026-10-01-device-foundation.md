# Device Foundation Implementation Plan

> **For agentic workers:** Use the repository workflow and test-driven development to execute this plan. The owner explicitly requested coding after the spec review; continue implementation in this session. One disjoint model lane may be delegated, with one independent final review.

**Goal:** Ship a game-independent embedded SDK that validates typed devices and routes authorized signals safely, exercised by pointer and sensor/feedback examples.

**Architecture:** Three small workspace packages separate descriptions, embedded runtime and public facade. Providers register opaque handles; a trusted host authority approves both sides of a route. The runtime owns bounded pending work, exclusive/partition leases and cleanup; applications own processors explicitly.

**Tech Stack:** TypeScript, standard platform APIs, Node 22.13+ type stripping and node:test. Existing Ajv 6.15.0 is made an explicit development dependency for editor-schema fixture checks; no new production dependency.

**Spec:** [Device foundation design](../specs/2026-10-01-device-foundation-design.md), subordinate to [the platform design](../specs/2026-10-01-universal-device-platform-design.md).

## Global constraints

- Work locally; do not publish, deploy or add external services.
- New platform packages depend on no game/application packages or device APIs.
- Descriptor: 64 KiB, 128 capabilities, 128-character IDs/unit/frame/semantics, 160-character labels; revisions 1–2³²−1.
- Extensions: namespaced keys, depth 8, 128 entries/container, bounded by descriptor bytes.
- Samples: finite scalar, boolean, vector x/y[/z] or enum; explicit unit/frame/range; no clamping or implicit conversion.
- Latest dispatch: one pending sample per route, 1–1000 Hz, maximum age 1–60000 ms.
- Reliable work: default capacity 64, configured 1–256; active plus queued count; operation ≤4 KiB; bounded deduplication retention.
- Lease: default 1500 ms, configured 1–30000 ms, capped by the effective grant expiry.
- Pending async deliveries default 256, configured 1–4096, including unresolved work after cancellation.
- Active routes ≤128; source fan-out ≤32; registrations default 1024 with a bounded configuration.
- No timer owned implicitly; caller supplies monotonic clock and invokes flush.
- First examples are embedded simulations; no network/native pointer/physical actuator claim.
- Every committed candidate passes TypeScript, lint, unit tests and fresh-build rendered checks.

## Review focus

- Reentrant authorization/release/sink callbacks cannot re-open a stopped generation or bypass admission limits.
- Expired command IDs cannot be replayed by extending their deadline after the original deduplication record expires.
- An async sink must see cancellation and current-generation state before applying output after an await.
- Definition metadata is immutable, bounded and JSON-only; getters/prototype-bearing/cyclic runtime objects must not become authority.
- Processor upstream loss must invalidate derived output and pending downstream commands before a later flush.

## Frozen model interfaces

```ts
type SignalValue = boolean | number | string | { x: number; y: number; z?: number };
type ValueSchema =
  | { type: 'boolean' }
  | { type: 'scalar'; unit: string; min: number; max: number; frame?: string; resolution?: number }
  | { type: 'vector'; unit: string; min: number; max: number; frame: string;
      components: readonly ['x','y'] | readonly ['x','y','z']; resolution?: number }
  | { type: 'enum'; values: readonly string[] };
type DeliveryPolicy = { mode: 'latest'; maxHz: number; maxAgeMs: number }
  | { mode: 'reliable'; maxAgeMs: number };
type PermissionOperation = 'read' | 'subscribe' | 'write' | 'invoke';
type OwnershipPolicy = { mode: 'exclusive' } | { mode: 'observe' }
  | { mode: 'partitioned'; partitions: readonly string[] };
interface DeviceCapability {
  id: string; semantic: string; schemaVersion: number;
  kind: 'sample' | 'event' | 'command' | 'property';
  value: ValueSchema; delivery: DeliveryPolicy;
  permissions: readonly PermissionOperation[]; ownership?: OwnershipPolicy;
  metadata?: JsonObject; extensions?: JsonObject;
}
interface DeviceDescriptor {
  schemaVersion: 1; id: string; label: string; revision: number;
  adapter: { id: string; version: string }; runtime: { platform: string };
  capabilities: readonly DeviceCapability[]; metadata?: JsonObject; extensions?: JsonObject;
}
type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
interface JsonObject { [key: string]: JsonValue }
parseDeviceDescriptor(input: unknown): Readonly<DeviceDescriptor>;
parseSignalValue(input: unknown, schema: ValueSchema): SignalValue;
snapshotJson(input: unknown): JsonValue; // bounded, JSON-only immutable copy
schemasCompatible(source: DeviceCapability, sink: DeviceCapability): boolean;
```

The descriptor parser accepts a JSON string or a plain data object. Core keys are closed; semantic and adapter IDs require a namespace prefix (`example:temperature`). Metadata/calibration/quality descriptions use bounded JSON metadata. Namespaced extensions are preserved without execution. Exports include `DeviceValidationError` and `DEVICE_DESCRIPTOR_SCHEMA` (draft-07); runtime limits/relational checks are annotated in the schema and exercised separately where ordinary JSON Schema cannot express them.

## Frozen embedded API

```ts
interface EndpointHandle { readonly id: string } // actual authority is object identity in a WeakMap
type Readiness = 'available' | 'unavailable' | 'busy' | 'denied' | 'stale';
interface PublishOptions {
  sequence?: number; timestamp?: number; clockDomain?: string;
  quality?: 'valid' | 'unavailable' | 'stale'; provenance?: JsonObject;
  operationId?: string; deadline?: number;
}
interface Observation {
  readonly value: SignalValue; readonly sequence: number;
  readonly timestamp: number; readonly receivedAt: number; readonly clockDomain: string;
  readonly quality: 'valid'; readonly provenance?: JsonObject;
  readonly source: { readonly registrationId: string; readonly deviceId: string; readonly capabilityId: string };
}
interface ResourceReference {
  registrationId: string; deviceId: string; capabilityId: string;
  descriptorRevision: number; schemaVersion: number;
}
interface AuthorizationRequest {
  principalId: string; applicationId: string; sessionId: string;
  source: ResourceReference; sink: ResourceReference;
  sourceOperation: 'read' | 'subscribe'; sinkOperation: 'write' | 'invoke'; partition?: string;
}
interface RouteGrant { expiresAt: number; maxAgeMs: number; maxHz?: number }
type Authorize = (request: Readonly<AuthorizationRequest>) => RouteGrant | undefined;
interface DeliveryContext {
  signal: AbortSignal; routeId: string; generation: number;
  operationId?: string; partition?: string; isCurrent(): boolean;
  reportEvidence(evidence: 'dispatched' | 'target-acknowledged' | 'observed' | 'unverified'): void;
}
interface SinkProvider {
  device: unknown; capability: string;
  apply(observation: Observation, context: DeliveryContext): void | Promise<void>;
  release(reason: string, context: Readonly<{ routeId: string; partition?: string }>): void;
}
interface RouteRequest {
  from: EndpointHandle; to: EndpointHandle;
  principalId: string; applicationId: string; sessionId: string;
  partition?: string; leaseMs?: number; queueCapacity?: number;
}
type Result<T = undefined> = { ok: true; value: T } | { ok: false; reason: string };
interface Connection {
  readonly id: string;
  start(): Result; stop(reason?: string): void;
  renew(principalId: string): Result;
  status(): { state: 'idle' | 'active' | 'closed'; reason?: string; pending: number };
  operations(): readonly OperationRecord[];
}
interface OperationRecord {
  id: string; deadline: number;
  state: 'accepted' | 'dispatched' | 'target-acknowledged' | 'observed' | 'unverified'
    | 'failed' | 'cancelled' | 'expired';
}
createDeviceRuntime(options: { now?: () => number; clockDomain?: string; authorize: Authorize;
  maxRoutes?: number; maxSubscribers?: number; maxRegistrations?: number; maxPendingDeliveries?: number }): DeviceRuntime;
// DeviceRuntime:
registerSource(provider: { device: unknown; capability: string }): EndpointHandle;
registerSink(provider: SinkProvider): EndpointHandle;
setReadiness(handle: EndpointHandle, readiness: Readiness): Result;
unregister(handle: EndpointHandle): Result;
route(request: RouteRequest): Connection;
publish(source: EndpointHandle, value: unknown, options?: PublishOptions): Result<{ accepted: number; rejected: number }>;
flush(): void;
revoke(connection: Connection): void;
close(): void;
```

Authority is synchronous for this embedded stage, frozen with concrete references before invocation. Both required operations are checked. Route limits use the intersection of source/sink descriptors and grant; incompatible delivery modes fail. A source cannot be a command and must expose read/subscribe; a sink must expose write/invoke, and command sinks use reliable delivery. Compatibility requires the same semantic/schema version and value definition independent of key order. Equivalent descriptor names never give handle authority. Reliable publishing requires a monotonically increasing positive decimal operation ID per source registration and absolute deadline, no later than the source max age; deadlines cannot be extended on duplicate IDs.

## Task 1: Device model and schema

**Files:** Create `packages/device-model/{package.json,src/{descriptor.ts,descriptor-schema.ts,sample.ts,index.ts,model.test.ts}}`; integration owner generates `schemas/device-descriptor.schema.json`.

**Consumes:** Frozen model interfaces above. **Produces:** Those exports, with immutable definitions/copies and no runtime dependencies.

- [x] Write descriptor and sample assertions using a temperature descriptor fixture, duplicate ID, finite/range/shape failures, unsupported core field, nested/cyclic metadata and boundary sizes.

```ts
assert.equal(parseDeviceDescriptor(thermometer).capabilities[0].value.type, 'scalar');
assert.equal(parseSignalValue(31.25, thermometer.capabilities[0].value), 31.25);
assert.throws(() => parseSignalValue(NaN, thermometer.capabilities[0].value));
assert.throws(() => parseDeviceDescriptor({ ...thermometer, capabilities: [cap, cap] }));
```

- [x] Run `node --experimental-strip-types --test packages/device-model/src/model.test.ts`; observe missing-module/API failure before implementation.
- [x] Implement the closed parser and JSON snapshot traversal with byte/depth/count limits, plain data-property checks, finite numbers and immutable output. Implement semantic/schema comparison and generate draft-07 schema from the reviewed vocabulary.

```ts
if (!Number.isFinite(value) || value < schema.min || value > schema.max)
  throw new DeviceValidationError('value-range');
if (new Set(capabilities.map(c => c.id)).size !== capabilities.length)
  throw new DeviceValidationError('duplicate-capability');
```

- [x] Run the model tests and schema fixture checks (Ajv) once coherent. Add the new workspace metadata/aliases without changing old package exports.
- [x] Record red/green commands in the execution record. Defer commit to the green integrated candidate because intermediate downstream tests may still be red.

## Task 2: Bounded leases and queues

**Files:** Create `packages/device-runtime/src/{lease.ts,scheduler.ts,lease.test.ts,scheduler.test.ts}`.

**Consumes:** Clock and generic observations. **Produces:** `LeaseBook.claim(key, owner, expiresAt, now): boolean`, `renew`, `release`; `LatestSlot<T>.offer/take(now,maxAgeMs)/clear`; `OperationQueue<T>.admit(id,deadline,value,now)/next(now)/settle/clear/records`.

- [x] Write tests for exclusive claim/expiry, wrong-owner renew, latest replacement, deadline expiry, full queue including active work and duplicate IDs/deadlines.

```ts
assert.equal(leases.claim('pointer', 'one', 100, 0), true);
assert.equal(leases.claim('pointer', 'two', 100, 0), false);
assert.equal(leases.claim('pointer', 'two', 200, 100), true);
```

- [x] Run `node --experimental-strip-types --test packages/device-runtime/src/{lease,scheduler}.test.ts`; observe the expected missing-module failure.
- [x] Implement expiry-aware ownership and bounded queue state. Retain settled IDs until their original deadline (or route closure), reject changed duplicate content/deadlines, reject expired admission, and refuse new records when bounded retention is full. Active work counts separately from pending dispatch but inside capacity.

```ts
if (deadline <= now) return { ok: false, reason: 'expired' };
if (records.has(id)) return { ok: false, reason: 'duplicate-operation' };
if (records.size >= capacity) return { ok: false, reason: 'capacity' };
```

- [x] Verify lease and scheduler tests; include replay with an old ID and extended deadline, route-independent ID scope, cancellation and active work capacity.
- [x] Record the coherent unit outcome; commit only with the final full gate.

## Task 3: Registry, authorized routes and facade

**Files:** Create `packages/device-runtime/{package.json,src/{types.ts,runtime.ts,index.ts,runtime.test.ts}}`, `packages/connect/{package.json,src/index.ts}`; modify workspace aliases/lockfile.

**Consumes:** Model + lease/queue exports. **Produces:** Frozen embedded API above, re-exported by `@101/connect`.

- [x] Write route tests for source/sink denial, forged handles, readiness, incompatible unit/frame, one pending pointer sample, wrong-owner renewal, release once, old generation, reentrant authority/sink/release and late async completion.

```ts
const denied = createDeviceRuntime({ now: () => 0, authorize: () => undefined });
const from = denied.registerSource({ device: phone, capability: 'pointer' });
const to = denied.registerSink({ device: screen, capability: 'pointer', apply() {}, release() {} });
denied.setReadiness(from, 'available'); denied.setReadiness(to, 'available');
assert.equal(denied.route({ from, to, principalId: 'owner', applicationId: 'demo', sessionId: 'test' }).start().ok, false);
```

- [x] Run runtime tests; observe API failure before writing composition.
- [x] Register frozen descriptors through WeakMap-bound handles. Validate immutable route requests/grants, capture concrete resource revisions and acquire per-destination/partition leases. Set closed state before cancellation, clear pending work, detach endpoints and release exactly once. Remove closed connections from runtime ownership.

```ts
if (!source || !sink) return failure('unknown-endpoint');
if (!schemasCompatible(source.capability, sink.capability)) return failure('incompatible');
const grant = options.authorize(Object.freeze(authorityRequest));
if (!grant || grant.expiresAt <= now) return failure('denied');
```

- [x] Implement publication snapshots, per-source sequencing, explicit clock-domain validation, bounded operation IDs/deadlines and separate latest/reliable dispatch. Every async continuation tests AbortSignal/current generation; context evidence only updates the matching historical record. Catch authority/provider failures and release safely. Reentrant flush is ignored, with new work left for the next caller flush.
- [x] Verify runtime tests and TypeScript. No implicit timeout loop and no browser/network/OS API access. Record integration result.

## Task 4: Two consumers and regression evidence

**Files:** Create `examples/device-pipelines/{pointer.ts,sensor-feedback.ts,threshold.ts,run.ts,README.md}`, `tools/generate-device-schema.mjs`, `tests/device-pipelines.test.ts`, `tests/device-platform-boundary.test.ts`; update root example script and platform docs.

**Consumes:** `@101/connect` only. **Produces:** `runPointerExample()` and `runSensorFeedbackExample({feedback?: boolean})`, standalone runnable references with structured outputs, plus public API documentation.

- [x] Write integration assertions before consumers exist, including pointer coordinate mapping at different surface dimensions, busy/release, preserved temperature/provenance, both processor legs authorized, hysteresis, unavailable/old readings and unverified feedback.

```ts
assert.deepEqual(runPointerExample().position, { x: 200, y: 400 });
const result = runSensorFeedbackExample({ feedback: false });
assert.equal(result.temperature, 31.25);
assert.equal(result.operation.state, 'unverified');
```

- [x] Observe the focused missing-consumer failure. Implement readable explicit declarations, two route legs and a local threshold processor that resets/invalidate derived source on upstream loss. The output simulator supplies observed feedback independently; no physical operation is performed.
- [x] Add the CLI (`npm run example:devices`) and package import/dependency graph tests. Add `examples` to bounded unit discovery only if tests are stored there; otherwise keep tests under existing roots. Make installed Ajv 6.15.0 explicit for schema checks, generate standalone schema once, and update license inventory if dependency contents change.
- [x] Run the two examples and focused suites. Obtain one independent read-only review of the frozen implementation, repair concrete findings with regression-first tests, then freeze again.
- [x] Run the complete candidate gate: `npx tsc --noEmit`, `npm run lint`, `npm run test:unit`, `npm run build`, `node --test tests/rendered-html.test.mjs`; check `git diff --check`. Commit the green candidate with the acceptance record and report embedded scope separately from future network/hardware work.

## Execution record

- 1 October: owner approved starting code. Ruling: execute the reviewed foundation now in the current checkout, with disjoint file ownership; the direct request to code takes precedence over another plan-confirmation round.
- Baseline: `a5ab3df`, clean main, one integration checkout, 457 unit tests and 31 rendered checks already green for the unchanged baseline.
- Ruling: descriptor/schema lane can run concurrently with independent lease/queue logic; shared generated schema, root configuration and lockfile stay with the integration owner.
- Ruling: embedded source/sink composition proves the processor boundary without a premature dynamic processor registry. The cost is explicit two-leg authoring in the examples, which the later recipe layer can simplify.

- Model lane: missing-module red, then 12 green tests; aggregate traversal-budget regression failed before the incremental byte/node bound fix. Targeted types/lint passed.
- Lease/queue lane: missing modules red, then 6 green tests; decimal monotonic IDs retain bounded replay protection after history expires.
- Runtime lane: missing API red; regressions exposed same-flush derived dispatch, unbounded unresolved replacement work and missing partition context. Each failed before its repair.
- Independent review exposed reliable pacing, stale quality lifecycle effects and lost late async evidence; all three were reproduced with failing tests and repaired.
- Consumer lane: missing consumers red; output-admission recovery and aged-reading deadline regressions failed before fixes. Nine integration tests and the deterministic CLI pass.
- Schema boundary: absent schema red, generated byte-identical export green. No expanded test discovery roots.
- Implementation ruling: registry and route composition stay together in runtime.ts with separate public types, leases and scheduler; shared internals remain private to the package. Both examples share one folder and CLI.
- Implementation ruling: publish returns admission counts, never a claim of output delivery. Fan-out can partially admit; no automatic retry. Reliable source IDs are monotonic per registration; re-registering is an explicit new generation.
- Implementation ruling: route and partition context reaches release; the global unresolved-delivery budget remains occupied until the provider settles, including closed routes. Async records stay pinned until completion, with bounded subsequent retention.

- Final verification: 503 unit tests, 31 fresh-build rendered checks, TypeScript, lint, build and deterministic examples pass. Independent review has no remaining actionable findings. Full evidence is in docs/platform/FOUNDATION-QA-2026-10-01.md. The completed scope is embedded stage 1; remote/native/connector stages remain open.
