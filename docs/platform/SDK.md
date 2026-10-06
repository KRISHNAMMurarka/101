# Device SDK

The first platform implementation connects typed providers inside one application process.
`@101/connect` exports the device model, embedded routing API and bounded peer resource bridge without game dependencies.
The runnable [examples](../../examples/device-pipelines/README.md) use explicit local providers and fixtures; browser examples declare the required native APIs and owner grants.
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

### Independent browser touch contacts

`TouchContactSourceDriver`, `touchContactSourceDescriptor()` and
`mountTouchContactSource(target, driver)` are public through `@101/device-web`
and `@101/connect`. The source derives its reliable contact capability from
`app:touch/1`. Mount an idle driver on one host-selected surface with
`touch-action: none`; mouse and pen events do not become touch contacts. Each
accepted down receives a new local ID, normalized measured coordinates and a
primary flag preserved for its lifetime. Up, cancel and lost capture release
only that contact. At most 32 simultaneous contacts are held.

The host supplies a monotonic clock and an admission callback. Invalid values,
clock regression and rejected publications stop the driver and cancel owned
contacts. `release()` cancels held contacts and allows fresh downs; `stop()` is
terminal. ResizeObserver geometry changes, orientation, blur, hidden documents
and pagehide cancel contacts. Moves cannot revive canceled IDs. Disposal removes
listeners and immediately releases native pointer capture, including during a
publication callback. Hosts must dispose on route loss and clear sink ownership
when a route closes, since closed routes cannot deliver cancel events.

The [independent touch example](../../examples/device-pipelines/touch-contacts.ts)
uses a registration-scoped grant, a reliable route, a ten-second lease, bounded
event history and independent contact ownership. Its mounted surface disposes
on disconnect. Continuing hosts own a loop calling `tick()`; default grants
expire after 60 seconds. Packed browser QA exercises trusted single-contact
input in three engines and protocol-generated simultaneous contacts in Chromium,
including native capture, separate release, cancellation and geometry changes.
This evidence does not qualify physical fingers or native device ergonomics.

### Selected-surface browser gestures

`GestureSourceDriver`, `gestureSourceDescriptor()` and
`mountGestureSource(target, driver)` are public through `@101/device-web` and
`@101/connect`. The `app:gesture/1` profile has separate reliable gesture and
wheel events plus a latest normalized position sample. A short released contact
emits one tap. A held contact emits press start/end; movement beyond a measured
pixel threshold emits drag start/end. Two or more contacts emit one scroll
transition and bounded wheel deltas from centroid movement. Native wheel units
(pixel, line or page) and modifiers remain explicit; unlike units never merge.

The host chooses the surface, applies its touch-action/focus policy, supplies a
monotonic clock and calls `tick()` from an owned loop while mounted so a held
press reaches its deadline. Moves use a bounded sample rate; transition and
wheel events retain reliable delivery. Capture loss, geometry/orientation
change, blur, pagehide and unmount cancel held gestures and release pointer
capture. `release()` permits a fresh gesture; `stop()` is terminal. A rejected
publication stops the driver; consumers clear active gestures on route loss.
The [gesture example](../../examples/device-pipelines/gestures.ts) authorizes
three independent routes and demonstrates tap, press, scroll, wheel and
disconnect. The input profile describes semantics, not global OS clicks or
physical touch qualification.

### Browser keyboard and text source

`KeyboardTextSourceDriver`, `keyboardTextSourceDescriptor()` and
`mountKeyboardTextSource(target, driver)` are public through `@101/device-web`
and `@101/connect`. The descriptor derives two separate reliable source
capabilities from `app:keyboard/1` and `app:text/1`; each needs an independently
authorized compatible sink. Mount only a surface selected by the host. It
retains native focus and editing behavior and never cancels browser defaults.
The module acquires no input or timers on import.

Key events preserve `code`, layout-dependent `key`, location, modifiers,
repeat, up/down and `isComposing`. A missing DOM code/label is explicitly
`Unidentified`; this does not identify a physical key. No key label is turned
into text. Composition start/update/end retain one bounded local identity.
Only an insertion `input` event carrying data can commit text: `insertText`,
`insertFromComposition`, paste, drop or replacement. Intermediate composing
input, deletion, null data and `beforeinput` do not commit. An `end` never
commits. Final composition input can arrive before or after `end`; repeated
`insertFromComposition` for that same session is suppressed. A new ordinary
key/start retires the previous ended session. IDs are local to one driver
lifetime, and ordinary insertion events receive separate identities. This is
an insertion/composition stream, not an editor operation or document replica;
selection, deletion, undo, clipboard acquisition and newline editing need a
separate editing contract.

At most 64 keys are held and text is bounded by the profile to 2048 Unicode
code points. Runtime/wire envelope byte limits still apply independently; the
source never truncates or replays rejected text. Invalid data, clock regression,
publisher rejection or exception stop the driver. `release()` clears held keys
and cancels pending composition with an empty `end`; it never manufactures a
commit. External release samples the current host clock, and cleanup during a
callback uses the last validated capture time. Reentrant cleanup is coalesced.
DOM blur, focus leaving the selected surface, pagehide and hidden document
release input. The mount disposer removes listeners and stops input. Hosts
must call it on unmount and stop the driver on route/transport loss. Because a
closed route cannot deliver cleanup, the sink's own release handler must clear
held keys and preview while preserving committed text.

The [independent keyboard/text example](../../examples/device-pipelines/keyboard-text.ts)
uses the real runtime with concrete registration-scoped grants, two reliable
routes, ten-second leases and sink release. It retains the latest 128 diagnostic
events independently of committed text (8192 code points maximum). Publication
rejection, stopped source or consumer text overflow closes both routes; existing
committed text remains available. A
continuing caller owns a loop calling `tick()` to renew and dispatch; each
flush delivers at most one event per route and respects its rate budget.
The example's default grants expire after 60 seconds. Stopping preserves the
consumer's committed text. Its deterministic producer fixtures demonstrate
layout labels, repeats, composition and disconnect; packed browser QA additionally
uses trusted keyboard input and focus/unmount plus synthetic composition
protocol events. These checks do not qualify physical keyboard layouts,
platform input methods or native/global keyboard capture.

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
| `app:gamepad/1` | Up to 16 normalized axes and calibrated trigger values: latest, 60/s, 100 ms age; one of 32 declared button IDs with pressed/pressure and up to 16 hat directions: reliable events, 1000 ms age | A provider probes actual axes/buttons and declares trigger and hat mappings. Button and hat edges remain distinct from analog samples. Template ceilings imply no physical inventory. |
| `app:touch/1` | Version 2 contact transition: reliable event, 1000 ms age | Stable contact ID and down/move/up/cancel survive separately; no coalescing of edges. |
| `app:gesture/1` | Gesture transition and version 2 wheel: reliable events, 1000 ms age; normalized position: latest, 60/s, 100 ms age | Selected-surface tap, press, drag and multi-contact scroll; wheel units and modifiers stay explicit. |
| `app:pen/1` | Version 2 pen transition: reliable event, 1000 ms age | Contact, pressure, tilt and twist retain declared bounds and phases. |
| `app:rotary/1` | Signed detent delta: reliable event, 1000 ms age | Crown/encoder counts use an explicit counts-per-detent calibration; fractional and reverse turns remain distinct events. |
| `app:switch/1` | One of 16 declared switch channels with active state: reliable event, 1000 ms age | Generic switch input; a caller must offer equivalent keyboard controls. There is no assistive-technology detection or physical HID support claim. |

The template describes source semantics and destination operation, not a route
grant. Each signal needs its own compatible sink, owner consent and lifecycle.
Loss, unmount and revocation release held output. Wheel and relative pointer
events use the existing version 2 rich input schemas when a provider actually
offers them. The [input detail example](../../examples/device-pipelines/input-details.ts)
uses synthetic producer values with `createPenDetailProcessor`,
`createRotaryDeltaProcessor` and `createGamepadDetailProcessor`. Pen pressure
range and tilt/twist offsets, rotary counts per detent, and probed gamepad
axis ranges/deadzones and optional raw trigger ranges are explicit calibration inputs. Invalid ranges fail
instead of saturating silently. Gamepad processing preserves analog trigger
values, emits only changed button/hat edges, and `release()` emits held-state
releases on disconnect. Hosts must still probe real hardware, authorize each
route and stop/release on loss; this example does not qualify physical pen,
crown, encoder or gamepad behavior. Physical assistive support remains I11 work.
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


## Local application video

`createBrowserApplicationMedia({ applicationId, sessionId, clockDomain, now,
authorizeSource, authorizeSink })` implements the selected
`local-application-video/1` browser path. It captures a caller-owned canvas with
native `captureStream`, decodes its video privately and draws into an SDK-owned
canvas inside the selected output container. Existing container children and
the borrowed source remain intact. Camera, microphone, screen capture and
remote media transports require their separate providers and grants.

Register the source with `registerSource({ sourceId, ownerPrincipalId, canvas,
maxHz })`, then explicitly `bind({ source, outputId, ownerPrincipalId, container,
label, signal? })`. The issued source handle is identity-bound; copied handles
cannot bind. Each owner authorizer receives a frozen request containing the
exact source, recipient, output, application, session and operation. Approval
returns `{ request, grant }` with that same request object. Metadata alone
cannot approve another output. Both decisions must be current before capture,
pixel reads and visible output. The runtime independently binds the concrete
resource registrations to the resulting limits.

`ready` reports successful local opening; `status()` reports route state.
`renew()` can refresh a lease only within the captured opening deadline and
current owner limits. Revocation, cancellation, expiry, native track loss,
hidden document and `close()` retire owned capture and output work; restoring
availability does not automatically reopen a route. `revokeOutput` retires one
recipient; the final recipient stops the owned capture. `revokeSource` retires
all its outputs. No frame data, video, stream or native track is exposed through
a public handle or serialized into the control wire.

Fresh owner decisions can tighten rate and maximum age. The frame notification
timestamp records local decoded-frame receipt in the declared clock domain.
Its age is checked against the current narrowed grant before visible output;
it does not establish camera capture time or cross-device synchronization.

