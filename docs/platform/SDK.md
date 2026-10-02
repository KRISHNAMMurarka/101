# Device SDK

The first platform implementation connects typed providers inside one application process.
`@101/connect` exports the device model, embedded routing API and bounded peer resource bridge without game dependencies.
The runnable [examples](../../examples/device-pipelines/README.md) use simulated providers.
The [platform stages](../superpowers/specs/2026-10-01-universal-device-platform-design.md)
describe native agents, media, discovery and connector work still to come. The authenticated peer bridge and actual browser enrollment screens have local Chromium runtime evidence. Native screen/storage/bridge runtime and physical qualification remain open.
The [master checklist](MASTER-CHECKLIST.md) is the canonical implementation and release task ledger.

## Platform threat model

S01's reusable model is retained in Codex Security's repository-bound persistent
collection as `threat_model.md`, reviewed against
`5bb84e6ce691845d2ac85aac092dd06ed7a9ae57`. Read it through
`read_codex_security_artifact` with this repository's absolute root as `targetPath`,
`storage: "persistent"` and `path: "threat_model.md"`. The managed artifact is local
to this host; it is not included in a package or published by this documentation.
Its digest, target identity, readback verification and review scope are recorded
in [task evidence](task-evidence.json), record `threat-model-enrollment-2026-10-02`.
The exact previous body remains in the same managed collection as
`artifacts/01_context/threat_model-4af38ec.md`.

The model covers network peers, owner grants, native privilege, package and
processor execution, directory membership, media/privacy, gateways and operators.
It separates implemented controls from future requirements and hypothetical
attacker stories from validated findings. A fresh independent architecture review
and integration-owner verification checked the material consumers and startup
paths; 272 citations across 71 committed source paths have valid line bounds.
It records endpoint identity, issued facade and actual caller enrollment controls,
resolves the earlier missing watch-source and diagnostic-caller claims, and keeps
legacy HTTP pairing, native runtime and broader qualification gaps explicit.
This closes the persisted model deliverable, not endpoint authentication or S16's
independent security validation. Update the model when a new trust boundary is
implemented, preserving earlier failures and documentation discrepancies.

## Start with a provider

A description says what a device can expose. A registration binds that description to
trusted host code. A route binds concrete source and sink registrations to one principal,
application and session. Labels and descriptor IDs do not authenticate a caller.

```ts
import { createDeviceRuntime } from '@101/connect';
import type { EndpointHandle } from '@101/connect';

let from: EndpointHandle, to: EndpointHandle;
const runtime = createDeviceRuntime({
  authorize(request) {
    if (request.principalId !== 'owner' || request.applicationId !== 'pointer-demo' ||
        request.sessionId !== 'session-1' || request.source.registrationId !== from.id ||
        request.sink.registrationId !== to.id || request.sourceOperation !== 'subscribe' ||
        request.sinkOperation !== 'write') return undefined;
    return { expiresAt: performance.now() + 10000, maxAgeMs: 100, maxHz: 60 };
  },
});
from = runtime.registerSource({ device: touchDescription, capability: 'position' });
to = runtime.registerSink({
  device: surfaceDescription, capability: 'position',
  apply(observation, context) {
    if (context.isCurrent() && !context.signal.aborted) renderPointer(observation.value);
  },
  release(reason, context) { clearOwnedPointer(context.routeId); },
});
runtime.setReadiness(from, 'available');
runtime.setReadiness(to, 'available');
const route = runtime.route({ from, to, principalId: 'owner',
  applicationId: 'pointer-demo', sessionId: 'session-1' });
const started = route.start();
if (started.ok) {
  runtime.publish(from, { x: 0.2, y: 0.8 });
  runtime.flush();
}
runtime.close();
```

`touchDescription`, `surfaceDescription` and the rendering callbacks are application code;
complete declarations appear in [pointer.ts](../../examples/device-pipelines/pointer.ts).
The authority callback is synchronous and trusted. It must approve both operations using
the supplied concrete resource references. A descriptor's permission list declares supported
operations; it does not grant access. Applications must not expose this embedded authority
API directly to untrusted network callers.

## Bind a remote provider

