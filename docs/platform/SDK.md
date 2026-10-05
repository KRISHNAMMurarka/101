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

The pointer lab receiver can share its five-minute invitation as manual JSON,
a copied link or a QR image of that link. The link keeps the invitation in the
URL fragment; opening it on an already mounted source retires any prior
connection, removes the fragment from the address bar and prefills the review
field. Browser and native sources accept the same link or manual code, then
require an explicit application/session review. The link never enrolls a peer
or approves a resource. Enrolled-agent discovery still needs a verified agent
source before D02 can close.

The receiver captures immutable principal/application/session scope. After owner approval, private slots map to embedded source registrations and an application-owned sink. Packets never select registrations or authority. Endpoint authentication remains separate from per-resource owner approval and the embedded runtime's route grant.

T04 current-candidate evidence adds an authenticated route fixture: a valid JSON
sample reaches the selected sink; packets carrying a foreign source ID, sink
registration, session or permission fail without changing it. Wrong application,
session, epoch and peer keys fail enrollment in the same contract suite. A
[two-page Chromium WebRTC receipt](receipts/2026-10-02-t04-authenticated-chromium.json)
binds the current source hashes to bilateral enrollment, three denial trials,
typed delivery and release on disconnect or key removal. The browser harness
resolves TypeScript imports with syntax nodes so ordinary descriptor data cannot
be misread as imports. This is local browser and contract evidence; Firefox and
WebKit authentication, physical providers and account identity remain open.

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
enum, bounded record or bounded array. Version 2 spatial capabilities additionally
declare a bounded quaternion, pose, articulated joints or transform with an exact
metric reference frame. Records declare closed member schemas and
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
Spatial schema nesting also requires capability version 2. Frame ID, origin,
unit, signed axes and handedness all participate in exact compatibility.
`createSpatialPoseConverter` explicitly maps metric units and axes for a common
origin; different origins require a declared transform. It validates the full
position box, quaternion norm and a position error budget before conversion.
Rotation math accounts for admitted near-unit quaternions without changing the
serialized input. Transforms declare geometry, not verified calibration or
resource permission. The [simulated spatial joint example](../../examples/device-pipelines/spatial-joints.ts)
validates watch-style joint poses, converts them before an authorized embedded
publication, and preserves conversion provenance. Physical watch qualification
is separate.

Version 2 rich input values declare normalized contact and pen transitions,
physical/logical key edges, IME text phases, wheel deltas with an explicit
pixel/line/page mode, and relative CSS-pixel motion. They require an event
capability with reliable delivery, even inside bounded records or arrays.
`json/2` carries these events in order; a latest sample cannot replace a
down/up pair or accumulate deltas. A key label never becomes text, and an IME
`end` never becomes a `commit` automatically. All values are closed, bounded
immutable snapshots; resource permission remains a separate host decision.

### Input profiles

`getInputProfile(id)` supplies reusable, validated source capability templates.
Every template declares `subscribe` for a source and `sinkOperations[id] = write`
for a separately authorized destination; the destination must advertise a
compatible value and delivery policy. These declarations never assert that a
specific OS API, device, control or permission is available. The host probes
and enrolls actual resources before exposing them.

| Profile | Signals and delivery | Control meaning |
| --- | --- | --- |
| `app:pointer/1` | Normalized absolute position: latest, 60/s, 100 ms age; contact: reliable event, 100 ms age | Application surface position and press/release; the current pointer provider uses this template. It is not OS pointer injection. |
| `app:keyboard/1` | Version 2 key transition: reliable event, 1000 ms age | Physical code, logical key, modifiers, repeat and up/down remain distinct. Text insertion is separate. |
| `app:text/1` | Version 2 composition: reliable event, 1000 ms age | Start/update/end/commit phases are explicit; ending composition does not commit text. |
| `app:gamepad/1` | Up to 16 normalized axes: latest, 60/s, 100 ms age; one of 32 declared button IDs with pressed/pressure: reliable event, 1000 ms age | A provider must probe the actual axis/button inventory and map only offered controls. These template ceilings do not imply 16 axes or 32 buttons exist. |
| `app:touch/1` | Version 2 contact transition: reliable event, 1000 ms age | Stable contact ID and down/move/up/cancel survive separately; no coalescing of edges. |
| `app:pen/1` | Version 2 pen transition: reliable event, 1000 ms age | Contact, pressure, tilt and twist retain declared bounds and phases. |
| `app:switch/1` | One of 16 declared switch channels with active state: reliable event, 1000 ms age | Generic switch input; a caller must offer equivalent keyboard controls. There is no assistive-technology detection or physical HID support claim. |