The selected profile caps two sources, four outputs, thirty requested frames
per second and 1,048,576 pixels per source/output backing surface. Opening has
a two-second deadline. Native settings and decoded dimensions must establish
the selected format; a missing setting is unsupported rather than an invented
capability. Browser-native media buffers do not carry a hard memory claim.
Trusted same-origin host code owns consent and the application canvas; these
APIs are cooperative recipient isolation, not a sandbox against that host.

## Preset haptic output

`getHapticOutputProfile` exposes `app:expo-haptic-presets/1` and
`app:browser-haptic-presets/1`. Both accept only `tap`, `impact` and `warning`.
Expo selects actual intensity and duration; custom values are unsupported.
Browser patterns request 15 ms, 35 ms and `[50, 35, 50]` respectively, with a
maximum requested pattern span of 135 ms including the pause. Actual hardware
output and physical distinguishability remain unverified.

`createHapticOutputController({ runtime, deviceId, backend, now, label? })`
registers an initially unavailable, exclusive reliable command sink. The caller
supplies the existing runtime and authorizes its exact source, sink, principal,
application, session and `invoke` operation. The helper creates no grants.
After explicit `setAvailable(true)`, commands still require increasing
operation IDs, current delivery contexts and bounded deadlines. Dispatch is
capped at ten requests per second, one API invocation in flight and a 100 ms
freshness window; evidence retains at most 64 records.
Runtime queue capacity is supplied by the caller; create each command route
with `queueCapacity: 1` for this profile.

`createBrowserHapticBackend(navigator)` uses the actual vibration API result.
A missing API, false return or thrown call has no fabricated acknowledgement.
Records distinguish the dispatch attempt from `api-returned`, `api-rejected`,
`unavailable`, busy, cancellation and expiry, and always leave physical effect
unverified. `setAvailable(false)` and `close()` fence future work and late
completion. Expo offers no cancellation of an already issued effect; browser
stop is only an API request. The native controller helper adapts the installed
Expo preset methods. The helper requires explicit active state and shares its
actual API reservation between SDK and legacy/local feedback; background and
close decline new calls. Replacement helpers using the same installed Expo
port remain busy until the original native Promise settles. Its legacy/local
App callbacks retain an explicit
compatibility boundary and do not establish migrated SDK route grants.

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
resolution and consent-gated execution are described below; reusable control descriptions are documented below. Consumers must obtain fresh host grants before
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

## Scaffold a local SDK project

`npm run create:device -- room-sensor /path/to/new-project` creates a new
standalone project. Its typed connector resolves the emitted Celsius source,
local display descriptors and complete `src/recipe.json`, authorizes only the selected registrations and owner operations,
and releases the display on stop. Its processor has a manifest pinned to the
generated source bytes. The caller registers that reviewed local processor,
routes a simulated reading, runs it and closes the route. The generated test
checks the pin, result, release and exact host authorization boundary.

`device-guidance.json` gives tools versioned package/runtime information, file
roles, public validator contracts, commands and trust boundaries. Its closed
Draft-07 schema is `device-guidance.schema.json`; the descriptor editor schema
comes from `@101/connect/schema/device-descriptor.json`. Guidance strings are
explanatory data. The connector, caller and validator never interpret them as
code, shell commands or permission grants.

`npm run validate` reads fixed asset paths, calls `parseDeviceDescriptor`,
`parseRecipe`, `parseProcessorManifest` and `resolveRecipe`, and checks the
processor source hash. `npm test` validates, compiles, then checks the complete
local route and processor lifecycle. It also verifies that changed processor
pins reject and hostile guidance text has no effect in fresh caller/validator
processes. Recipe permissions remain requests; the host authorizes concrete
registrations, principal, application, session and operations.

Supply the seven matching local SDK tarballs from `npm run build:sdk -- <revision>`
to the generated project's npm install. The project lists TypeScript 5.9.3
as a development tool; run `npm test` after installing it. The
[packed consumer check](receipts/2026-10-05-e06-device-scaffold.json) generates
the project outside this repository, installs the packed SDK offline, compiles
under strict NodeNext resolution and executes its tests and caller without
workspace links. This is a local simulated connector and processor scaffold;
it does not grant OS permissions or qualify physical hardware.

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

## Independent landmark processors

`@101/vision` is included in the local SDK tarball set and re-exported by
`@101/connect`. It contains the existing pure pose, hand, skeleton and gesture
algorithms plus validated observation processors. It imports neither games nor
MediaPipe; importing it requests no camera permission, opens no sensor, fetches
no model and starts no timer. Camera acquisition and inference remain in the
camera adapter and `use-camera-input.ts`.

`projectPoseLandmarkerResult` and `projectHandLandmarkerResult` project the consumed
MediaPipe result fields and are shared by the actual camera backend and independent
caller. Pass pose `landmarks/worldLandmarks` or hand
`landmarks/worldLandmarks/handedness`, rather than masks or the deprecated duplicate
handedness array. They accept at most four poses or two hands, each with exactly
33 or 21 image points and either a matching complete metric array or none.
Malformed, partial, oversized, nonfinite or unknown fields are rejected without
invoking getters. Missing pose visibility and missing hand category scores remain
zero. The hand adapter's `confidence` and copied point `visibility` carry the
handedness category score; they do not establish detection accuracy or individual
point visibility. No absent metric coordinates are invented.

`parsePoseObservation` and `parseHandObservation` accept one explicitly selected
subject. Both require `subjectId`, `frameId`, nonempty blob model `AssetReference`,
`quality` (`valid/stale/unavailable`) and observation `timing`. Pose `landmarks`
contain 33 points or an empty loss frame; hand `hand` is one tracked hand or null
and `frameAspect` is 0.01–100. Image x/y and relative z predictions retain values
outside the image within ±8; model-local metric coordinates retain metres within
±100. Pose metric origin is the hip midpoint; hand metric origin is the wrist.
Frame names do not establish camera calibration or an absolute shared world frame.
Model references record provenance; the caller must independently verify actual
asset bytes and acquire permission for inference. Inputs and outputs are deep
immutable snapshots bounded by the model's 64 KiB JSON limit.

```ts
import { createPoseLandmarkProcessor, createHandLandmarkProcessor } from '@101/connect';
const bounds = { version: '1', configurationRevision: 1,
  maxGapMs: 100, maxWindowMs: 2000, maxFrames: 64 };
const pose = createPoseLandmarkProcessor({ ...bounds, id: 'app:pose',
  classifier: { autoCalibrationFrames: 2, smoothing: 0.5 } });
const hand = createHandLandmarkProcessor({ ...bounds, id: 'app:hand',
  classifier: { stableFrames: 2, smoothing: 1, historyMs: 500 } });
// process(observation, processedClockStamp), then reset() on loss, revoke or stop.
```

The processors reuse `PoseClassifier` and `HandGestureClassifier`. Legacy game
adapters retain their existing classifier and mapping configuration. These
independent processors require an unmapped common capture/receipt clock and
increasing capture times; append their version/configuration to processing lineage;
and retain the oldest contributing capture for classification/filter history.
`signals.timestamp` is the current input capture, while output `timing` is the
conservative freshness envelope for derived signals. Retention is explicitly
bounded by `maxGapMs/maxWindowMs` (1–60000 ms each) and `maxFrames` (1–128).
Subject, image frame, model reference, clock, aspect or upstream configuration
changes reset state. Pose calibration frames and hand stabilization frames are
integers in 1–120 and cannot exceed `maxFrames`; hand history is 420 ms through
`maxWindowMs` (default 1250 ms). Smoothing is in (0, 1].

Missing input, declared stale/unavailable quality, insufficient mean pose core
visibility (the existing classifier policy) or zero hand category certainty return `unavailable`, release every
classified action and reset. Pose calibration pending returns `calibrating`.
`pose.calibrateNeutral(observation)` explicitly resets/sets neutral and consumes
that frame; the next processed frame must be newer. Malformed input, unsupported
clock comparison or invalid processing timing throws and resets before recovery.
Absence without a frame is not detectable: the owner must call `reset()` on loss,
revocation and stop. Heuristic gestures do not supply accuracy certification.

`runVisionExample` from `@101/connect/examples/vision` is a complete independent
caller using synthetic geometry in the installed producer shapes. Its model
references identify the committed pose-lite and hand `.task` assets by byte length
and SHA-256; tests compare those exact local assets. The landmark-only SDK package
contains no model/WASM binaries and performs no inference or download. Provision
those assets and their distribution terms separately when implementing inference.
Fixtures demonstrate neutral calibration, metric preservation, gesture stabilization,
loss and recovery. Physical accuracy, multi-person identity, camera lifecycle,
asset redistribution and performance qualification remain P09/G/K09 work.

## Physical motion processors

`parseMotionMeasurement`, `createMotionUnitProcessor`, `createMotionCalibrationProcessor`
and `createMotionSmoothingProcessor` are independent, synchronous APIs from
`@101/device-model` and `@101/connect`. The existing `@101/motion` game pipeline
uses the same extracted quaternion math; its sensitivity, deadzone, gestures and
control mapping remain a separate layer.

A `MotionMeasurement` carries an `xyzw` quaternion, acceleration and angular-rate
three-vectors, explicit units (`m/s2` or standard `g`, `rad/s` or `deg/s`),
`deviceFrame`, `referenceFrame`, `accelerationKind` (`linear` or `including-gravity`),
producer `calibrationRevision` (0 means unverified), and validated observation timing.
Orientation maps device axes into the named reference; the two vectors remain in
device axes. Equal labels/units do not establish identical physical frames or grant
resource access. Inputs are copied/frozen; missing components, nonfinite values,
unknown fields/units, vectors outside ±1e6 and quaternion norms more than 0.001
from unity are rejected. Float32 quaternion rounding is normalized within that bound.

The unit processor uses explicit factors 9.80665 for standard `g` and π/180 for
degrees. It preserves gravity inclusion, axes, calibration generation, capture clock
and remote mapping, and appends its configuration to timing lineage. It neither
estimates gravity nor applies game sensitivity. The calibration processor requires
matching device/source reference frames, applies inverse-neutral attitude, names a
new reference frame, and preserves the physical vectors and producer generation.