`PeerDataTransport` owns raw reliable/disposable WebRTC lanes and captures an immutable current-generation offer/answer only after complete ICE gathering. `AuthenticatedResourcePeer` signs a transcript containing those exact SDP bytes and fingerprints, bilateral fresh challenges, endpoint keys, roles and locally expected application/session/epoch. P-256/SHA-256 signatures use established cryptographic providers. Both owners compare the full verified digest and confirm enrollment, or supply already enrolled remote key pins. Application packets and resource scopes stay closed until both endpoints finish. Code possession and encryption alone do not establish endpoint identity.

`RemoteResourcePublisher` and `RemoteResourceReceiver` require an issued authenticated facade by default. They may be constructed while enrollment is pending but cannot describe, bind or deliver resources yet. Receiver application/session and both endpoint roles/epochs must match the facade's locally chosen scope. Raw peers or copied scope objects cannot substitute. Explicit `authentication: 'local-diagnostic'` permits lab/contract fixtures and establishes no authenticated provenance. Browser/native pointer labs and the Studio input consumer use issued facades; they no longer use that exemption.

The receiver captures immutable principal/application/session scope. After owner approval, private slots map to embedded source registrations and an application-owned sink. Packets never select registrations or authority. Endpoint authentication remains separate from per-resource owner approval and the embedded runtime's route grant.

`createWebCryptoIdentityStore()` explicitly creates and persists nonextractable WebCrypto private keys in IndexedDB; `load()` leaves missing storage absent. Captured keys fail after loss, deletion or replacement. Local removal/close invalidates peers synchronously; external storage loss is checked every second and has a two-second freshness bound. `createEphemeralWebIdentity()` is session-only. Native `createNativeIdentityStore()` uses the local Expo module's fixed Keychain/AndroidKeyStore identity and the same signature contract. iOS uses a software SecKey in Keychain; neither native provider infers hardware backing. Persisted iOS lifecycle and actual Expo bridge invocation remain unverified. See [endpoint authentication evidence](ENDPOINT-AUTH-QA-2026-10-02.md).

The complete [remote pointer surface](../../examples/device-pipelines/remote-pointer.ts) supplies both typed profiles, explicit owner selection, scoped host authorization, geometry and release. Run `node tools/qa-authenticated-peer.mjs chromium` for two browser pages with separate persisted identities, bilateral comparison and typed pointer routes. `qa-resource-peer.mjs` retains its explicit raw diagnostic scope. Values are generated by both harnesses; neither is a phone touch or OS pointer test. Local compiled ESM tarballs now support an external consumer of the current general SDK; full K01/K02 qualification remains open.

`receiver.approve()` intersects source/sink policy and owner limits. The embedded runtime independently authorizes the route. Optional `RouteRequest.constraints` can only narrow that host grant and is snapshotted; it caps renewal, queued dispatch and asynchronous `isCurrent()` at owner expiry. `connection.limits()` returns immutable effective limits only while active. An incompatible or narrowed actual limit releases before delivery and requires current approval.

The bridge uses JSON/1 for arbitrary declared values and reliable events. A negotiated 48-byte `normalized-pointer/1` sample codec preserves normalized x/y within 2^-25 absolute error; Celsius and other sensors retain their units and JSON values. Unknown fields, codecs, slots, epochs, schemas, lanes and replay reject. Samples retain one unsent state per slot; reliable cadence queues cap at 64 and expire rather than replay old edges. `publish()` true means bounded sender admission, never receipt or effect.

Drive `tick()` from an owned lifecycle timer and cancel it on stop. A matched clock exchange establishes an offset interval with drift/uncertainty. Remote capture/deadlines translate conservatively into the embedded clock, with raw clock IDs/times retained as provenance; subtraction across clocks is not a latency measurement. Invalid mapping, provider loss, grant/deadman expiry, disconnect or explicit stop releases owned output. Stop is terminal; reconnect constructs fresh bridges with a fresh enrolled epoch and repeats description, approval and formats.

## Drive a pointer source

`pointerSourceDescriptor()` declares normalized Position and reliable boolean Contact. `PointerResourceProvider` waits for both actual open lanes and both selected capabilities before exposing `driver()`. Its shared driver anchors the first contact locally, accumulates relative movement into recoverable absolute targets and preserves capture time until sender admission. Call `begin(id,x,y,width,height)`, `move(...)`, `end(id)`, or equivalent `nudge(dx,dy)` and `setContact(boolean)`. Measured resize reanchors; competing contacts are ignored. Driver methods may accept a coalesced local change without a publication. `lastAdmission` is only the most recent individual sender admission result.