The template describes source semantics and destination operation, not a route
grant. Each signal needs its own compatible sink, owner consent and lifecycle.
Loss, unmount and revocation release held output. Wheel and relative pointer
events use the existing version 2 rich input schemas when a provider actually
offers them; click/drag/scroll gestures, detailed gamepad/pen handling and
physical assistive support remain I03/I06/I11 work.
The [embedded rich-input example](../../examples/device-pipelines/rich-input.ts)
uses six separately authorized routes and DOM-shaped simulated events. Actual
browser/native input provider availability and physical behavior are not
established by these fixtures. A continuing example caller invokes `renew()`
before its ten-second route lease expires and owns the `flush()` cadence.

## Binary and document resources

`createAssetReference()` and `parseAssetReference()` define an inert typed
resource ID, exact media type, byte length and SHA-256. The initial kinds are
opaque blob, UTF-8 text and JSON document; the latter two have a 64 KiB
limit, and blobs have an 8 MiB limit. A reference never fetches a URL or
grants read permission. `chunkResource()` snapshots bytes and yields ordered
chunks of at most 16 KiB. `readVerifiedResource()` requires an explicit
scope and host grant for every read, bounds the resource and chunk count,
checks expiry/cancellation, then validates complete length, digest and
content before returning a fresh byte copy. Abort interrupts a stalled
source; no partial bytes are returned. This is a local software resource
path separate from the 4 KiB signal packets. The
[simulated document example](../../examples/device-pipelines/resource-documents.ts)
demonstrates success, denial, changed content and cancellation; remote
transport and actual file/browser/native providers remain separate work.

## Media and render-surface descriptions

`parseMediaManifest()` validates a separate version 1 manifest for audio and
video capture/output tracks, exact codec tokens, property ranges and video
render-target geometry. Descriptions are immutable and cannot carry a static
ready or working claim. `planMediaBinding()` accepts concrete host probes that
name the selected manifest resource IDs and registrations, and returns only a compatible proposal when availability,
codec and current properties match without silent conversion or scaling. It
does not open a track, route media or report a rendered frame. The
[simulated media description example](../../examples/device-pipelines/media-description.ts)
shows a video-to-canvas proposal and unavailable microphone/codec failures.
Actual capture, transport, permission and physical output remain separate
qualifications.

## Measurement calibration and quality

`parseMeasurementReport()` accepts a scalar producer report with closed,
immutable status. A valid value includes a calibration revision and declared
absolute error bound in the capability's exact unit. Stale and unavailable
reports contain no value and may carry bounded, distinct fault codes. The
temperature pipeline's `publishReport()` keeps the producer's revision and
uncertainty in downstream provenance; loss closes its source route. These
fields preserve producer assertions and do not verify physical calibration.

## Observation clocks and processor lineage

`parseObservationTiming()` validates a closed capture/receipt record. Common
clock IDs permit exact age; different clocks require a bounded translated
capture interval with the clock map's drift ceiling. `observationAgeBounds()`
returns the conservative age interval, clipping a possible future upper
capture bound at receipt. `compareClockStamps()` rejects raw cross-clock
comparisons. The remote receiver attaches this timing to its existing raw
provenance, and the embedded temperature processor appends its versioned
configuration step. The interval does not certify the producer's capture claim
or physical end-to-end latency.

## Processor manifests and trusted registry

`parseProcessorManifest()` accepts a closed, bounded schema-1 declaration with
an exact ID, version and lowercase SHA-256 code pin; named input/output value
schemas (including units and frames); a record configuration schema; stateless
or explicit input-loss/stop/reconfigure reset behavior; pinned asset references
with individual licenses; a code license; and declared compute, memory and
privacy budgets. The manifest is
inert. It neither imports code nor grants access to a device, asset or network.