Smoothing requires canonical SI units and an unmapped common capture/receipt clock.
It keeps one prior state, uses an explicitly chosen `alpha` in (0, 1], and blends
quaternions in the shortest hemisphere. `maxGapMs` and `maxWindowMs` each bound
retention to 1–60000 ms. Output retains the oldest contributing capture rather than
relabeling filtered history as fresh. Clock/frame/gravity/calibration/upstream
configuration changes restart the state. Duplicate/reversed timestamps, invalid
values and processing-time errors throw and reset before recovery. Call `reset()`
on source loss, revocation or stop; absence cannot be inferred without an input.
The filter supplies no sensor accuracy or uncertainty certification.

```ts
import { runMotionExample } from '@101/connect/examples/motion';
const { measurements, calibrated, smoothed, restarted } = runMotionExample();
```

This complete caller uses labeled synthetic fixtures shaped like browser events,
installed Expo iOS/Android measurements, and decoded watchOS/Wear OS payloads.
It explicitly projects their different rotation-rate field orders, converts native
seconds to milliseconds, and takes the oldest component capture when summarizing
an assembled fixture. It preserves separate device/reference/clock identities;
it does not establish simultaneous sampling or platform frame equivalence. Keep
component observations separate when their individual times are needed. These
fixture/packed-consumer checks qualify processor behavior, not physical sensors,
watch connectivity, sensor fusion, gesture accuracy or performance (P09).

The native controller uses a separate Expo projection matching the installed
57.0.2 native sources: iOS rotation-rate fields are `gamma/beta/alpha` for x/y/z;
Android fields are `alpha/beta/gamma`. Both preserve degrees per second before
the game pipeline. Browser rotation rates use `beta/gamma/alpha`.

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
| Delivery-slot contention | Eligible routes rotate after successful reservations; at most one reservation per route per flush |
| Ownership lease | Default 1500 ms; configurable 1–30000 ms |

Successful delivery reservations rotate behind waiting routes on the next
`flush()`. Each flush freezes its work before calling a provider; derived work
waits for another flush. Under contention, continuously eligible routes whose
providers finish receive bounded turns independently of registration order.
Cadence, freshness, reliable ordering, host grants and the global pending limit
still apply. This is route fairness, not a CPU sandbox or per-tenant byte quota.
Providers retaining every global slot indefinitely can still block admission.
The host must isolate untrusted computation and handle unavailable providers.

## Reusable control surfaces

`parseControlSurface` validates immutable `ControlSurface/1` descriptions separately from Recipe/1. Boxes contain one layer of text, labeled readouts, activation buttons, toggles, sliders and native choices. Descriptions contain no executable code, resource permissions, HTML, links or arbitrary CSS. Limits are 32 KiB, 64 total nodes, 32 top-level nodes/children per box, eight semantic styles and sixteen choices. Slider bounds and initial values must fit a finite step grid with at most 10,000 intervals.

`mountControlSurface({ container, description, onControl, callbackTimeoutMs? })` renders native HTML with labels, readable fixed statuses, visible keyboard focus and 44-pixel targets. All controls initially remain unavailable. The host explicitly calls `setEnabled` after obtaining a current grant, and disables controls on revocation. `onControl(event, { signal })` receives validated ID/kind/value/sequence input. A successful callback means input handling finished; it does not establish resource permission or physical effects. The independent `control-surface` packed example separately authorizes four typed runtime routes into a local application.

State choices retain at most one latest queued input per control. Pending activation buttons reject duplicates while retaining focus. Callback rejection or timeout restores the accepted state and exposes a retry. Timeout defaults to two seconds, configurable from 100 to 10,000 ms; revocation, replacement and close abort pending signals and fence late completion. `setValue` updates declared state without emission; `setText` only updates bounded readouts as literal text. `close()` removes owned listeners, observer, DOM and timers.

ResizeObserver measures the container and selects one to four columns without reordering controls or losing focus. Monochrome normal/muted/caution tokens, comfortable/compact spacing and optional 120-ms feedback styles support dark mode, forced colors and reduced motion. Keyboard and pointer use the same native controls. This library supplies reusable primitives; phone ergonomic acceptance, screen-reader journeys and all-platform reference application flows remain their separate U/G qualification rows.

## Application input ownership

`createInputOwnershipController({ runtime, applicationId, sessionId, sources, destination, now })` implements `application-input-ownership/1` over registered runtime resources. The host pins parsed descriptors, handles, source principals and destination scope. Compatible destination resources must declare the same exclusive policy or named partitions; labels supply no identity or permission. `request` returns a bounded review request and current owner epoch. Pending, declined, cancelled and expired requests leave the current route group active.

`decide(requestId, expectedOwnerEpoch, true)` is explicit consent to the exact source and partition. `isApproved` only checks that consent; the runtime's independent host callback must still issue current grants for every route leg. Transfer releases the previous group before starting the replacement. Denied or failed activation leaves the slot released with a visible request-again action. `release`, resource loss, grant expiry and `close` release the group and fence late delivery. Stale request IDs or owner epochs cannot transfer control.

Limits are four pinned sources, two declared destination slots, two resources per group, one pending request per slot, thirty-second requests and eight observers. A controller admits at most sixty-four lifetime activation attempts, including failures, to bound retained runtime connection identities. At capacity the valid current owner stays active; explicitly close and recreate the controller to start a new lifetime. No ownership, requests, identities or grants are persisted or restored.

The public `@101/connect/examples/input-ownership` example runs actual `PointerSourceDriver` producers through independently granted routes into application surfaces. `/studio/ownership` uses the reusable `InputOwnershipPanel` for review, decline, cancellation, transfer, partition selection, release and retry with native controls and keyboard focus. Pointer lab and the input diagnostic retain their current owner while a separately scoped connection is prepared and compared; Stop closes owner and candidate. These local application controls do not inject OS input or qualify physical ergonomics, account identity or native ownership.

## Opted-in telemetry history

`createTelemetryHistory({ ownerId, storage, trustedNow, authorize, limits? })` is independent of live runtime queues. An explicit `requestCapture` requires an exact owner/resource/schema-version/selected-fields/purpose/destination/deadline grant. It returns an opaque in-memory handle; `enqueue` synchronously snapshots a bounded observation and returns backpressure without waiting for storage. Capture defaults off. Supported fields are closed scalar/boolean/enum records, with selected calibration/processor/conversion provenance. Original source clock, time and quality are preserved; trusted ingestion time controls retention.

`createIndexedDbTelemetryStorage({ databaseName, indexedDB? })` atomically updates one bounded owner envelope. `flush` commits at most sixteen rows / 32 KiB per call. Hard ceilings are sixteen pending rows / 64 KiB, 256 retained rows / 1 MiB, 4 KiB per row, sixteen handles per action and seven-day retention; defaults retain 24 hours. Oldest rows are evicted at the configured quota. Expiry is applied on subsequent history execution; hosts can schedule `sweep` with an owned timer. Invalid storage or a backwards/nonfinite clock retires authority. Close storage and history on unmount.

Uploading requires a separate exact `requestUpload` grant and trusted uploader closure. One batch runs at a time with bounded timeout, retries/backoff, stable batch IDs and exact ACK validation. Credentials remain inside the closure, absent from storage/export. A reopened history retains rows but restores no capture/upload handles or automatic forwarding. A new grant is required. `exportPage` and owner-local `delete` are bounded; deletion changes the stored epoch to fence delayed writes/ACKs. Remote recipient deletion, audit retention, backup and cross-device sync remain B05/B06 work. The packed memory example preserves actual process RSS and its producer clock; browser proof uses genuine IndexedDB and a local-only unavailable recipient followed by ACK while a real independent command route still delivers.

## Managed owner data

`createOwnerDataController({ ownerId, storage, trustedNow, authorize })` supplies the selected `managed-owner-data/1` engine. `openStores({ retireOwned })` obtains fresh owner approval and returns fixed telemetry, settings and local artifact storage ports for the existing producer APIs. All writes and the durable owner epoch/deletion barrier commit inside one real storage transaction. Owner grant, controller lifetime, port closure and artifact producer cancellation reach that transaction's commit guard and abort signal. Separately wrapping legacy stores with a permission check before a write does not provide this guarantee. The host supplies current grants, calls each producer's close method, and synchronously retires its owned capture/upload/job work through `retireOwned`.

`exportPage` uses closed producer projections with explicit purpose, destination, selected fields and grant byte budget. Pages contain at most 32 rows or 64 KiB, with cursors bound to the owner epoch and data revision. Copy grants cap selected batches at 32 KiB; managed document grants cap the envelope at 2 MiB. Identity, credentials, signing keys and grants are outside the managed namespaces. Local artifact bytes require separately reviewed exact application/destination/content pins; they are otherwise omitted. `storeLocalTelemetryCopy` registers only separately approved copies inside this engine. Previously uploaded or unmanaged copies cannot be deleted by this local store.

`beginDeletion` persists a pending operation and advances the epoch before its selected collection stages run. Selecting telemetry also selects its registered derived copies. `resumeDeletionReviewed` requires a fresh decision for each bounded stage; restart exposes pending history and restores no approval or automatic work. Completed status requires readback proving selected retained records and registered local copies are gone. Old writer leases stay fenced, and new recording needs fresh consent. The write barrier cannot cancel an already issued external command or upload.

The envelope is capped at 2 MiB, with eight store leases and one controller operation. The IndexedDB adapter reserves at most eight storage operations, rejecting additional work. Producer quotas remain unchanged. Copy batches contain at most 16 records/32 KiB; retained registered copies are capped at 64 rows/256 KiB. Telemetry expires within seven days; local artifact collection expiry starts at its first write and updates never extend the window. Settings remain until reset/deletion. `sweep` applies expiry using trusted time. Redacted deletion/expiry audit uses fixed actions, counts, times and opaque operation IDs, retains records for 30 days, and rejects capacity at 128 rows/64 KiB rather than evicting policy-required audit early. Corrupt, future and foreign envelopes and unreadable nested producer records are preserved; separate reviewed producer recovery is required before deletion can proceed. This profile leaves desktop replay, unmanaged copies, backup/sync and physical native privacy qualification under B05/B06/S15/V11.