```ts
import { PointerResourceProvider } from '@101/connect';

const provider = new PointerResourceProvider({ peer, epoch, clockId,
  now: () => performance.now(), platform: 'browser', available: () => foreground });
const timer = setInterval(() => provider.tick(), 10);
// Actual measured source event; driver is absent before receiver selection.
provider.driver()?.begin(pointerId, localX, localY, width, height);
// On stop, hide or unmount:
clearInterval(timer); provider.stop(); await peer.disconnect();
```

The `/pointer-lab` browser example, native `PointerLab` and Studio receiver explicitly load or create local identities. Each logical browser endpoint has its own IndexedDB namespace. The receiver creates a five-minute `createReceiverInvitation` for its locally owned application/session and fresh epoch. The source parses it with `decodeReceiverInvitation`, reviews that exact target and separately chooses to connect. Invitation parsing and possession supply no authority. Both screens compare the full verified digest and independently confirm enrollment before the receiver separately approves one minute of Pointer/Contact or aim/trigger. Invitation expiry is checked at final confirmation and synchronously on remote admission; an admitted resource grant has its own lifetime. Identity removal, hide and unmount retire owned input; reload and navigation close the current identity store.

Manual `encodeManualPeerCode`/`decodeManualPeerCode` exchange has a closed 64KiB envelope, expected offer/answer and receiver-owned epoch; code possession does not establish endpoint key identity. The independent receiver scales normalized coordinates to its actual measured surface. [Enrollment UI QA](ENDPOINT-ENROLLMENT-UI-QA-2026-10-02.md) records real browser pointer/key events, both owners' actions, rejection and recovery. Native exports verify source integration, not actual native screen interaction. Physical phone acceptance and native touch movement qualification remain open in [pointer QA](POINTER-PROVIDER-QA-2026-10-02.md).

`createNativePeerPort(nativePeer, makeDescription, {unsetDeliveryLimit})` injects installed native producer APIs without importing React Native into the shared package. Native sources initiate their own channels because Android's incoming-channel metadata cannot establish disposable delivery. Android uses unset `-1`; iOS uint16 getters expose `65535`. Select this explicitly from the host platform. The iOS sentinel is normalized only for locally created omitted options; explicit finite and incoming values remain unqualified. Native JS sends are asynchronous bridge posts, so the adapter reserves bytes and at most 256 commands synchronously. An owned stats loop may retire only coherent sent prefixes from the same negotiated channel/stat identity. Missing statistics retain reservations; these counters establish native handoff rather than receiver effect. The native caller stops visibly when measurements or admission fail.

The [game pointer bridge](../../examples/device-pipelines/game-pointer-bridge.ts) is application-owned. Its owner explicitly supplies manifest control names, permitted `mapping.source`, role and principal/application/session. The Input Lab selects `custom`; a descriptor or remote platform does not prove physical touch. Position and Contact keep independent sequences, map to aim/trigger and retire only their owned InputBus channels. Shared platform packages remain game-independent.

## Descriptions and signal meaning

`parseDeviceDescriptor(unknown)` accepts JSON text or plain data and returns a frozen snapshot.
Core fields are closed. Namespaced extension data is preserved and never executed.
`parseSignalValue(value, schema)` validates a boolean, scalar, exact x/y[/z] vector,
enum, bounded record or bounded array. Records declare closed member schemas and
an optional-member list; arrays declare item schemas and integer min/max lengths.
The result is a deep frozen inert snapshot, including every nested member.
Values retain their units and coordinate frame; out-of-range values fail rather than clamp.
`schemasCompatible(source, sink)` requires matching semantic ID, schema version and complete
value definition. A conversion or algorithm needs explicit application-owned processing.

Structured remote samples and events negotiate `json/2` value envelopes with
connect version 2. Description/control messages remain version 1. Primitive-only
devices keep their existing codec list and `json/1` bytes. A structured capability
cannot bind `json/1` or the compact pointer codec. Compatibility includes recursive
member definitions, optionality and array bounds; record-field ordering is inert.

The [telemetry batch](../../examples/device-pipelines/telemetry-batch.ts) declares
timestamped resident-memory readings and optional v2 quality. Its explicit v1→v2
adapter validates each version and labels migrated readings `unverified`. Timestamp
members retain the application's source clock domain; the remote bridge translates
only the observation timestamp. Clean installed SDK QA additionally publishes an
actual `process.memoryUsage().rss` reading through an authorized embedded route.