`createProcessorRegistry()` is populated by trusted host code, not remote
descriptions. Registration verifies the supplied reviewed source bytes against
the manifest pin. The host must bind the supplied factory to those same vetted
bytes; a digest of accompanying bytes cannot prove what an arbitrary function
executes. Resolution requires the exact ID, version and pin and validates the
configuration. Each call validates named input and output values against the
manifest. Direct registry callers must invoke `reset()` on input loss, stop and
reconfigure for a resettable processor; the route-backed failure controller
does this for bound graph nodes. Compute/memory declarations are not runtime
quotas, and `explicit-sharing` is not a sharing grant. P09 and S14 retain
measured-budget and isolation acceptance.

The current first caller registers the existing Celsius threshold implementation
using the reviewed `threshold.ts` source pin, exercises hysteresis and reset,
and rejects changed bytes. The packed public model/runtime/facade API is also
checked in a clean external consumer. This proves the registry contract, not
physical sensor accuracy or an installed third-party processor.

## Processor graph validation

`validateProcessorGraph()` snapshots a bounded schema-1 graph of concrete resource
descriptors and processor manifests. Each edge names an existing output and
input port. Their complete value schemas must match, including units, frames
and ranges; an undeclared converter never appears by inference. Resource
sources must declare `subscribe`, while property sinks require `write` and
command/job sinks require `invoke`. The returned requirements are not grants;
the runtime still obtains owner authority for each route.

Processor inputs have one producer, all declared ports are connected, and
each node lies on a source-to-sink path. Ordinary edges form an acyclic
execution order. Feedback is allowed only between processors with positive
delay, maximum age, pending count and iteration count under fixed ceilings;
missing or zero bounds fail validation. This is an inert plan, not a feedback
scheduler: the route-backed failure controller rejects feedback graphs until a
bounded scheduler exists. The Celsius threshold example validates its real
source, processor and relay declarations before registering routes. The packed
SDK consumer checks that plan in Node, Chromium, Firefox and WebKit.

## Declarative recipe v1

`parseRecipe(unknown)` returns a frozen, JSON-only declaration with an exact
`schemaVersion: 1`, namespaced recipe ID and semantic IDs, and a pinned
processor ID/version/SHA-256. Each logical resource selects a source or sink
semantic and schema version; processor configuration is inert JSON. Named
routes connect resource `value` ports or named processor ports. Every resource
leg has one explicit owner-required operation and human-readable purpose.
Surfaces contain text, value and action components; named styles allow only
normal/muted/caution tones and comfortable/compact density. Unknown fields,
getters, executable values, missing permissions and dangling references fail
closed within the descriptor parser's JSON bounds.

The [complete recipe examples](../../examples/device-pipelines/recipe.ts)
run a direct application pointer route and a two-leg room-control route. The
room-control host binds its pinned temperature processor, authorizes the two
declared resource legs, produces one simulated relay command and records
separate observed feedback. The declaration
does not discover devices, load code, grant access or render a UI. Static
resolution and consent-gated execution are described below; adaptive rendering
remains E05. Consumers must obtain fresh host grants before
running any selected recipe.

`resolveRecipe(recipe, { devices, processors, selections })` checks explicit
logical-resource selections against current descriptor semantics, schema
versions and declared operations. It matches processors by exact ID, version
and SHA-256, validates configuration and route port schemas, and returns an
acyclic plan with the owner operations to request. An unselected or incompatible
resource returns a structured issue and candidate device/capability choices
marked compatible or incompatible; it never silently picks one. A missing
processor pin or invalid configuration also returns an issue. The resolver
only handles inert manifests and descriptors: the host still verifies installed
code bytes through its processor registry, checks actual readiness, obtains
fresh grants and starts routes under E04. No recipe text executes code.

`createRecipeSession(recipe, { runtime, identity, getEnvironment,
requestConsent, bind })` runs that lifecycle on host-owned registrations.
`preview()` rereads current selections and returns the resolver's plan or
structured issues. `start()` rereads them again, shows the selected resources,
purposes and exact requested operations to `requestConsent()`, then binds
existing registrations only after approval. Its route-group coordinator
prepares every required leg before activation and rechecks the runtime grant
during activation. A denied decision opens no route; failed preparation stops
reserved routes. Required member loss pauses and releases the group. Calling
`start()` again obtains a fresh inventory, consent and grants; missing
selection, failed binding, revoked grant and expired lease remain recoverable.
`stop()` is terminal and fences a late asynchronous consent result. The host
must still provide the user-facing consent UI, real provider registration,
verified processor code and safe `release()` callbacks; the session never
assumes that cancellation undoes a physical effect.