## Durable local artifact jobs

`createDurableArtifactJobStore({ ownerId, storage, authorize, now? })` implements the selected `101:local-artifact/1` profile. Requests pin application, destination, idempotency key, input asset SHA-256 and bounded progress units. It retains at most eight jobs, four attempts per job, 64 progress units, 64 KiB owner document/input and 4 KiB output. Execution lasts at most sixty seconds. Grant deadline/current-check/signal fields must be own data properties; accessors are rejected and captured values cannot extend authority. `submit` preserves idempotency; changed requests conflict. `start` verifies supplied input bytes and obtains fresh host authority. Attempts expose an AbortSignal plus `progress`, `commit` and `fail`.

`createIndexedDbArtifactJobStorage(indexedDB, databaseName)` supplies atomic compare-and-swap with a current-authority/signal guard at the write. Output bytes, asset reference and completion evidence commit in the same owner transaction. Cancellation, revocation, expiry and generations fence late writes. No external artifact write is claimed atomic. Reopening accepted/running work requires explicit owner review, current input and a fresh grant through `restartReviewed`; work never replays automatically. Historical attempts retain their outcomes. Corrupt/future/foreign documents are preserved; `recoverStorageReviewed` permits explicit recovery only for this owner's unreadable records, never erases healthy history or a recognizable foreign owner. A backwards clock retires authority. `readOutput` obtains separate fresh authority and verifies retained bytes; `close` retires signals synchronously and records owned interruption asynchronously.

The packed `durable-artifact-jobs` caller runs an actual authorized `kind: job` route, yields through bounded chunk generation, commits a local artifact, then independently verifies retained bytes and SHA-256 before recording observed local evidence. A duplicate request reads the same artifact without dispatch. This is evidence for that selected local profile; printer dispatch, recording profiles, physical effects and their device/runtime acceptance remain A13/V11/G scope.

## Versioned owner settings

`createSettingsStore({ ownerId, storage, availableDevices, minimumRevision? })` saves preferences and reviewed profile selections under `101.settings:<ownerId>`. The `SettingsStorage` port supplies `read` and an atomic `compareAndSwap`; `createIndexedDbSettingsStorage(indexedDB, databaseName)` implements both with actual local IndexedDB transactions. Call `close()` when its owning application unmounts. A store has no connection to route authorization, identity creation or secret storage.

```ts
import { createSettingsStore, createIndexedDbSettingsStorage } from '@101/connect';
const storage = createIndexedDbSettingsStorage(indexedDB, 'my-owner-settings');
const settings = createSettingsStore({ ownerId: 'owner', storage, availableDevices: () => [] });
const loaded = await settings.load();
if (loaded.ok) await settings.save(loaded.value.revision, {
  preferences: { theme: 'system', handedness: 'right', motion: 'reduce' }, profiles: [],
});
storage.close();
```

Documents are bounded immutable JSON: version 2, owner, monotonic revision, three preferences and at most eight selections. Each selection has a local ID, device ID, profile ID/revision and finite scalar calibration (`scale`, `offset`). These choices cannot add code, grants, invitations, credentials or live payloads. A stale revision or simultaneous write returns `conflict`, preserving the accepted record. Storage failure returns `unavailable` without backend messages.

The declared version 1 has `theme` and `handedness`; loading it atomically adds `motion: 'system'` and increments the revision. Unknown future versions, malformed records and foreign owners are preserved and return fixed failures. `availableDevices` is trusted current inventory; load atomically prunes selections for absent devices. `removeDevice` removes a selected device explicitly. `reset` explicitly discards this owner's choices, can recover corrupt/future data, preserves recognizable foreign records and advances known revisions.

An in-process high-water mark rejects older records. Supply `minimumRevision` from a trusted boundary outside the restored settings backup to detect rollback after restart. Without that floor, an older valid preferences backup may load in a fresh process; it still supplies no authority. This SDK format does not migrate the legacy controller localStorage or desktop Hub settings file, and supplies no cross-device sync or configuration backup service. The packed `settings-storage` example defaults to simulated storage; the B03 browser receipt separately verifies actual IndexedDB persistence, concurrent transactions, migration, recovery and isolation.

## Runtime inspector

`createRuntimeInspector(options)` owns a public `DeviceRuntime` wrapper and exposes `snapshot()` and `close()`. Register resources, route and publish through `inspector.runtime`; host authorization, leases, schema validation and delivery stay in the runtime. `snapshot()` reports local resource/route aliases, readiness, schema/value/delivery summaries, requested operations, grant outcomes, queue bounds, negotiated limits, operation evidence and bounded action/error traces. `traceCapacity` defaults to 32 (maximum 256); `maxTrackedRoutes` defaults to 32 (maximum 128). Closed routes are retired before the route limit rejects further active work.

Reports exclude descriptor IDs and labels, principals, applications, sessions, samples, provenance, arbitrary exception messages and arbitrary stop reasons. Operation IDs become local aliases; diagnostics use an allowlist of fixed codes. Snapshot data is immutable. Ambiguous stale admission can report readiness `unknown`; explicitly set readiness to recover a known state. Closing releases all owned routes/resources and subscriptions. This is an explicitly owned runtime, not a global observer of other applications.

Studio's `/studio/inspector` runs the independent SDK with a typed event source and command sink. Keyboard actions exercise deny/allow/revoke, readiness loss/recovery, queue saturation/flush, observed local effects, schema/version rejection, expiry and teardown/reset. The fixture clock is explicit and its local effect supplies no physical-device qualification.

## Reviewed local extension installation

`parseProcessorExtensionRelease` and `verifyProcessorExtensionRelease` validate the closed `reviewed-processor-extension/1` profile using native P-256/SHA-256 signatures, real source bytes, the full manifest pin, publisher/version/sequence and fixed runtime/ABI compatibility. This profile accepts only local computation with no dependencies or assets. Device, network, filesystem and native privileges remain unavailable.

`createProcessorInstallation` stores inert signed releases in owner-scoped atomic storage. Loading never restores activation, approval, keys, factories or route grants. The host separately supplies a provisioned publisher key and rollback floor, fresh owner approval, an exact reviewed factory/source binding and independent conformance fixtures. Successful updates and explicitly approved retained-version rollbacks retire previous handles and owned outputs. Failed staging or conformance preserves the accepted version. Revocation and removal fence local authority before persistence; storage revision checks also fence another controller's changes during approval and execution.

Limits are four package slots, two retained source releases per package, 16 remembered version identities and revoked publishers, 256 KiB source, 4 MiB owner document, eight handles, one mutator, one-second async waits and approvals lasting at most 60 seconds. Removal retains bounded identity/revocation tombstones. The example filesystem adapter uses a private directory, guarded atomic rename/fsync and compare-and-swap; an orphan writer lock fails closed and requires host review.

`examples/extension-installation/consumer.mjs` verifies both bytes and signatures before importing its two fixed reviewed local implementations. Its real route-backed caller changes the temperature threshold, exercises update and rollback, cancels queued effects, denies an unapproved route and reloads inactive in fresh processes. This is trusted in-process code: host factory binding, synchronous cleanup and checking `activation.isCurrent()` before effects remain explicit host obligations. Untrusted code isolation, synchronous hang preemption, connector/native/dependency/asset profiles and physical qualification remain open under E10.

## Local package submission and review

`createLocalPackageCatalog` implements `local-reviewed-processor-catalog/1` for the existing signed local processor release profile. An author submits actual source bytes plus publisher-signed documentation, provenance and claimed test evidence. An independently provisioned reviewer signs a decision bound to the exact submission, release, source, docs, provenance, fixture and report digests. An author's passing report remains a review input. The independent caller runs the real E09 conformance suite with fixed host-reviewed code and independent expectations before signing its review.

The host provisions owner/principal/role, current publisher/reviewer/owner keys and floors, snapshot signing and fresh scoped operation approval. The catalog persists signed inert records. `submit`, `review`, `supersede`, `revoke` and `remove` use guarded atomic compare-and-swap; `inspect` and `readSubmission` require current access and fence the storage revision after awaits. Grant, factory, activation and resource permission state are absent from the document. The installer separately obtains its required approvals and trusted bindings.

Versions are immutable: identical resubmission is idempotent; changed bytes under an existing version conflict. Review status distinguishes submitted, approved, changes-requested, rejected, superseded, revoked and removed. Current availability also checks live trust/floors. Supersession explicitly selects two approved versions; bounded tombstones retain removed/revoked version identities. Fresh processes restore signed review history and require new operation grants.

Owner signatures authenticate the complete snapshot. A separately provisioned minimum catalog revision rejects older restored files; restoring that external checkpoint as well is outside this profile. Limits are four packages, two resident releases per package, 16 known version identities, 64 review/status events, 16 reviewers, 256 KiB source, 16 KiB docs, 4 KiB provenance, 8 KiB evidence and a 4 MiB document. One operation runs at a time, async waits last at most one second and grants at most 60 seconds. This local workflow leaves public publication, broader package types, untrusted code isolation and physical qualification open.

## Reviewed connection links and addresses

`parsePairingInput` and `createPairingIntake` bound ticket/link parsing and scan intake before decoding. Links, saved tickets and camera scans create immutable review candidates; only approval of the current unexpired candidate creates a connection. Browser navigation retires the previous connection owner, so returning to an old URL requires fresh approval. Native saved/deep-link/scan arrival also waits for review; manual connections retain their explicit action.

The three browser host surfaces use `HostConnectionReview`: choose an address, read its bounded health response, review the separate phone service/page origins, then Connect. Link, saved and desktop fragment hints remain inert. Both the Node Hub v1 and the actual desktop Hub v2 health envelopes are closed and bounded. Desktop bearer fragments are removed from the address bar immediately and held in memory until the selected service is approved; the claim rotates authority using the separately reviewed phone endpoint.

