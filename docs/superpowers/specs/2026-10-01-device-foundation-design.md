# Device platform foundation design

Status: proposed for owner review, 1 October 2026. Implements stage 1 of [the platform design](2026-10-01-universal-device-platform-design.md), after its written implementation plan is reviewed. None of the API names below is shipped yet.

## One observable outcome

A developer imports `@101/connect` without any game package and runs two embedded examples: a touch-position source drives another application surface, and a temperature sample drives a simulated relay through an explicit threshold processor. Both examples enforce resource grants and ownership, preserve signal meaning, and recover from loss or revocation. The first step establishes a usable public boundary before internet transport, native OS cursor control or physical actuation is added.

The phone/browser network path is stage 2. This foundation's examples use embedded providers and a deterministic harness; they must be labeled that way. No internet or physical device compatibility is inferred from these tests.

## Owned paths and dependencies

| Proposed path | Responsibility | Allowed dependencies |
| --- | --- | --- |
| `packages/device-model/src/descriptor.ts` | Descriptor/schema types and bounded parser | Standard library only |
| `packages/device-model/src/sample.ts` | Value, quality and freshness validation | Descriptor types |
| `packages/device-model/src/index.ts` | Model exports | Own package |
| `packages/device-runtime/src/registry.ts` | Registered endpoint handles and readiness | `@101/device-model` |
| `packages/device-runtime/src/route.ts` | Route lifecycle, grant checks and source/sink schema compatibility | Model/registry |
| `packages/device-runtime/src/lease.ts` | Exclusive ownership, renewal, expiry/release | Standard library |
| `packages/device-runtime/src/scheduler.ts` | Bounded latest sample and event/command admission | Model |
| `packages/device-runtime/src/index.ts` | Composition and runtime exports | Own package |
| `packages/connect/src/index.ts` | Public facade with readable types | Model/runtime |
| `examples/phone-pointer/` | Embedded absolute-pointer source/sink reference | `@101/connect` |
| `examples/sensor-feedback/` | Temperature → threshold → simulated relay/feedback | `@101/connect` |
| `examples/sensor-feedback/threshold.ts` | App-owned typed processor, hysteresis, provenance and reset | `@101/connect`; no dynamic code loading |
| `schemas/device-descriptor.schema.json` | Editor/tool contract matching runtime parser | Generated or maintained from reviewed model |
| `tests/device-platform-boundary.test.ts` | Public import and dependency-direction integration | New packages/examples |
| Root tooling | Workspace/type aliases, Node unit discovery compatibility | Minimal changes to `tsconfig.json`, package metadata and lockfile |

Keep current `@101/protocol`, `@101/input`, `@101/session`, `@101/sdk`, native target files and game semantics unchanged in this stage. This is a dependency boundary, not an excuse to fork existing behavior. Extraction/reuse happens through the next transport/application bridge spec. Package exports remain compatible with the repository's current TypeScript workspace tooling; distributable JavaScript/C/Swift/Kotlin bindings are later independently tested targets.

## Minimal descriptor contract

`DeviceDescriptor` contains `schemaVersion: 1`, an opaque descriptive `id`, a human label, a positive revision, adapter name/version, runtime platform, and an array of capabilities. The embedded registry binds each descriptor to a trusted local registration; descriptor IDs do not authenticate callers.

Each capability contains a unique per-device ID; a namespaced semantic ID and schema version; kind (`sample`, `event`, `command`, `property`); a value schema; delivery policy; permission requirements; and ownership policy where it can change output. Definitions are immutable at a descriptor revision. Mutable readiness (`available`, `unavailable`, `busy`, `denied`, `stale`) belongs to the registered provider's status, independent of that definition. Media/render resources may appear only as unsupported extension metadata in this stage; the runtime cannot advertise a working route for them.

Value schemas support boolean, finite scalar, bounded two/three-component vector and bounded enum. Scalars/vectors have explicit unit and, where relevant, coordinate frame and representable range. Bundled examples use UCUM `Cel`, `kg` and `1`; unknown units may be preserved as opaque semantics, but automatic unit conversion is unavailable without an explicitly registered converter. Matching checks require identical unit/frame/schema or a registered typed processor. Booleans have no physical unit. Optional precision/calibration/quality metadata survives unchanged.

Parser limits: UTF-8 descriptor at most 64 KiB; at most 128 capabilities; IDs/semantic/frame/unit strings at most 128 characters; labels at most 160 characters; enums at most 64 values with 128 characters each. IDs reject control characters and are compared as exact strings. Revisions are integers from 1 through 2³²−1; sample rates are integers from 1 through 1000 Hz; maximum age is an integer from 1 through 60000 ms. Numeric range values are finite and ordered, vector values are objects with exactly their declared x/y[/z] components, and duplicate capability IDs fail. Core unknown properties fail except within a namespaced `extensions` object bounded by the descriptor byte ceiling, depth 8, and 128 entries per container; extensions are data and grant no operation. No parser fetches a schema or URL.