## Processor failure and restart propagation

`createProcessorFailureController({ plan, runtime, bindings, now })` revalidates
an acyclic graph and binds each processor to its resolved manifest, one active
input route per port and one host-owned derived source per output port. `run()`
checks current route authority, executes the processor, measures elapsed
compute time against its manifest budget and publishes through the embedded
runtime. Missing, invalid or rejected output fails closed. A processor may
return no frame when it has no new event.

Input route closure, explicit loss, an exception or a finite compute overrun
invalidates every downstream processor. The controller first fences those
stages, then marks their derived sources unavailable, closes input routes and
resets their state. The runtime closes dependent routes and cancels queued
commands; it does not claim to undo earlier physical effects. A reset error
leaves the stage failed. Recovery creates a new controller with fresh active
routes and grants. It never replays the prior output or command.

Elapsed-time checks reject an over-budget result after the synchronous call
returns; they cannot interrupt code that never returns. Isolation and measured
processor budgets remain S14/P09. The local two-processor test covers loss,
exception, overrun, revocation and restart; the packed consumer exercises the
reviewed temperature processor with queued-command cancellation in Node and
three browsers. Feedback graph execution remains unsupported and is rejected
before binding.

## Independent processor package example

`examples/external-processor/` is a standalone local npm package containing a
pure temperature-band processor, a pinned manifest and its license. The SDK
consumer QA copies that package and a separate consumer from the same immutable
Git tree, packs and installs both it and the five SDK packages offline, then
verifies the installed code bytes against the manifest pin. The consumer uses
the public registry, graph validator, failure controller and two host-granted
routes to drive a simulated relay. The graph declares `subscribe` and `invoke`;
the host grants only the two exact source/sink operations for its owner. An
altered code artifact, incompatible output schema, invalid configuration and
an unapproved principal fail; input revocation cancels a queued command.

This is an independent local Node consumer and package-integrity example.
Third-party publisher identity, isolated execution, physical devices and
cross-target performance remain separate qualification work.

## Scalar measurement processors

`createScalarCalibrationProcessor()`, `createScalarConversionProcessor()` and
`createMovingAverageProcessor()` take validated scalar measurement reports with
capture/receipt timing. Each call names the processing clock stamp and appends a
versioned configuration step. Calibration applies declared gain, offset and an
additional absolute error bound without changing the producer calibration
revision. Conversion uses the explicit unit converter and scales the incoming
error bound, then adds its conservative conversion bound. Neither operation
certifies physical sensor accuracy.

The bounded moving average accepts same-clock captures, retains the oldest
capture in its output window and does not assume independent sensor errors. It
resets on stale/unavailable or malformed input, changed calibration revision or
upstream processor configuration, incomparable clocks, nonmonotonic capture,
excessive gaps and explicit `reset()`. A transform that exceeds its declared
range/error bound returns `unavailable` with `processor:saturation`; invalid
input throws before a valid output is emitted. These are opt-in library
processors: a host still declares graph edges, pins reviewed processor code,
authorizes resources and propagates failed outputs through its runtime.

## Generic mapping and sample-rate processors

`createDeadzoneMapper()` converts a declared scalar range to dimensionless
`[-1, 1]` with a continuous, centered deadzone. It rejects a configuration
that cannot cover the source schema and scales the producer's absolute error
bound conservatively. The returned dimensionless measurement keeps calibration
revision and capture timing, with a new processor step. The source unit remains
in the configured input schema; no route infers this mapping automatically.

`createHysteresisEdgeProcessor()` emits a boolean event only when the reading's
entire declared uncertainty interval crosses its configured on or off limit.
In-band readings retain state without emitting a duplicate edge. It resets on
stale/invalid input, reordered or incomparable capture clocks, changed
calibration, upstream reconfiguration and explicit `reset()`.

`createLatestResampler()` holds the latest valid scalar sample and emits at no
more than one output per configured period. Each output retains the actual
source capture stamp, quality and uncertainty; a maximum source age prevents
replaying an old reading. Stale/invalid or reordered input and configuration
changes clear held state. The caller must invalidate downstream outputs when
these processors return no event/sample; a bound failure controller propagates
runtime loss and failure through their dependent routes.
The packed SDK checks these independent algorithms in Node and three browser
engines without assuming a particular device or game.