Legacy HTTP signaling fixes the selected origin/session, uses manual redirects and omitted ambient cookies, limits requests and streamed responses to 1 MiB, peer lists to 64, stream chunks to 4096 and pending calls to four, with a 2.5-second deadline and finite rate budgets. Cancel/close fences late replies, including empty acknowledgements. Native signaling uses Expo's adapter, whose installed iOS/Android implementation handles redirect and cookie policy; local bundles do not prove execution on a phone. These protections do not cryptographically authenticate a legacy HTTP Hub. Complete discovery identity protection, native execution and physical pairing remain open under D09.

The library, Devices and game setup share the browser's persisted random room choice. A valid explicit URL room takes precedence when a route mounts, including client navigation in the same document. Room codes identify a session; they confer no access. The native controller's one saved-ticket owner validates at the end of each keychain read, removes expired or malformed tickets when storage is writable, and returns no ticket if validation or cleanup fails. Its eight-operation queue serializes cleanup with replacements; clock failure preserves stored bytes. Saved tickets only enter review and require a fresh Connect action. [Pairing recovery evidence](receipts/2026-10-06-pairing-recovery.json) covers real local Hub/browser behavior and native software regressions/compilation; phone testing remains separate.

## Independent extension conformance

`runConnectorConformance(candidate, fixture)` and `runProcessorConformance(registration, fixture)` run outside 101 through public imports. Connector candidates provide reviewed source/sink descriptors and an explicit trusted factory implementing start/send/apply/release/stop, plus feedback for command evidence. The host hooks publish through an actual embedded runtime and instrument observable local effects and owned resources. Fixtures contain at least two distinct valid values and one invalid value. The current connector suite covers streaming unpartitioned resources with compatible delivery modes.

Checks exercise manifests/schemas, denied and revoked resource grants, exact admission results, every supplied vector, reliable ordering/overflow or latest coalescing/rate limits, dispatch versus acknowledgement/observed evidence, disconnect, stop and idempotent cleanup. Processor checks use the trusted registry's exact source hash pin, invalid configuration/input rejection, caller-authored output vectors, fresh replay and each declared reset cause. The public `conformance` example includes healthy candidates and deliberate resource-leak/reset failures.

Reports contain fixed check IDs, passed/failed/not-applicable outcomes, limits and limitations; they exclude payloads and private exception text. Limits are 32 fixture cases, 256 callbacks, 128 instrumented resources, one-second async waits and 1 MiB reviewed processor source. A passing report proves only the supplied deterministic fixtures for trusted in-process code. Synchronous hangs cannot be preempted, memory and uninstrumented resources are unmeasured, and physical behavior or plugin isolation still require their own qualification. Manifests and descriptions never load or select executable factories.

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

## Connector and device profile manifests

`parseConnectorProfileManifest` validates immutable schema-1 profiles with exact profile/decoder versions and SHA-256, provider identity filters, JSONL framing, typed resource directions, units, permissions, scalar calibration revisions/error bounds, command idempotency/deadlines/safe-state and supported feedback levels. Declared observed command feedback names a compatible independent source resource. Identity filters match separately observed provider facts; they do not authenticate the provider.

`createTrustedConnectorProfileRegistry().registerTrusted({ manifest, source, factory })` verifies the real reviewed source digest and binds an explicitly supplied decoder factory. `resolve({ id, version, codeSha256 })` returns an opaque current-process binding. Metadata supplies no import path or executable selection. `createProfileConnector({ binding, observedIdentity, now, onSample, onUnavailable, write })` owns framing and command lifecycle. `start` returns an opaque capture handle; `push` accepts only that current generation. Stop/restart retires old buffers, sequence state and command authority. The caller separately registers sources/sinks and obtains runtime route grants.

Samples retain producer clock/time, sequence, quality and calibration separately from host receipt time. The Node memory caller publishes using its host clock while keeping the original producer stamp in provenance, so a foreign timestamp never becomes a local freshness deadline. Command writers receive a currentness check and abort signal to check immediately before effects, including after awaits. An ACK supplies target acknowledgement; observed evidence additionally requires a new matching sample from the declared independent state resource after that ACK. Release, expiry and revocation request the declared safe-state through the owned writer; local dispatch does not establish a physical effect.

Per-instance hard ceilings include 64 KiB frames/chunks/buffering, 64 frames per push, 32 outputs per frame, 16 pending commands, 4 KiB commands and five-second callback deadlines. The registry retains at most 32 trusted bindings and four simultaneous registrations; reviewed source is capped at 1 MiB. Trusted synchronous decoder/writer code is not isolated or preempted. The independent Node example reads actual `process.memoryUsage().rss` in integer UCUM `By` and separate sampling-enabled state. Its zero representation error describes the API's byte integer, not measurement accuracy for physical hardware. HID, serial, BLE, industrial protocols and physical sensors remain separate A02–A16 profiles.

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
into seven local ESM tarballs under a fresh ignored `release/sdk-*` directory.
The manifests define JavaScript/type roots, schema subpaths and facade example
subpaths. They include MIT licenses, public readmes and compiled/source examples;
private implementation subpaths and install scripts are absent. Workspace exports
and app/native dependencies retain their existing source contract.

Install all seven matching tarballs outside this repository with
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
Selected Swift/Kotlin/C pointer codecs are built separately below. Full native runtime
bindings and future API/platform qualification remain open.

The application collector is separate: `npm run package:release -- --release web hub`
requires every selected production target and exits nonzero on any skip. Each
invocation owns a new `release/package-*` directory and preserves earlier SDK
artifacts. Current Link exports are intermediate and Wear APKs are debug, so
release mode rejects those profiles. Default mode remains a diagnostic report.
Every manifest records `releaseAccepted: false`; successful packaging alone
does not establish signing, installation, support or publication approval. See
[required-target QA](REQUIRED-TARGET-PACKAGING-QA-2026-10-02.md).

## Secure WebSocket fallback

`@101/transport-websocket` and the facade export `SecureWebSocketTransport`, `WSS_SUBPROTOCOL` and their public types. The selected direct fallback is explicit: the host supplies a canonical `wss:` endpoint, a current identity, a new connection epoch and separate resource approvals. User info, query/fragment fields and control characters are rejected. The browser default uses native `WebSocket`; a server port is a trusted adapter from the host's own TLS listener. Supplying a port does not establish that TLS occurred.

`createSecureWebSocketPeer` in the public `@101/connect/examples/secure-websocket` subpath creates the raw transport and `AuthenticatedResourcePeer`. `start`, caller-scheduled `tick` and `stop` own this instance. Identity creation, timers, automatic reconnect and resource grants are absent. Each replacement requires a fresh instance/epoch, endpoint enrollment and owner resource selection. A pinned endpoint key or bilateral comparison establishes endpoint proof; invitation possession supplies no resource permission.

Both lanes negotiate `ordered-bounded/1` over one socket. Defaults permit 69,632 payload bytes, 131,072 native buffered bytes for reliable admission and 16,384 for latest admission; hard ceilings are 131,072/262,144/65,536 respectively. Admission includes the 39-byte frame and UTF-8 payload bytes, with reliable headroom and no additional raw queue. Negotiation is limited to eight controls, 4 KiB per control and five seconds. Endpoint, subprotocol, both actual hello messages, selected limits, connection tag and participants enter the separate `101.endpoint-wss-transcript/1` signed proof. WebRTC retains its original SDP/fingerprint transcript.

Local admission cannot recall bytes already handed to a socket. The resource binder keeps source-clock mapping, maximum age, operation deadlines, latest replacement, reliable replay protection and silence release. Late data cannot restore a retired route. [Transport and view evidence](receipts/2026-10-06-transports-views.json) records the actual packed Chromium/Node path in both directions, a 700 ms stalled receiver, saturation, loss release and replacement enrollment. The browser uses an isolated localhost certificate exception; independent Node checks verify CA and hostname success/failure. Relay, two-network and physical-phone acceptance remain open.

## Local HTTPS coordinator

`@101/hub-server` exports `createHttpsCoordinator`, `createCoordinatorFetcher`, `HTTPS_COORDINATOR_LIMITS` and their option/enrollment types. This is the selected `provisioned-loopback-node-mtls/1` rendezvous profile, separate from the seven browser SDK packages. The server binds only `127.0.0.1` and requires TLS 1.3, a matching valid server certificate/key with that IP SAN, a trusted client CA, exact HTTPS origins and unique provisioned certificate-to-principal/device enrollments. Native certificate verification plus current enrollment fingerprint/validity governs every request.

Authenticated creation, invitation join, host rotation, private offer/answer, reconnect and departure reuse the public pairing clients. Host and peer requests need their role bearer and authenticated principal; copying a bearer to another enrolled principal fails. Device identity comes from enrollment. The host sees only its session's peers and a peer can read only its own offer. Endpoint overrides and forwarded-header authority are rejected. Rendezvous permission grants no device resource access.

The finite ceilings include 64 enrollments, sixteen origins/sessions, four sessions per principal, eight peers per session, sixteen peers per principal, 32 total sockets, 32 requests per principal per second, four pending caller requests, 401,024 request/response bytes and ten-minute sessions. `createCoordinatorFetcher` verifies CA/hostname, permits only its configured origin/endpoint, rejects redirects and closes its owned agent/requests. `stop` destroys accepted sockets and ephemeral authority; stopped coordinators cannot restart. Credentials are host supplied and never emitted by the public example or receipt.

`examples/coordinator/https-coordinator.ts` is the real provisioned Node caller. `node --experimental-strip-types tools/qa-https-coordinator.mjs` exercises disposable local certificates and the normal public exports. Its generated offer/answer proves private signaling, without claiming a WebRTC/media session. Browser client certificates, accounts, enrollment/key lifecycle, persistent directories, relay and phone/two-network qualification remain separate.

## Independent application views

`createApplicationViews` owns one caller-scheduled synchronous application engine. `tick` advances it once, snapshots bounded inert state, then evaluates each active view projection once regardless of display count. Each view declares a value schema; only its validated projection reaches an output. The full simulation snapshot stays with trusted host projection code. Projection and rendering callbacks are trusted code, with no extension sandbox claim.