Wire packets and runtime observation/options envelopes each have a separate 4 KiB
limit. Provenance consumes runtime space, so a wire-valid batch may still fail host
admission. Sender success does not prove host delivery or effect. Wire overflow
fails before queueing or consuming IDs. A runtime `payload-limit` rejection reports
the reason and preserves the grant without advancing received IDs or freshness.
A smaller batch can recover; repeated rejected data cannot extend the deadman.

The [editor schema](../../schemas/device-descriptor.schema.json) is generated with
`npm run schemas:devices`. Standard schema validation covers structure; annotations identify
parser-only finite-number, relational, byte, depth and plain-object constraints.

| Limit | Value |
| --- | --- |
| Descriptor UTF-8 bytes | 64 KiB |
| Capabilities / entries per container | 128 / 128 |
| Identifier, unit, semantic, frame / label | 128 / 160 Unicode characters |
| Extension and metadata nesting | 8 |
| Structured schema depth / total nodes | 4 / 256 |
| Record fields / declared array maximum | 1–32 / 0–128 |
| Wire value / full runtime observation-options envelope | 4 KiB / 4 KiB independently |
| Descriptor rate / maximum age | 1–1000 Hz / 1–60000 ms |
| Active routes / subscribers per source | At most 128 / 32; configurable downward |
| Registered endpoints | Default 1024; configurable 1–4096 |
| Reliable records per route | Default 64; configurable 1–256 |
| Unresolved deliveries across the runtime | Default 256; configurable 1–4096 |
| Ownership lease | Default 1500 ms; configurable 1–30000 ms |

## Publication and scheduling

`publish(handle, value, options?)` returns `{ ok: true, value: { accepted, rejected } }` or
`{ ok: false, reason }`. Counts describe queue admission. They do not prove dispatch, receipt
or physical effect. Latest data without a route can return zero accepted.

Latest routes keep one pending absolute value and coalesce later values. Reliable routes
retain bounded commands with an increasing **positive decimal operation ID per source
registration** and an absolute deadline in the runtime's clock domain:

```ts
runtime.publish(commandSource, true, { operationId: '1', deadline: now() + 500 });
```

An old ID cannot be replayed with a later deadline, even after its history expires. Source
sequence numbers increase through 2³²−1. A new source registration establishes a new generation;
there is no implicit counter wrap. Fan-out may partially admit: inspect each connection's
`operations()` to determine which route accepted an ID. Resubmitting that same ID is rejected;
the SDK does not automatically retry a command or promise atomic multicast.

The injected `now` clock must be finite, nonnegative and monotonic. Default time is
`performance.now()`. Publication timestamps must belong to `clockDomain`, must not be in the
future and must remain within the source's maximum age. Sequence, time and clock checks apply
to loss reports too. Valid `quality: 'unavailable' | 'stale'` reports invalidate affected routes;
they never become zero or false measurements. A bad or backward host clock closes the runtime.

Effective age and rate are the intersection of descriptors and the authority grant. Both
delivery lanes obey that cadence. Reliable routes dispatch at most one command per flush;
the host's tick frequency may reduce throughput further. Each `flush()` freezes its work
before calling providers. Work produced by a processor waits for a later flush.

## Ownership, cleanup and async providers

Registrations begin unavailable. Marking either endpoint unavailable, busy, denied or stale
closes affected connections. Recovery requires a new connection. Sinks default to exclusive
ownership; explicit `observe` ownership permits coexistence, while named partitions get
separate leases. Partition-aware providers use `context.partition` and release only their
owned route/partition state.

`route.renew(principalId)` renews an active owner's lease before expiry, capped by the original
grant expiry. It cannot revive an expired route or extend a grant. Stop, revoke, unregister,
expiry and close revoke authority before requesting cancellation and calling `release` once.
The runtime creates no timers: the embedding application owns a lifecycle-managed tick and
calls `flush()` and renewal. A provider awaiting work must check `context.isCurrent()` and
`context.signal.aborted` again before applying output.

Cancelled providers remain inside the global workload budget until their promises settle.
Unresolved operations pin bounded history; after settlement, records remain until at least
1000 ms after completion and their original deadline. Historical evidence may change without
reopening authority. A hanging provider can exhaust the budget; pending work then waits or
expires. Cancellation cannot undo an effect that has already occurred.