## Route-group contracts

`planRouteGroup(contract, descriptors)` validates a bounded schema-1 collection
of named routes against concrete device descriptors. Each route declares whether
it is required, exact source and sink operations, a startup dependency list,
both owners' consent requirement and its purpose. The plan returns a stable
dependency order and the operations that an executor must request; these are
declarations, not grants. It rejects duplicate routes, incompatible typed
capabilities, undeclared permissions, cycles and an optional prerequisite of a
required route when optional loss is supposed to permit continued operation.

`createRouteGroupController(contract, descriptors, connect)` accepts that
contract and a host callback that binds each planned member to a concrete
`Connection`. All endpoints must be ready when `prepare()` runs. Preparation
reserves each route's current owner grant, lease and capacity without subscribing
or dispatching. `activate()` rechecks authority and readiness, then starts the
prepared routes in dependency order; `start()` runs both phases. A required
failure stops every member in reverse order. Optional failure follows the plan's
stop or degraded policy, including dependent members. `stop()` releases prepared
routes without invoking their sink release callback and stops active routes with
that callback. The callback must bind the planned endpoints to host-owned
registration handles; the controller never treats descriptor text as authority.

Every member declares how prepared grants and started routes are released after
failure. Compensation does not undo physical effects. Safe-state policy is
either provider release or a typed command value that requires fresh owner
authority; the controller does not dispatch that command or claim a verified
physical state. The embedded temperature example supplies the concrete two-leg
contract; packed consumer tests bind and activate both routes.

An optional `recovery` block selects what happens after an active route closes:
`{ required: 'stop-all' | 'pause', optional: 'continue-degraded' | 'stop-all' | 'pause' }`.
Without it, the controller uses the startup `failure` policy. A degraded group
closes optional dependents and records them in `status().omittedOptional`; a
required loss or stop-all policy closes every remaining route. Pause also closes
every route and cancels its queued commands. `resume()` returns a newly prepared
and activated controller with fresh host-created routes and owner grants; callers
must adopt that returned controller. A failed resume leaves the original group
paused. Recovered routes do not replay prior commands or claim that earlier
physical effects were undone. Cross-host recovery and measured handoff remain
R09 work.

## Workload requirements

`parseWorkloadRequirements(manifest, { devices, processors })` validates an
inert schema-1 workload declaration before any placement decision. It names a
pinned application build and minimum runtime, exact pinned processor manifests
and their runtimes, asset references, resource operations, privacy scope,
aggregate compute/memory budget and restart policy. Resource operations must
exist in reviewed device descriptors. Required processor assets must appear
with identical kind, size, media type and digest. The aggregate budget cannot
understate the application plus declared processor budgets. Local-only
processors cannot be promoted to explicit sharing by the workload.

Cold restart is explicit. A snapshot declaration binds its format version to
the exact application code pin, requires processor reset on resume and names a
cold-restart fallback for incompatibility. The parser does not load code or
assets, authenticate a device, obtain consent, enforce compute quotas, select
a host or serialize state. Placement and snapshot asset checks are separate runtime
steps under R05/R06. The packed consumer validates a workload
against the actual embedded temperature descriptors and a pinned processor
manifest; physical two-host operation remains unqualified.

## Authorized placement reservation

`createPlacementScheduler({ context, hosts, isAuthorized })` accepts a trusted,
current host inventory and a read-only check for existing resource-owner grants.
`place(workload, principal)` revalidates the workload against the reviewed
device and processor context. In inventory order it selects a host with the
declared application and processor code pins, matching asset references,
minimum runtimes, required resources and sharing destinations. It checks
compute, memory and concurrent-workload quotas before asking the owner checker
about each host-scoped resource operation. Missing or denied optional resources
are reported as omitted; required denial rejects that candidate. A successful
selection reserves the declared budget until `release(placementId)`; release is
idempotent. Invalid manifests, principal scope and host inventories reject.

The scheduler does not establish host trust, verify installed bytes, issue or
renew grants, launch an application, serialize state or react to host loss.
Those remain obligations of the trusted orchestrator and later runtime steps.
The packed consumer tests deterministic selection, owner denial and quota
release against the embedded temperature workload. Physical two-host execution
and handoff remain under R09.