`attach({ viewId, outputId, principalId, apply, release })` binds concrete source/destination registrations, application/session, view, output and principal before asking the host for source-owner and output-owner consent. Default denial, unknown views, duplicate outputs and exhausted quotas create no route. Sixteen views and sixteen outputs are allowed, with one queued latest frame per route and 32 pending deliveries total. The private snapshot has the model's 64 KiB/depth bounds; each delivered observation/options envelope must fit the runtime's 4 KiB bound. Grants last at most sixty seconds, output leases thirty seconds, maximum age one second and rate 120 Hz. `handle.renew()` obtains fresh host approval; `handle.stop`, principal `revoke`, expiry and application `stop` retire owned routes. A broken clock/engine stops all views; a broken projection retires only that view.

`mountApplicationViewCanvas` is the independently authorized local Canvas2D adapter. It measures with `ResizeObserver`, coalesces geometry changes into one owned animation frame, caps each backing/staging canvas at 1,048,576 pixels and stages synchronous rendering before rechecking current delivery authority for the visible copy. The host supplies accessible labels and a trusted synchronous drawing callback. Stop clears visible/private retained frames and disconnects the observer/cancels animation work. Mounting the same canvas twice is rejected.

The public `@101/connect/examples/application-views` caller supplies two common displays and a separately approved owner display from one simulation. Actual packed Chromium/WebKit checks cover canvas pixels, private projection denial, resize, memory bounds, revocation during staging, expiry, renderer failure and teardown. This local typed-frame profile does not claim capture/encoded media, physical monitor behavior or cross-host streaming.

Verification: [foundation QA record](FOUNDATION-QA-2026-10-01.md).

## Provisioned private resource directory

`provisioned-session-directory/1` extends the local Node mTLS coordinator. Trusted
startup `directoryResources` pin an enrolled principal/device, a parsed descriptor
and selected capability IDs. An authenticated current host explicitly enrolls a
resource in its current session, then grants a current joined peer visibility to
selected resource IDs until expiry. Joining alone returns an empty directory.

`createPrivateDirectoryClient` is a source Node hub export. Its `list`, host-only
`enroll`, `allow`, `remove`, `revoke` and `close` methods use the actual configured
TLS caller and role bearer. Construction sends no request; every operation is
explicit and accepts an optional `AbortSignal`. Close aborts owned requests and
the native agent. There is no polling, directory cache or persisted authority.

The packed model exports `parsePrivateDirectorySnapshot` and
`privateDirectoryCandidates`. Responses contain only resource ID, revision,
reviewed label, selected capability summaries, scope and expiry. Discovery hints
remain unverified until the host independently verifies their receipt; they do
not authenticate an endpoint, make a resource ready or grant a runtime route.
`examples/coordinator/private-directory.ts` demonstrates separate exact runtime
registrations and resource-owner approval after directory visibility.

The profile permits 32 startup resources, sixteen session resources, eight selected
capabilities/resource and eight visibility grants/session. Each request fits 8 KiB;
the complete escaped UTF-8 response fits 64 KiB. Mutations reserve the full future
response size before commit. Resource/visibility lifetimes last at most sixty
seconds and are capped by session/certificate expiry. Reconnect retires generation
visibility; leave, removal, revocation, host rotation and stop retire their scoped
authority. Re-enrollment does not restore a removed grant. Persistent/account
directories, enrollment/key lifecycle, peer-owned publication, browser client
certificates and physical/two-network qualification remain open.

## Native normalized pointer codecs

`normalized-pointer-bindings/1` supplies Swift `One01PointerWire`, Kotlin
`com.oneohone.pointerwire` and the C `one01_pointer_wire.h` API. They encode/decode
the existing `normalized-pointer/1` disposable 48-byte big-endian sample. Epoch,
slot, sequence, finite capture time and normalized coordinates retain the public
JavaScript codec contract. Decoded values are inert; the existing JS host still
owns endpoint authentication, selection, freshness, grants and release.

Build from one immutable source tree with
`node tools/build-pointer-bindings.mjs TREE --sdk-root INSTALLED_CONSUMER --sdk-manifest SDK_MANIFEST`,
then pass the emitted manifest and the same SDK inputs to
`node tools/qa-pointer-bindings.mjs BINDING_MANIFEST --sdk-root INSTALLED_CONSUMER --sdk-manifest SDK_MANIFEST`.
The local tarballs contain compiled artifacts, source, clean callers, MIT license,
profile, schema, shared producer fixtures and source/toolchain/file hashes.

Qualified here: Swift 6.3.3 and C11/Apple Clang 21 on macOS arm64, plus Kotlin 2.1.21
on JDK 21. JVM target 17 is declared but was not run on JDK 17. C requires IEEE
binary32/binary64, rounds coordinates to nearest ties-even independently of the
caller's rounding mode, and leaves output untouched on invalid input. Kotlin copies
epoch inputs/getters; Swift handles nonzero-start `Data` slices. iOS, Android,
other native targets/ABIs, native transport/lifecycle authority and public
distribution remain unqualified. These selected codecs keep E12/K03 partial.

## Capture-to-output timing

`createPipelineTimingCollector({ capacity })` records complete local timing traces
under `capture-output-timing/1`. A trace has source capture/final encoding stamps,
target receipt/decode/apply/render stamps and the actual capture clock mapping.
Source durations are bounded in the target clock using the declared relative-rate
limits; transit preserves those bounds and the capture mapping uncertainty.
Unknown fields, incomplete/reversed/nonfinite stamps, unsupported clock comparisons
and durations over sixty seconds reject the whole trace. The default latest window
holds 256 samples; the hard ceiling is 2,048. `snapshot` reports independent
nearest-rank lower/upper P50/P95/P99 bounds for processing, encoding, transit,
decoding, sink delivery, render and total capture-to-output, with maximum clock
uncertainty. Empty windows report null quantiles; rejected and evicted counts stay
visible. `clear` resets an open window; terminal `close` clears buffers and rejects
new work. Nothing is persisted or automatically uploaded.

`RemoteResourcePublisher` and `RemoteResourceReceiver` accept optional `onTiming`
callbacks for actual final encoding and decode boundaries. Default-off hooks add
no timing clock reads or wire bytes. Only accepted values emit frozen local
metadata (epoch, slot, sequence and stamps), with no signal payload; callbacks
cannot grant routes, and observer exceptions do not govern admission. Match these
local records with actual sink apply/render stamps and the receiver-owned mapping.
Missing output stages are not estimated or counted as completed traces.

The public `@101/connect/examples/timed-pointer` caller uses actual native local
MessagePorts, negotiated pointer bytes, clock exchange, explicit host approval and
current runtime sinks. The caller supplies actual output, release and monotonic
clock callbacks, owns scheduling, and closes the example on departure. Encoding
measures the final codec pass; processing includes earlier validation, preflight
encoding, input work and any coalescing wait. Render ends at the caller-declared
local output commit; browser QA uses DOM/layout and an owned animation-frame
boundary. The serial 64-frame Node/three-browser workload is instrumentation
evidence, not a throughput or network benchmark. JS capture excludes physical
acquisition, and a frame callback does not prove display photon time. Physical
phone, assistive, thermal and impaired-network qualification remains separate.

## Reviewed resolution of unknown devices

`createProfileResolutionController` connects an explicitly verified discovery
observation to a host-reviewed connector profile. Configure the expected discovery
scope, trusted observation verifier, existing profile registry and at most eight
exact profile/version/code-hash pins. `observe` retains bounded observed facts;
`request` exposes the reviewed resources, units, calibration and command semantics;
`decide` returns an opaque current choice. `createConnector` creates an inactive
connector. Its explicit `start` and each runtime resource grant are separate actions.
Profile selection grants neither endpoint identity nor resource access.

Unknown, unsupported, review, selection and expiry remain visible in `snapshot`.
An unsupported or cancelled review preserves a valid incumbent. A new observation,
removal, verifier loss, expiry, clear or close retires its owned connector. Observation
and review last at most thirty seconds; one controller owns one pending review,
one choice and one connector, with at most sixty-four lifetime connector creations.
The genuine Node RSS caller is `examples/device-profiles/manual-resolution.mjs`;
`node tools/qa-profile-resolution.mjs --sdk-root INSTALLED_CONSUMER` verifies it
against immutable local SDK files. This establishes reviewed declarations for a
selected producer; live inventory, OS choosers and general hardware support need
their separate qualification.

## Local managed-owner backup and reviewed recovery

`createOwnerBackupController` supplies a `managedStorage` port to the existing
owner-data controller. The `managed-owner-backup/1` envelope maintains the current
epoch, data revision, retained deletion/audit floor and two local recovery archives.
Archives contain genuine managed producer state and content hashes, never live
recording authority. Their retention ends at the earliest included producer or
audit deadline, capped at seven days. Archive expiry is checked through validation,
host callbacks, the actual storage commit guard and final return.

`backup`, `readBackup`, `inspect`, `sweep`, `migrateReviewed` and `restoreReviewed`
require exact current owner approval. Restore requires the exact archive hash and
current damaged state; healthy state, missing/corrupt outer fences and stale
archives fail closed. Successful recovery advances the epoch and fences old ports.
Unfinished artifact jobs become interrupted and require fresh review; completed
outputs retain verified bytes and their historical evidence. `retireOwned` retires
host-owned work synchronously; it cannot undo an already issued external effect.
The archive ceiling is 128 KiB each; managed data fits 1.5 MiB and the entire owner
document 2 MiB. Metadata CRC detects accidental corruption; archive SHA-256 checks
content integrity. Neither authenticates a malicious filesystem host. Registered
recipient copies, remote storage and unmanaged/native/desktop recovery are excluded.
Run `node tools/qa-owner-backup.mjs --sdk-root INSTALLED_CONSUMER` for the selected
filesystem and IndexedDB first callers.

## Pending delivery limits by authorized scope

`RuntimeOptions.maxPendingDeliveriesPerScope` optionally bounds actual pending
provider work for the exact principal/application/session tuple. Select an integer
from one to `maxPendingDeliveries`; omission preserves the existing global policy.
Logical cancellation or route replacement retains its reservation until the raw
provider result settles. Other approved scopes can use remaining global capacity.
The existing rotating recipient order applies to both reliable and latest delivery.
This is a work-admission bound for cooperating providers; it does not sandbox
callback CPU or enforce byte quotas, and enough distinct approved scopes can still
occupy the global capacity. F05 remains partial.