## Processing and evidence

The [temperature example](../../examples/device-pipelines/sensor-feedback.ts) composes an
input sink and derived output source. Source-to-processor and processor-to-relay routes each
need a grant. Derived provenance retains original measurement identity, time, quality and
calibration, plus processor version and configuration. Upstream loss resets hysteresis,
invalidates the derived source and cancels queued commands.

`connection.operations()` separates `accepted`, `dispatched`, `unverified`,
`target-acknowledged`, `observed`, `failed`, `cancelled` and `expired` evidence. Successful
callback return supplies `unverified` evidence. Trusted providers can report acknowledgment
or observation through `context.reportEvidence()`. Only independent feedback should establish
an observed effect. The example's separate simulated state read demonstrates this distinction.

## Explicit measurement conversion

`createUnitConverter(sourceSchema, targetSchema, { decimalPlaces,
maxAbsoluteError })` is an opt-in processor primitive for numeric scalar and
vector schemas. Source and target must have the same shape, components and
reference frame. It recognizes reviewed pairs within temperature (`Cel`, `K`),
length (`m`, `cm`, `mm`), angle (`rad`, `deg`), time (`s`, `ms`), mass (`kg`, `g`)
and information (`By`, `KiBy`). Dimensionless `1` and structurally valid unknown
unit tokens convert only to themselves. No route or wire packet invokes it
automatically. `parseUnitToken()` validates conversion spelling without
changing descriptor/1's accepted unit strings. `schemasCompatible()` still
requires exact units.

The converter validates complete source/target ranges, output decimal precision,
transformed source resolution and a conservative absolute error budget before it
can be used. Each call validates input and rounded output against their schemas.
Its immutable metadata states scale, offset, precision and numeric error bound;
that bound covers declared quantization and arithmetic, not sensor calibration
or physical measurement accuracy. A processor must retain its own calibration
and quality evidence. The [resident memory example](../../examples/device-pipelines/telemetry-batch.ts)
offers `publishResidentKiBy()` as an explicit `KiBy` to `By` path and carries the
conversion metadata in provenance. Its normal `publish()` accepts declared
bytes. [M06 evidence](UNITS-QA-2026-10-02.md) is local model/runtime and installed
SDK evidence, not a physical device claim.

Workspace packages expose TypeScript source for the repository's existing tools.
`npm run build:sdk -- HEAD` separately compiles an explicit immutable revision/tree
into five local ESM tarballs under a fresh ignored `release/sdk-*` directory.
The manifests define JavaScript/type roots, schema subpaths and facade example
subpaths. They include MIT licenses, public readmes and compiled/source examples;
private implementation subpaths and install scripts are absent. Workspace exports
and app/native dependencies retain their existing source contract.

Install all five matching tarballs outside this repository with
`npm install --offline --ignore-scripts --no-audit --no-fund /absolute/path/to/tarballs/*.tgz`.
Then run `node node_modules/@101/connect/examples/run.js` with ordinary Node.
Verify the actual artifact set with
`node tools/qa-sdk-consumer.mjs /absolute/path/to/release/sdk-*/manifest.json`,
passing one concrete manifest path. [Distribution QA](SDK-DISTRIBUTION-QA-2026-10-02.md)
records strict external types, installed bytes, module identity and browser
runtime checks. Public facade declarations include browser APIs; TypeScript
consumers, including Node consumers, need `ES2022`, `DOM` and `DOM.Iterable` in
their configured libraries. Node 24.14.0 and TypeScript 5.9.3 are verified here; the declared
Node 22.13 minimum, other compiler/OS toolchains and physical WebRTC are unverified.
These are local dry runs of the current API, with no registry publication.
Swift/Kotlin/C bindings and complete future API/platform qualification remain open.

The application collector is separate: `npm run package:release -- --release web hub`
requires every selected production target and exits nonzero on any skip. Each
invocation owns a new `release/package-*` directory and preserves earlier SDK
artifacts. Current Link exports are intermediate and Wear APKs are debug, so
release mode rejects those profiles. Default mode remains a diagnostic report.
Every manifest records `releaseAccepted: false`; successful packaging alone
does not establish signing, installation, support or publication approval. See
[required-target QA](REQUIRED-TARGET-PACKAGING-QA-2026-10-02.md).

Verification: [foundation QA record](FOUNDATION-QA-2026-10-01.md).