Illustrative authoring format, proposed:

```json
{
  "schemaVersion": 1,
  "id": "demo-thermometer",
  "label": "Room temperature",
  "revision": 1,
  "adapter": { "id": "example:temperature", "version": "1.0.0" },
  "runtime": { "platform": "embedded-test" },
  "capabilities": [{
    "id": "temperature",
    "semantic": "example:temperature",
    "schemaVersion": 1,
    "kind": "sample",
    "value": { "type": "scalar", "unit": "Cel", "min": -40, "max": 125 },
    "delivery": { "mode": "latest", "maxHz": 10, "maxAgeMs": 5000 },
    "permissions": ["subscribe"]
  }]
}
```

The public JSON Schema and runtime parser must accept/reject the same fixtures. WoT import/export is a subsequent connector/model task; this example is not presented as a conformant Thing Description.

## Embedded runtime contract

The runtime is created with an injected monotonic clock and a host-supplied authorization authority. Registration returns opaque source/sink handles bound to the trusted registered capability. Publication cannot select another device identity or destination arbitrarily. Untrusted descriptions remain inert until the host registers a provider and grants the requested route.

Proposed facade operations are `registerSource`, `registerSink`, `route`, `publish`, `setReadiness`, `renew`, `flush`, `revoke` and `close`. Registration checks descriptors and enforces supported direction/kind. A route returns a typed lifecycle/result and exposes `start` and `stop`; source/sink callbacks are explicit. A provider starts unavailable until explicitly ready. Changing readiness suspends affected routes and applies their release policy. The detailed implementation plan will freeze exact signatures before downstream work uses them.

Route activation requires the authority to approve source read/subscribe and sink write/invoke for the requesting principal/application/session. The request binds concrete registration handles, capability/schema revisions, operation, ownership and rate/expiry limits. A parsed grant is not authority; only the host authority can issue the effective permission. This is an embedded trust model, not a substitute for network authentication or signed grants in stage 4.

For this stage, processing is explicit application-owned composition: the app registers a typed temperature input sink and a separate boolean derived source, then creates an upstream and a downstream route. The same authority checks both legs; registration of a processor's output grants no right to read the physical input or invoke the final output. The processor's input/output descriptors identify compatible schemas, and derived observations carry source observation identity/time/quality plus processor name/version/configuration revision in bounded provenance metadata. The facade does not yet insert a `via` processor automatically or execute a recipe. A general processor registry/composition API is specified in its later ecosystem stage.

Ownership defaults to exclusive for pointer/control/command sinks. Observer sample subscribers can coexist under explicit grants and fan-out limits. Partitioned application sinks may expose named partitions; each partition has its own lease. A merge policy must be registered explicitly, and no magnitude or last-writer rule is assumed for all signals. Initial examples exercise exclusive and observer behavior; arbitrary merge algorithms are not bundled.

Lease expiry or revocation stops the route, drops pending work, detaches subscriptions and invokes the sink's release/safe-state callback exactly once for that route generation. A state-changing sink must supply that callback at registration. Initial embedded lease duration defaults to 1500 ms and is configurable from 1 through 30000 ms; renewal must occur before expiry and cannot exceed the effective grant's expiry. Lease renewal validates the current owner/generation/grant; another principal cannot renew or take ownership. Reconnecting obtains a new registration/route generation and cannot revive old publications or commands. Removing a source/sink releases all affected routes.

The runtime owns no implicit endless interval. `flush(now)`/expiry checks use the injected clock; an embedding app may supply its own lifecycle-managed tick. Closing is idempotent and disposes callbacks and pending state. On revoke/expiry, mark the generation closed before dropping queues, request cancellation of in-flight work through its AbortSignal, then invoke the sink's release callback without waiting for that work. Cancellation is a request, not proof that a dispatched physical operation was undone. A sink checks the generation/cancellation signal before applying output after an await; it cannot mutate a later generation. Async completion from a closed generation remains historical operation evidence and cannot re-activate the route.

## Scheduling and sample meaning

Latest-sample storage is one pending value per active route. New publications replace the pending value, subject to age and byte/count limits; the negotiated maximum rate limits dispatch, with excess publications coalesced. `flush` forwards only current, valid, authorized samples with the matching generation. Payloads are immutable snapshots so mutation after publication cannot change a checked value. Invalid/out-of-range/nonfinite samples are rejected, not clamped or converted silently. A route's effective maximum rate/age is no more permissive than its descriptor and grant.