## Live inventory for selected resources

`createCapabilityInventory` reviews at most sixteen declared resources from actual
registered runtime sources. Select `read` or `subscribe` with the exact principal,
application and session. `start()` creates private compatible sinks and requests
normal runtime authorization; `matches()` only compares that exact request and
never grants it. Unknown resources, unavailable providers and unsupported
operations remain visible without creating a successful probe.

A subscription becomes supported only after actual current data arrives after
the probe starts. A separately authorized one-shot property read may qualify a
fresh retained value and keeps its original age. Proof records source registration,
descriptor/schema revisions, sequence, quality, timestamps and bounded provenance;
it keeps no observation value history. Foreign producer stamps remain provenance,
separate from the declared runtime receipt clock. This does not estimate a
cross-clock capture age.

The helper owns one expiry timer, at most sixty-four lifetime starts and bounded
reliable queues. Silence, route loss, stop or close clears current support and
retires owned routes and sinks; borrowed sources remain caller-owned. The genuine
Node RSS and enabled-state caller is `examples/device-profiles/live-inventory.mjs`.
Run `node tools/qa-capability-inventory.mjs --sdk-root INSTALLED_CONSUMER` against
a fresh immutable local SDK. This selected inventory establishes no positive
command/action, physical sensor, operating-system control or general hardware
compatibility claim.

## Explicit connection to an enrolled receiver

`createInvitationConnectionController` implements
`enrolled-invitation-connection/1`. The host supplies at most eight independently
enrolled fixed WSS endpoints and their expected P256 key IDs. Manual invitation
JSON, a copied fragment link or QR-decoded text produces an inert opaque review.
The carrier link chooses neither the network URL nor the trusted endpoint key.
An explicit current connection grant binds the owner, endpoint/key, application,
session, invitation epoch and deadline. Only an actual authenticated peer with
that exact scope yields a connection handle.

Invitation possession and connection approval supply no source capture,
registration, remote resource selection or runtime route grant. Those approvals
remain independent. Unsupported or denied reviews preserve the current connection;
an accepted replacement retires it before issuing the new socket. Cancellation,
expiry, enrollment loss, grant abort or endpoint disappearance retires the owned
peer and transport. Recovery requires a fresh review and explicit grant, with no
automatic reconnect. Native or host-supplied TLS socket capability must be available.

The controller retains sixty-four redacted transitions, one logical pending
connection and one timer. It caps reviews at eight per second and connection
attempts at thirty-two for its lifetime. Connection timeout is five seconds;
grants last at most sixty seconds and cannot exceed invitation or enrollment
expiry. Raw authorization promises and closing sockets remain counted until their
actual completion; logical cancellation does not imply their work settled.

`@101/connect/examples/invitation-connection` exports
`createInvitationConnectionSource` and its options. Its explicit source-owner
approval enables actual Node RSS or browser viewport measurements, after separate
receiver/runtime resource approval. Run
`node tools/qa-invitation-connection.mjs --sdk-root INSTALLED_CONSUMER` for the
owned local TLS callers. This does not implement enrolled-agent discovery, optical
QR scanning, account identity or physical phone/network qualification.

## Selected Linux headless client

`linux-node-rss/1` qualifies the owned Linux ARM64 container caller in
`examples/headless-linux/client.mjs`. Its genuine reviewed producer exposes typed
RSS bytes, observed sampling state and a Boolean sampling command. Command
acknowledgment and the separately observed state are distinct evidence. Exact
source/sink registrations and principal/application/session route grants are
required; reading RSS does not permit commands.

Run `node tools/qa-headless-linux.mjs --sdk-root INSTALLED_CONSUMER --candidate-tree TREE`
with the existing pinned local image. The harness creates one disposable container
without network access, using a nonroot user, read-only filesystem and SDK inputs,
no capabilities, 256 MiB memory, thirty-two PIDs and half a CPU. The actual tested
target is Node 24.21.0 on Linux 6.10.14-linuxkit/ARM64; it is not a claim for another
Linux image or runtime. No repository, credentials or Docker socket enter it.

The owned process port caps source bytes at 16 KiB, command bytes at 1 KiB and raw
chunks at 64 KiB. Intrinsic typed-array lengths and snapshots enforce those bounds
without trusting shadowed length fields. One raw write remains reserved until its
native callback settles, including after logical termination. Runtime queues and
retained observations are bounded. Revocation observes the declared disabled
software state; disconnect retires routes and capture, and fresh recovery requires
a new producer identity and independent approval. Original producer time remains
separate from the client receipt clock. The tested software sensor/command does
not establish a physical sensor, MCU, general gateway, remote authentication,
malicious-host sandbox or reversal of an already issued effect.

## Permissioned browser selection

`createBrowserChooserController` derives reviewed options and read/subscribe
resources from selected descriptors. HID, Bluetooth and serial defaults call
their native chooser with explicit bounded filters. Selection does not open a
device, read input, connect GATT or authorize a resource operation. Camera and
audio require a separately bound existing adapter lifecycle; an absent binding
returns `adapter-unbound` without acquiring input.

Call `choose(id)` from a current user gesture in a secure context. An opaque
selection is bound to its controller and activation. `start(selection)` requires
separate exact capture approval and a trusted adapter that checks the supplied
context before effects and after awaits. Runtime resource grants remain separate.
Cancel, denial, hiding, disappearance, expiry, stop and close retire owned leases;
retry is explicit. Native promises and late cleanup retain their reservations
until actual settlement. Limits are eight declarations, eight selected resources,
four filters, eight services, sixty-four lifetime attempts, two native pending
slots and one capture factory. Requests last at most five seconds and selections
thirty seconds, using one expiry timer and a trusted progressing host clock.

`examples/browser-resources/chooser.ts` is a real unactivated browser diagnostic.
Run `node tools/qa-browser-chooser.mjs --sdk-root INSTALLED_CONSUMER` for ordinary
public SDK imports in Chromium and WebKit. These checks establish actual API
availability and permission boundaries without presenting a chooser. Physical
selection, permission dialogs, disappearance and camera/audio adapter execution
remain unqualified; D03 stays open.

## Scoped macOS LocalOnly discovery

`createNativeDiscoveryController` implements `macos-local-only-dns-sd/1`.
Every explicit start needs fresh exact owner/application/session approval for one
service type, `local.` and interface `0xffffffff`. The provisioned Node adapter
launches the reviewed native C executable; every register, browse and resolve
uses Apple's LocalOnly interface. It observes local authoritative software
records without LAN multicast, address queries or remote URL fetching.

Resolved observations are deduplicated by interface, name, type and domain.
Only a bounded `localhost.` target, port and closed `profile=1` TXT record are
accepted. An issued opaque handle can establish observed evidence only; TXT,
labels and endpoint metadata establish no identity, capabilities or operation
permission. Withdrawal, two-second receipt expiry, revocation, crash and stop
remove current rows. Recovery needs a fresh grant and explicit start.

The controller permits sixteen current candidates, eight native resolvers,
sixty-four events per second, 512 TXT bytes, 16 KiB lifetime native output and
thirty-two starts. Startup lasts at most five seconds and grants thirty seconds.
One actual process remains reserved until native exit, including after logical
cancellation. The host supplies a fixed executable path/hash; discovery data
cannot choose a program. Trusted native host callbacks are cooperative.

Run `node tools/qa-native-discovery.mjs --sdk-root INSTALLED_CONSUMER` for actual
LocalOnly registration, resolve, withdrawal, quiet expiry, cancellation, owned
process loss and a separately authorized loopback consumer. The selected Mac
software provider works; LAN, other operating systems and physical discovery
remain outside this evidence, so full D04 stays open.

## Selected redacted operator health

`createOperatorHealthMonitor` implements `selected-operator-health/1`. The host
selects at most eight borrowed RuntimeInspector or WSS status callbacks. Inert
construction reads no metadata. `start()` requires a fresh exact owner/operator/
application/session/purpose and selected-source grant; it supplies no resource
route permission. `sample()` explicitly reads metadata, with a 100 ms minimum
cadence and no background polling.

Reports retain fixed states and validated counts only. Private identifiers become
local source aliases; descriptors, labels, values, credentials, operation IDs,
provider messages and raw reasons never enter reports. Runtime output counts
resources/readiness, routes/grants, queued operations, configured known queue
capacity and faults in the bounded inspector trace. It reports raw provider work
as `null`, because the public queue API cannot measure every unsettled operation.
WSS output reports sent/received/dropped packet counters and buffered bytes, with
an optional explicitly supplied connection state. Counters are sampled metadata,
not byte rates, physical health or end-to-end application effects.

History holds at most thirty-two samples or 32 KiB. The monitor permits sixty-four
lifetime starts, one raw authorization and one timer. Approval must complete in
one second; current grants last at most thirty seconds. Abort, currentness loss,
host or wall-clock expiry, stop and close clear retained history and detach the
grant. Logical cancellation retains an unresolved authorization reservation until
actual settlement. The monitor never stops its borrowed runtime or transport;
synchronous host callbacks are trusted cooperative code.

`examples/operator-health/consumer.mjs` independently approves metadata and
resource routes. Run `node --no-experimental-strip-types tools/qa-operator-health.mjs
--sdk-root INSTALLED_CONSUMER` for actual TLS traffic, genuine Node RSS delivery,
bounded queue/fault counts and revocation through ordinary public SDK imports.
This selected O03 implementation does not qualify coordinator, relay, physical or
all-platform observability.

## Validated local operator startup

`prepareOperatorStartup` from `@101/hub-server` validates
`operator-loopback-startup/1` without opening a listener. Its closed configuration
requires current provisioned mTLS identity/enrollments, exact HTTPS origins,
`127.0.0.1` and a selected port, a bounded owned directory catalog, explicit
ephemeral storage with loss-on-stop acknowledgment, disabled relay, and the
existing `fixed-coordinator-directory/1` ceilings. Unsupported persistence, relay
or custom quotas fail with fixed readable recovery instructions.