## Versioned application snapshots

`createApplicationSnapshot(workload, context, state)` copies bounded JSON state
from an application whose workload declares snapshot restart. The capsule binds
the application id, version and code digest, the declared format version and
asset references. It explicitly resets processor internals on resume. The
caller must first pause application mutation; active routes, grants, commands
and processor state are not serialized.

`restoreApplicationSnapshot(workload, context, capsule, availableAssets,
validateState)` revalidates the workload and capsule, asks the application to
check its own state schema, and hashes the bytes of every required asset before
returning frozen state. Incompatible identity, format or state returns a cold
restart alternative. Absent or changed asset bytes return an install-assets-
then-cold-restart alternative. A cold-only workload cannot resume a capsule.
The state validator must be side-effect free; the application applies state
only after a successful result. The reference counter application tests exact
state continuity, rejection and nonmutation. The packed consumer checks this
contract in Node and three browser engines. Transport authentication and host
code-byte verification remain separate.

## Workload handoff

`createWorkloadHandoff({ workload, context, source, validateState })` coordinates
a snapshot-capable application between trusted `HandoffHost` adapters. The
caller supplies an already admitted source and target; each adapter owns its
routes and checks `HandoffEpoch.isCurrent()` before every simulation turn and
command dispatch, including queued work. `authority()` provides the initial
source epoch. Host callbacks must be scoped to the supplied epoch so a late
stop or abort cannot retire a newer run.

`transfer(target)` revokes the source epoch before pausing it, captures the
versioned application snapshot, verifies the target's asset bytes and state,
and stages the target without effects. It waits for source retirement before
granting the target a new epoch and resuming. A failed or cancelled transfer
revokes the target, waits for any in-progress source stop or target resume to
acknowledge, and restores the source from the verified snapshot under another
new epoch. Cancellation during target staging can recover immediately; any
late stage completion receives an epoch-scoped abort. If abort or source
restoration fails, status is `paused` and neither host has authority. A host
callback that never acknowledges can leave transfer pending with both epochs
fenced; the orchestrator must handle that host failure.

The local reference exercises two separate embedded hosts, queued-command
cancellation, repeated transfer and interruption recovery in unit tests, and
the temperature workload through the packed SDK consumer in Node and three
browsers. This API does not authenticate hosts, transfer credentials, verify
installed application code bytes or reserve target capacity. The orchestrator
must use authorized placement and host-owned grants; live cross-host
qualification remains R09.

## Local device simulator

`createDeviceSimulator({ sources, sinks, routes })` runs reviewed descriptors
through the same typed, authorized embedded runtime used by applications.
`replay(steps)` accepts at most 256 closed JSON steps with nondecreasing integer
times. Steps can grant a simulated route, connect it, publish a typed sample,
flush delivery, revoke, disconnect/reconnect an endpoint or mark source input
stale. The entire script is validated before any step runs. Unknown resources
and invalid samples fail without reaching a sink. `events()` returns at most
256 simulated deliveries/releases; `close()` releases runtime ownership.

Grants in this tool are test controls, not real owner consent. Disconnect and
input loss clear those controls and require a new grant and route generation.
The packed consumer replays the embedded temperature descriptor in Node and
Chromium, Firefox and WebKit. No physical device or transport is simulated as
a qualified hardware result.

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
| Structured schema node depth / total nodes / JSON container depth | 4 / 256 / 10 |
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
Unresolved operations pin bounded history. Settled records normally remain until
1000 ms after completion and their original deadline, but the oldest unpinned
record can be retired earlier when a new operation needs queue capacity.
Monotonic operation IDs still reject replay. Historical evidence may change without
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

## Property, command and job operations

A latest `property` source may expose `read` and/or `subscribe`. A `read` route
requires a fresh retained property value when it starts, captures that value
after host authorization, delivers it once and closes. A `subscribe` route
continues to receive new publications. Missing or stale snapshots fail rather
than waiting for an update; a snapshot that expires before delivery is dropped.
Events and samples use subscriptions. The host authorizes the exact selected
operation and the sink's `write` or `invoke` permission.