Pointer example uses recoverable absolute position in a `surface-normalized` frame with two dimensionless coordinates in `[0,1]`. Resize changes rendering from normalized position to the sink's available area. The later relative-trackpad transform must accumulate unsent deltas or use a recoverable target; it cannot use replacement on independent deltas.

Reliable event/command admission has a configured finite capacity (default 64, allowed 1–256), operation ID, deadline and duplicate policy. Active plus queued operations count toward that capacity; settled deduplication records have a bounded deadline/retention and count. Each serialized operation is at most 4 KiB in this stage. Overload rejects a new operation with a typed busy result; it never silently grows memory. Commands are not retried automatically. Expired commands cannot invoke the sink. If a sink completes after its route was revoked, the runtime records the operation's actual evidence without resuming the route or fabricating success. Embedded defaults cap active routes at 128 and subscribers per source at 32; exceeding either returns an explicit capacity result.

Source timestamp and clock domain are preserved, with local receipt time attached. Embedded examples use the injected shared clock. Unknown remote clock offsets are not converted into misleading latency numbers. Missing/unavailable quality never causes a default zero, false or a new actuator command. The initial simulator makes no physical safety claim.

## Two reference examples

1. **Application pointer:** explicit embedded source and sink registrations → approved exclusive route → sample `(0.2,0.8)` → target surface pointer at those normalized coordinates → source loss/revocation releases input. Second participant gets `busy` until a permitted transfer/release. The example is independent of any game, protocol peer or OS cursor API.
2. **Sensor feedback:** temperature capability preserves `31.25 Cel` → app-owned threshold input sink consumes `Cel` and publishes through its registered boolean source → separately granted `relay.set` command route → simulated relay returns `dispatched` and a separate observation produces `observed`. The simulator can disable feedback, in which case the operation remains `unverified`. `NaN`, unknown unit, stale reading or unavailable quality cannot turn on the relay. Repeated identical set-state commands are idempotent by example contract; toggle retries are not invented.

The example processor declares input/output schema compatibility and version. It is trusted explicit code supplied by the app, not a script downloaded from a description. Threshold configuration includes a unit and hysteresis to prevent noisy values from repeatedly switching state. Its subscription/status teardown resets hysteresis and marks the derived source unavailable on upstream loss or revocation; downstream queued commands are dropped and the simulator release policy runs. It never promotes unavailable/stale input to valid output, and it releases both legs on close.

Examples include a short README and standalone runnable integration harness. They show readable declarations and variables; they do not prompt for real sensor/actuator access or claim physical pairing. Browser/native rendered demonstrations are supplied by stage 2 after transport integration.

## Acceptance tests for this stage

| Boundary | Required passing behavior |
| --- | --- |
| Descriptor | Duplicate resources, malformed limits, excessive bytes/counts, control characters and unknown core fields fail; bounded extension survives |
| Measurement | `31.25 Cel` and `2.5 kg` retain values/units; `NaN`, infinity, invalid vector shape/range/quality fail |
| Compatibility | Temperature cannot route to a boolean sink without the registered processor; unit/frame mismatch is explicit |
| Public SDK | Both examples import only `@101/connect`; platform package dependency graph has no game/application imports |
| Authority | Denied source or sink grant prevents route start; copied descriptor/ID cannot supply another source's handle |
| Ownership | Concurrent exclusive claims return busy; wrong owner/generation cannot renew; release/expiry permits a new authorized claim |
| Latest data | Many queued samples retain one current value; stale/revoked/old-generation/mutated samples do not reach the sink |
| Reliable commands | Full queue rejects; expired command does not run; duplicate operation does not double invoke; ambiguous feedback stays unverified |
| Lifecycle | Source/sink removal, revoke, stop and close release once and leave no subscription/timer/pending work |
| Async race | No new dispatch after revoke; in-flight work receives cancellation and release without blocking; late completion is historical only and cannot apply into a new generation |
| Processor | Both route legs require grants; provenance and quality survive; hysteresis, unit/quality rejection, unavailable output and reset are exercised by the simulator |
| Schema tooling | Public schema and authoritative runtime parser agree on accepted/rejected fixtures |
| Regression | Fresh build and all AGENTS.md gates pass on each committed candidate; existing 101 contract tests remain green |

Before implementation, the written plan must include exact signatures, fixture definitions, expected red/green focused tests, integration callers, and the full commit gate. After this stage, a separate transport-bridge spec defines physical phone/browser integration, security-boundary mapping and migration of the existing 101 host. Remote connectivity and OS pointer claims remain unavailable until their corresponding stages pass.