An accepted controller exposes `start()`, `stop()` and `snapshot()`. Concurrent
start calls share one native bind. Credentials are checked again before and after
binding. Stop retires the owner and its bearer authority; recovery needs a newly
validated owner. Status exposes counts, limits and a local endpoint without
credentials or personal catalog values. Configuration and session membership
provide no resource grant: directory visibility still needs independent current
owner approval. `examples/coordinator/operator-startup.ts` exercises actual mTLS
admission, directory grant/removal, quota rejection and fresh-owner recovery.
Its optional abort signal retires clients and listeners, prevents subsequent
operations and awaits issued work teardown.

For a disposable repository-source run on Node 24.14 with local OpenSSL, use
`node tools/local-operator.mjs --exercise`. It creates temporary identities and
exercises the actual coordinator and directory. `--serve` opens one ephemeral
loopback listener for fifteen seconds after startup; Ctrl+C or SIGTERM requests
earlier retirement. A `removed` event confirms listener teardown and removal of
the newly owned credentials directory. The command accepts no user credentials,
paths or remote endpoint. It preserves unrelated files. Synchronous credential
generation precedes the listener lifetime; force killing the process has no
cleanup guarantee. The relay dependency remains unavailable, so O02 stays open.

## Scoped disposable filesystem resources

`examples/filesystem-resources/adapter.mjs` exports
`createOwnedFilesystemAdapter` and `OWNED_FILESYSTEM_LIMITS`. Explicit creation
owns a new private temporary root; it accepts no existing user path. Select at
most four reviewed ASCII `.txt` or `.json` leaf destinations. List, read, write
and delete require current exact owner/application/session/action approval and a
current runtime delivery context. A client action grant does not grant access to
sensitive result data: the example uses a separately approved result-read route.

Files hold at most 512 bytes and the root, including staged writes, at most 2 KiB.
Native reads remain
bounded even if a file grows. Writes stage an exclusive 0600 file and replace
atomically; replacement and deletion require the expected SHA-256 value. A
replacement needs room for both old and staged bytes; quota rejection preserves
the original file. The adapter checks root identity, regular single-link files
and `O_NOFOLLOW`. Its
cooperative Node host remains trusted: pathname calls do not establish an
`openat` sandbox against malicious same-user path substitution.

One raw operation remains reserved through actual native settlement and staging
cleanup, including after logical cancellation. There are sixty-four lifetime
attempts, at most sixty-four native calls per operation, one timer and a 2.5-second
maximum logical deadline. Revocation fences later work, acknowledgments and results. An already
issued rename or unlink can still take effect; the result reports that
uncertainty and requires a fresh authorized read to confirm it. `close()` waits
for owned work and removes only selected files and its private root.

Run `node tools/qa-filesystem-resources.mjs --sdk-root INSTALLED_CONSUMER
--candidate-tree CALLER_TREE` for genuine Node filesystem effects through public
SDK imports. The caller tree binds the new adapter/example/test/tool; unchanged
SDK source and installed bytes retain their original artifact provenance. This
selected implementation leaves clipboard, application control and general user
files outside N16's current evidence.

## Browser device add and inspection

The Devices screen opens with local setup information. Explicit Find observes
current browser controllers in the selected room; explicit Add opens the
existing reviewed connection-address task and expiring invitation. Inspect
shows actual reported inputs, unknown or unsupported inputs, permission setup,
recent input activity and quiet/offline recovery. Metadata never grants resource
access or authenticates an enrolled device. Camera inspection queries permission
and availability without starting capture.

The passive observer bounds devices to eight, incoming reports to sixty-four per
second, freshness to six seconds and activity to two seconds. Stop, cancellation,
clock loss and unmount remove its listener/timer, fence late reports and release
only its own transport lease after actual settlement. Keyboard task focus and
return focus, visible controls, narrow layouts and reduced motion are checked
with genuine browser APIs and Controller producers.

Run `node tools/qa-devices-flow.mjs OWNED_LOOPBACK_ORIGIN/` against the source
development server, and `node tools/qa-pairing-intake.mjs OWNED_LOOPBACK_ORIGIN/`
for the existing invitation journeys. U02 remains open for enrolled identity,
general shared-resource details, removal impact and full form-factor/assistive
qualification. See the [exact local receipt](receipts/2026-10-06-devices-add-inspect.json).

## Explicit operator identity replacement

The Node operator API exports `prepareOperatorIdentityLifecycle()` from
`@101/hub-server`. Preparation is inert. Its controller provides `start`,
`rotate`, `stop` and redacted `snapshot` operations for the closed provisioned
loopback mTLS profile. Rotation starts and validates a candidate, retires the old
native owner, then revalidates the candidate credentials before publishing the
new endpoint and generation. Invalid preparation or a failed bind preserves a
valid incumbent. Sessions, directory memberships, bearer tokens and resource
grants are never transferred. Consumers review the new endpoint and obtain
fresh approvals.

The lifecycle admits sixteen attempts and one pending operation. A five-second
startup deadline requests candidate teardown; the real unresolved native start
and closure keep the reservation until settlement. Terminal stop fences late
callbacks and requires a new lifecycle for recovery. The source caller and
`node tools/qa-operator-identity-lifecycle.mjs` exercise genuine mTLS owners,
removed enrollment, old authority rejection, new CA/key identity, expiry during
retirement, recovery and a real delayed native bind. OS key stores, autonomous
expiry, persistent accounts and fleet rotation remain O05 qualification work.
Operator ceilings, trust and maintenance obligations are in the
[responsibility contract](RELEASE-CONTRACT.md#operator-limits-and-responsibilities).

## Scoped private clipboard example

`examples/clipboard-resources` contains an ordinary public Node SDK caller and
a reviewed Swift/AppKit helper. Explicit provisioning creates one private named
pasteboard; it never selects the general or user clipboard. The fixed adjacent
native executable is source/binary pinned. Read, write and clear use separate
exact owner approval and SDK operation grants; sensitive results also require an
independent result route. Values are limited to 128 bytes. Revision and SHA-256
preconditions reject stale writes/clears; clear-before-write is not atomic.

One actual native command remains reserved until its stdin callback and native
response settle, even after logical cancellation. An issued write may have
occurred without a released acknowledgment; a fresh approved read confirms it.
Native owner approval is `{ request, expiresAt, signal: AbortSignal }`; revoke
its controller to cancel consent. Callback-only owner approval is rejected.
The intrinsic signal state is checked after the final clock and delivery observer
before dispatch or release. Delivery revocation must abort its actual signal. The native helper has an original ten-second lifetime and
clears/releases its own board on normal exit. Forced death leaves cleanup
unverified. This is a cooperative host example, not an OS sandbox.

`node tools/qa-clipboard-resources.mjs --source` proves the selected native
source caller. The installed-context helper missed its readiness bound in
preserved tests, including asynchronous launch; that qualification remains open.
No warm-up, retry or deadline relaxation establishes support. General clipboard,
application operations and the full N16 matrix remain open.

## Scoped loopback SSH metadata example

`examples/terminal-resources` provisions a new disposable non-root loopback
OpenSSH host with private ephemeral client/server keys and an exact host-key pin.
Its fixed forced command emits typed platform/architecture metadata and actual
producer-clock provenance. It offers no arbitrary shell, PTY, forwarding, agent,
existing account/key access or remote host selector. The host lasts fifteen
seconds; a command has a 2.5-second deadline and 1,024-byte output ceiling.

`createScopedLoopbackSshConnector` admits one actual child at a time and sixty-four
attempts. Operation and result approvals are independent real abort signals, intrinsically
checked after the final clock and delivery observers at result release. Each
owner grant is `{ request, expiresAt, signal: AbortSignal }`; fresh consent uses a
fresh controller. Mutable delivery revocation propagates through its real signal. A sensitive result uses an explicit SDK `subscribe -> write` route;
connection or command approval cannot create it. Cancellation fences late data
while retaining the actual child reservation until close. Reconnect provisions
fresh host identity and fresh approvals. The installed ordinary public SDK
caller verifies the selected metadata profile; broader terminal operations,
remote hosts, other platforms and the full N15 qualification remain open.

## Explicit browser connection task

The Connections screen offers Send input and Receive input for the declared
`app:pointer/1` resource bundle. Manual invitation and reply codes identify a
session-only native WebRTC peer. Both owners compare the P256 identity proof and
confirm it before either can approve input. Sending and receiving require
independent approvals. Input acts on the receiving screen's application surface.

An active connection remains available while a candidate is reviewed, declined
or fails. Promotion retires its predecessor and requires fresh source/output
grants. Stop, interruption, backgrounding, expiry and unmount release held output
and fence late callbacks. A controller permits one active and one candidate peer,
two actual unresolved native operations, thirty-two attempts, 64 KiB codes,
five-minute invitations, thirty-second setup and sixty-second approvals.

Run `node tools/qa-connections-flow.mjs OWNED_LOOPBACK_ORIGIN/` against the source
development server. Genuine Chromium peers exercise the task, application output,
keyboard recovery, narrow layout, themes and reduced motion. General resource
selection, enrolled remote devices, relay paths, physical devices and named screen
readers remain U03 qualification work. The preserved WebKit traversal failure
leaves that engine's keyboard qualification open.

## Disposable operator overload drill

`examples/coordinator/operator-overload.ts` exercises the provisioned loopback
mTLS coordinator and private directory with five independently enrolled callers.
It checks session, peer, directory and per-principal rate admission ceilings,
cross-principal isolation, explicit metadata visibility, departure and real
directory/session expiry. A retry needs fresh authority; expired invitations and
bearers do not recover access. The minimum session expiry uses an actual
sixty-second wait. No clock substitution or positive-response fixture proves it.

Run `node --experimental-strip-types tools/qa-operator-overload.mjs
--workspace-exports`. The drill bounds itself to 160 native requests, one pending
request, an eighty-five-second deadline and owned listener/caller teardown.
Disabled relay and unknown regions fail configuration validation. Processor
failures, enabled relay failure and regional service qualification remain O04
work; admission ceilings are not measured service capacity.