Reliable `command` and `job` sinks require operation IDs and deadlines. Jobs
use `invoke`, return through an asynchronous provider callback and can be
cancelled by route loss. `OperationRecord.handlerResult` records whether the
handler has not started, is running, returned or failed. `effectEvidence`
separately records dispatch, target acknowledgment or observed effect; `none`
means no such evidence. A deadline or cancellation changes the operation
state without claiming the handler has stopped. If it later returns, its
handler result can update while the expired/cancelled state remains. The
runtime never automatically retries a command or job; a host with a
non-idempotent operation must use a new explicit operation after resolving
an ambiguous effect. The threshold example's set-state relay command is
idempotent by its own provider contract. Handler return does not prove a
physical effect or a job-specific output payload.

M10 local evidence: property reads and handler/effect records failed focused
tests before implementation. Independent review found missing current-value
reads and premature handler-result claims; both were reproduced and fixed.
The [immutable SDK build](receipts/2026-10-02-operation-semantics-sdk-build.json)
and [clean consumer receipt](receipts/2026-10-02-operation-semantics-sdk-consumer.json)
verify strict NodeNext/Bundler types plus ordinary Node, Chromium, Firefox and
WebKit. The unpublished artifact is `release/sdk-nxJ5Zu` from producer tree
`f7086017e51ac0dcc7c0cffb11e8f3f50156defb`; manifest SHA-256 is
`6ad6fc1b4e237d9d0c06bdc577f08522af914db1f00353c39fe0da81e6d6bc6d`.
Builder SHA-256 is `7e91360653dfbc1cd0c872eb7759d2a6a46cc2e1e5095cb0aff4079d4e0fd966`;
QA tool SHA-256 is `02d130ec80221a5eb7cca53428c3c5279eb142f325863428fb93f0237583c52c`.
The containing commit binds exact repository gates. Physical job completion,
provider-supplied output data and remote support are not qualified here.

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

## Device health and supported resources

`parseDeviceHealthReport()` accepts a closed, bounded, immutable schema 1
provider snapshot for one device. It records an observation clock and age
limit; optional battery and firmware details; thermal and connectivity states;
distinct warning or blocking fault codes; and per-capability state, maximum
rate and maximum active routes. `assessDeviceHealth()` requires a caller clock
stamp and exact device/capability identity. It rejects cross-clock or future
time, treats expired reports as stale and withholds availability for unknown or
blocking conditions. It returns resource limits only for an available result.
Battery level or firmware text alone never supplies a readiness decision.

The [embedded sensor example](../../examples/device-pipelines/sensor-feedback.ts)
applies the assessed readiness to its existing source with an expiry deadline.
The runtime rechecks that deadline on route start, publication, flush and
renewal; it has no idle background timer. Loss closes routes and cancels
pending output. Recovery requires a new authorized route start. These
reports are provider claims: this SDK cannot authenticate a physical battery,
fault or firmware state, and it does not enforce the reported resource limits
as runtime quotas. [M09 evidence](DEVICE-HEALTH-QA-2026-10-02.md) covers the
parser, embedded caller and installed package consumers.

## Discovery candidates and evidence

`parseDiscoveryCandidate()` snapshots one bounded, inert candidate with an exact
local, application, session or directory scope; an expiry; and a recovery action
and hint. Its ordered evidence claims distinguish observation, identity, peer
authentication, resource authorization and a live readiness probe. Each claim
names the candidate and scope, a stage-specific kind, an opaque host receipt ID
and its own expiry. Missing or skipped stages, copied scopes and expired claims
cannot promote the candidate.

`assessDiscoveryCandidate(candidate, expectedScope, now, verifyReceipt)` asks the
trusted host to verify each receipt in order. The verifier must bind the receipt
to this candidate, scope and stage; returning `true` for arbitrary IDs is unsafe.
Assessment stops at the first missing, stale or unverified stage and reports
`unverified`, `out-of-scope` or `expired` when appropriate. The recovery path is
always returned. Parsing or observing a candidate never enrolls an endpoint,
grants a resource operation or probes the device. Discovery providers, chooser
flows and live capability inventory remain separate D02–D09 work.

## Descriptor revisions and extensions

`planDescriptorEvolution(previous, candidate)` validates both descriptors and
accepts only a higher revision of the same device, adapter and platform whose
existing capability contracts remain identical. New capabilities, labels,
adapter versions and inert metadata/extensions can be added without silently
changing existing routes. Removed capabilities or changes to permissions,
ownership, schema, delivery, kind or semantic return an incompatible plan.
Unknown fields/types and unsupported descriptor schema versions reject before
planning. This is a compatibility decision, not payload migration, grant
transfer or permission approval. Every new resource still needs host authority.

M11 local evidence: the focused evolution test was RED before the helper existed;
unknown fields/types, revision ordering, additive capabilities, changed
contracts and extension authority denial now pass. Independent read-only review
found no concrete defect. The [immutable SDK build](receipts/2026-10-02-descriptor-evolution-sdk-build.json)
and [clean consumer receipt](receipts/2026-10-02-descriptor-evolution-sdk-consumer.json)
cover strict NodeNext/Bundler types and ordinary Node, Chromium, Firefox and
WebKit. The unpublished artifact is `release/sdk-IpSb9H` from source tree
`302727f01e4076a90945aae82becb2f53e0dffbc`; manifest SHA-256 is
`da3f3473942d4bb9e68246ed867a49a7f1f097c868f768ea6d3ef658e7d6245f`.
Builder SHA-256 is `7e91360653dfbc1cd0c872eb7759d2a6a46cc2e1e5095cb0aff4079d4e0fd966`;
QA tool SHA-256 is `99c97da5bbc40bec1b01eeda2381c4769cd29bd65b71ab7227159e456f47ae9d`.
The containing commit binds the exact repository gates. This does not qualify
remote upgrade rollout, physical providers or support.

## Bounded WoT Thing Description mapping

`exportWoTThingDescription(descriptor, bindings)` projects boolean, scalar and
enum property, event, command and job capabilities into WoT TD 1.1 property,
event and action affordances. The caller must provide one canonical HTTPS form
URL per capability and declare bearer security; the SDK does not invent an
endpoint or verify that the service implements those forms. Property read and
observation and event subscription use the corresponding WoT operations.
Subscriptions require an explicit `longpoll` binding from the caller and emit
`GET` plus `subprotocol: longpoll`; action invocation emits `POST`.
Commands and jobs map to action input. A job's native lifecycle is retained in
the `c101:descriptor` extension; the TD makes no WoT status-query or
synchronicity claim. Sample streams, rich/spatial/structured value schemas,
unbound forms and other security schemes are outside this profile and reject.

The TD includes the standard 1.1 context and declares the `c101` namespace as
`urn:101:td:profile:1#`. The extension retains native delivery, ownership,
permissions, semantic IDs, revisions and inert vendor data, which WoT's core
affordances cannot represent exactly. `importWoTThingDescription(td)` accepts
only this closed profile. It validates the native descriptor, HTTPS forms,
security declaration and every projected standard field, then returns an
immutable inert descriptor. Importing a TD never connects to a URL or grants a
runtime route; host authorization remains required. Arbitrary third-party TDs
without the declared extension are unsupported. Neither function establishes
that a bound endpoint is a conforming WoT implementation.

M12 evidence: focused positive, tamper, malformed and unsupported-profile
fixtures pass. The positive fixture is checked by the normal unit gate against
the locally pinned [W3C TD 1.1 JSON Schema](https://www.w3.org/2022/wot/td-schema/v1.1)
at `packages/device-model/fixtures/wot-td-schema-v1.1.json` (SHA-256
`fd44f319f94c6f16f66978860ef2f9f4e0e9fd7fc5835a2f3840b9cf2002e0f1`).
The [immutable SDK build](receipts/2026-10-02-wot-profile-sdk-build.json)
and [clean consumer receipt](receipts/2026-10-02-wot-profile-sdk-consumer.json)
verify strict NodeNext/Bundler types and packed Node, Chromium, Firefox and
WebKit imports. The unpublished artifact is `release/sdk-v5MnXF` from source
tree `8990666dae9bbe9501291448bcaa3c9378155d79`; manifest SHA-256 is
`c29deff6fc45d0e12c5567af110c68fa767977ca1a50fa98891a81aea8d6419e`.
Builder SHA-256 is `7e91360653dfbc1cd0c872eb7759d2a6a46cc2e1e5095cb0aff4079d4e0fd966`;
consumer QA tool SHA-256 is `466a52bb295cf1da6bd6c95f7f7f542f1d3938ccf75d4300648c3b7218f8294b`.

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
