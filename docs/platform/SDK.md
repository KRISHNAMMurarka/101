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

## Install, create, connect, test, extend and recover

This walkthrough runs an authored local Celsius source, display and threshold
processor. It does not access a sensor, appliance or OS device. Use an immutable
local SDK artifact containing `@101/connect/examples/device-scaffold` and
`@101/connect/examples/onboarding`; verify its seven tarball hashes against its
manifest. Select the matching trusted TypeScript 5.9.3 tarball and Node/npm
toolchain separately. No package is fetched from a registry.

### 1. Install in a fresh directory

Replace these absolute paths with the selected local artifacts and toolchain.
The SDK directory must contain exactly its seven matching SDK tarballs.

```sh
NODE=/absolute/path/to/node
NPM_CLI=/absolute/path/to/npm/bin/npm-cli.js
SDK_TARBALL_DIR=/absolute/path/to/selected-sdk/tarballs
TYPESCRIPT_TARBALL=/absolute/path/to/typescript-5.9.3.tgz
unset NODE_OPTIONS NODE_PATH
mkdir sdk-walkthrough
cd sdk-walkthrough
printf '{"private":true,"type":"module"}\n' > package.json
"$NODE" "$NPM_CLI" install --offline --ignore-scripts --no-audit --no-fund \
  "$SDK_TARBALL_DIR"/*.tgz "$TYPESCRIPT_TARBALL"
```

### 2. Create explicitly

```sh
"$NODE" --input-type=module <<'JS'
import { resolve } from 'node:path';
import { createOnboardingProject, reviewOnboardingProject } from '@101/connect/examples/onboarding';
const created = await createOnboardingProject({ id: 'room-sensor', destination: resolve('room-sensor') });
console.log(await reviewOnboardingProject({ id: 'room-sensor', directory: created.directory, revision: 'base' }));
JS
cd room-sensor
"$NODE" "$NPM_CLI" install --offline --ignore-scripts --no-audit --no-fund \
  "$SDK_TARBALL_DIR"/*.tgz "$TYPESCRIPT_TARBALL"
```

Creation refuses an existing destination, including an empty directory. Review
checks the fixed source, declarations and manifest; it grants no resource access.
The project remains outside the 101 repository and imports only public SDK APIs.

### 3. Compile and connect

Define these two shell functions once, while inside `room-sensor`. The first
binds unchanged source/manifest bytes to the actual selected compiler and emitted
JavaScript. The second uses those output pins, tries a denied route, then makes
fresh explicit approvals for the exact source `subscribe` and display `write`.

```sh
compile_reviewed() {
  "$NODE" --input-type=module <<'JS' || return
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
writeFileSync('onboarding-build-inputs.json', JSON.stringify({
  sourceSha256: sha('src/processor.ts'), manifestSha256: sha('processor.manifest.json'),
  compilerSha256: sha('node_modules/typescript/bin/tsc'),
}));
JS
  "$NODE" node_modules/typescript/bin/tsc -p tsconfig.json --noUncheckedIndexedAccess true || return
  "$NODE" --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const before = JSON.parse(readFileSync('onboarding-build-inputs.json', 'utf8'));
assert.equal(sha('src/processor.ts'), before.sourceSha256);
assert.equal(sha('processor.manifest.json'), before.manifestSha256);
assert.equal(sha('node_modules/typescript/bin/tsc'), before.compilerSha256);
writeFileSync('onboarding-compiled.json', JSON.stringify({
  sourceSha256: before.sourceSha256, manifestSha256: before.manifestSha256,
  'connector.js': sha('dist/connector.js'), 'processor.js': sha('dist/processor.js'),
}));
JS
}
run_reviewed() {
  "$NODE" --input-type=module - "$1" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runOnboardingExample } from '@101/connect/examples/onboarding';
const revision = process.argv[2];
const options = { id: 'room-sensor', directory: process.cwd(), revision,
  compiledSha256: JSON.parse(readFileSync('onboarding-compiled.json', 'utf8')) };
const denied = await runOnboardingExample({ ...options, mode: 'denied', sample: 31 });
assert.equal(denied.denied, true);
assert.equal(denied.effects, 0);
assert.equal(denied.factoryCalls, 0);
for (const sample of [30, 31]) {
  const result = await runOnboardingExample({ ...options, mode: 'approved', sample });
  assert.equal(result.reading, sample);
  assert.equal(result.switchOn, sample === 31 || revision === 'base');
  assert.deepEqual(result.afterStop, { hasReading: false, released: 1 });
  assert.equal(result.routesClosed, true);
  assert.equal(result.runtimeClosed, true);
  console.log(JSON.stringify(result));
}
JS
}
compile_reviewed && run_reviewed base
```

The supplied hashes express trusted compilation, not authority. Every explicit
run creates new runtime registrations and grants, then stops the route, releases
the display and closes the runtime. A manifest or successful review supplies none
of those approvals. The reported boolean is the local processor's result, not an
appliance acknowledgement or observed physical state.

### 4. Test the generated project

```sh
"$NODE" scripts/validate.mjs
"$NODE" --test test/project.test.mjs
```

These are the generated project's real validator and tests. They check the
source pin, descriptor/recipe parsing, exact host authorization, inert guidance,
local result and Stop release. Invalid or incompatible assets remain rejected.

### 5. Extend one reviewed behavior

First require the unchanged base review. Then choose only the fixed supported
extension: use `temperature > onAt` rather than `temperature >= onAt`, with
processor version `1.0.1` and a new exact source hash.

```sh
"$NODE" --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createDeviceScaffold } from '@101/connect/examples/device-scaffold';
import { reviewOnboardingProject } from '@101/connect/examples/onboarding';
await reviewOnboardingProject({ id: 'room-sensor', directory: process.cwd(), revision: 'base' });
const known = createDeviceScaffold({ id: 'room-sensor' });
assert.equal(known['src/processor.ts'].split('temperature >= onAt').length, 2);
const source = known['src/processor.ts'].replace('temperature >= onAt', 'temperature > onAt');
const manifest = JSON.parse(known['processor.manifest.json']);
manifest.version = '1.0.1';
manifest.codeSha256 = createHash('sha256').update(source).digest('hex');
writeFileSync('src/processor.ts', source);
writeFileSync('processor.manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(await reviewOnboardingProject({ id: 'room-sensor', directory: process.cwd(), revision: 'strict-threshold' }));
JS
compile_reviewed && run_reviewed strict-threshold
```

At 30 Celsius the selected extension returns false; at 31 it returns true.
Other source changes or undeclared revisions do not inherit this review.

### 6. Recover by an explicit known restore

After a source-pin failure, stop and inspect the affected files. For this
exercise, explicitly restore only the factory's known processor and manifest:

```sh
"$NODE" --input-type=module <<'JS'
import { writeFileSync } from 'node:fs';
import { createDeviceScaffold } from '@101/connect/examples/device-scaffold';
import { reviewOnboardingProject } from '@101/connect/examples/onboarding';
const known = createDeviceScaffold({ id: 'room-sensor' });
for (const path of ['src/processor.ts', 'processor.manifest.json']) writeFileSync(path, known[path]);
console.log(await reviewOnboardingProject({ id: 'room-sensor', directory: process.cwd(), revision: 'base' }));
JS
compile_reviewed && run_reviewed base
```

This preserves unknown files. It does not repair other rejected assets, restore
old compiled-output pins or recover permission. Recompilation and fresh explicit
approvals are required; there is no automatic fallback to changed code.

For the checked six-stage walkthrough through ordinary installed packages, run
this tool from the repository root with the immutable manifest, its qualified
clean consumer, trusted compiler tarball and immutable caller tree selected by
the host:

```sh
"$NODE" tools/qa-developer-onboarding.mjs --installed \
  /absolute/path/to/manifest.json /absolute/path/to/clean-consumer \
  "$TYPESCRIPT_TARBALL" IMMUTABLE_CALLER_TREE
```

The tool checks the installed SDK bytes, compilation ancestry, denial,
extension, explicit restore and actual owned-child
Stop/close. Its direct child reservation is not a process-tree sandbox or a
physical safe-state claim.

The [support catalog](support-catalog.json) is schema version 1, revision 30,
with 65 rows and zero accepted rows. This local software exercise accepts none
of them: a release claim requires `status: "qualified"`, `accepted: true` and
the exact target's required current evidence. See the existing support/version
reference for engine-floor, platform and hardware qualification limits.

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

## Public TypeScript contract

Use `@101/connect` for the general facade, or the documented package-root exports
of its model, runtime, browser and transport packages. Import public types from the
same roots. Do not import source paths, compiled implementation files, registries,
queues or lease helpers. Installed export maps and declarations define the packaged
surface; a workspace source alias does not establish an installed contract.

### Contract families

| Public contract | Lifecycle and outcome boundary | Detailed reference |
| --- | --- | --- |
| Descriptors, values, profiles, recipes and codecs | Parsers/codecs validate bounded data; compatibility and resolution describe possibilities. Descriptions, labels, recipes and extensions do not grant access or choose executable code. | [Descriptions](#descriptions-and-signal-meaning), [recipes](#declarative-recipe-v1), [profiles](#connector-and-device-profile-manifests), [revisions](#descriptor-revisions-and-extensions) |
| `DeviceRuntime`, `Connection`, `DeliveryContext` | The trusted host registers concrete providers, authorizes each exact source/sink operation and owns `flush()`. Admission, route authority, handler return, effect evidence and settlement are separate outcomes. | [Scheduling](#publication-and-scheduling), [ownership](#ownership-cleanup-and-async-providers), [operations](#property-command-and-job-operations) |
| Recipe, group, handoff, processor and ownership controllers | Each controller's declared phases, results and retained generation govern that operation; controller consent does not replace concrete runtime grants. | [Groups](#route-group-contracts), [handoff](#workload-handoff), [processor failure](#processor-failure-and-restart-propagation), [input ownership](#application-input-ownership) |
| Storage, settings, installation, catalog and recording controllers | Use each exported result union and its transaction/retention contract. Stored history and selections are inert; CAS, deletion floors and fresh approvals remain authoritative. | [Settings](#versioned-owner-settings), [managed data](#managed-owner-data), [installation](#reviewed-local-extension-installation), [recording](#opt-in-application-recording), [backup](#local-managed-owner-backup-and-reviewed-recovery) |
| Browser capture, media and output providers | Selection, capture consent and output consent have their own exact current handles. Route grants are independent. Owned versus borrowed native resources, issued work and async close limits belong to the selected provider profile. | [Selection](#permissioned-browser-selection), [camera](#selected-browser-camera-raster), [audio](#private-application-audio), [HID/Serial output](#selected-hid-and-serial-switch-output), [BLE output](#selected-ble-switch-output) |
| Peer transports, authentication and remote resources | Transport connection/sender admission is not authenticated enrollment, resource approval, receiver delivery or effect. Generation, transcript, mapping and owner grants are separate. | [Remote binding](#bind-a-remote-provider), [WSS](#secure-websocket-fallback), [invitation connection](#explicit-connection-to-an-enrolled-receiver) |

`EmbeddedRuntime` remains an exported constructor implementing `DeviceRuntime`;
existing public callers may construct it. General consumers should use
`createDeviceRuntime()` and the `DeviceRuntime`/`Connection` contracts. Its registry,
lease and dispatch helper members are implementation plumbing rather than resource
operations. Their signatures are experimental implementation helpers outside the
stabilized `DeviceRuntime` contract; compatible constructor use remains supported.
Do not call those helpers to bypass the declared host/route lifecycle.

### Results and exceptions

The core runtime's `Result<T>` is `{ ok: true, value: T }` or
`{ ok: false, reason: string }`. Successful void operations carry
`value: undefined`. Inspect `ok` before reading `value`; a failed result contains
no usable value or new authority. Core reasons such as `denied`, `busy`, `stale`,
`expired` and `unknown-endpoint` are diagnostics for the attempted operation, not
permission to retry, renew, reconnect or substitute a resource automatically.
The string type is open: retain a safe fallback for an unfamiliar reason.

Other APIs use their own exported result unions: for example `SettingsResult` adds
a success status, and `OwnerDataResult`/`OwnerBackupResult` have profile-specific
failure unions. Do not replace those types with a universal core `Result` or assume
that every asynchronous API resolves a result. `readVerifiedResource()` returns
bytes or rejects; `ResourceTransferError.code` identifies its transfer failure.
Model validation can throw `DeviceValidationError` with `code` and `path`.
Runtime constructors/registration may throw for malformed descriptors or unsupported
operations; invalid integer capacities throw `RangeError`, invalid callbacks or
configuration can throw `TypeError`, and registration after runtime close throws.
Catch exceptions at those declared boundaries. Error message text is diagnostic
copy, not a versioned wire protocol or identity claim.

### Core route lifecycle

| Method/state | Meaning |
| --- | --- |
| `route()` / `idle` | Creates an inert connection; validates local capacity options but does not authorize, activate or deliver. Registration handles are identity-bound objects, not copied IDs. |
| `prepare()` / `prepared` | Obtains current host approval and reserves the owner lease without dispatch or a provider release. `activate()` rechecks approval/currentness before becoming active. |
| `start()` / `active` | From idle, authorizes and activates; from prepared, delegates to activation. A refused idle start leaves that connection idle with its diagnostic reason, so an explicit later attempt is possible. Failed prepared activation retires it. |
| `stop()`, revoke, expiry, unregister or runtime close / `closed` | Terminal authority loss; queues/leases retire and current delivery signals abort before `onClose` and the active provider's one synchronous `release` call. A prepared or never-active route has no issued output to release. Closed routes cannot restart or renew; recovery needs a new route and current grants. |

`publish()` success means local admission/snapshot acceptance, with accepted and
rejected route counts. A latest property can be retained with zero routes; success
is never proof of provider dispatch or effect. `flush()` returns void and owns no
background tick. `limits()` is present only for an active, current route;
`status().pending` counts queued latest/reliable work, not all returned async work.
Runtime close, unregister and expiry retire affected prepared/active routes.
An idle handle has no issued work and is not in those active/prepared sets;
explicitly stop idle handles before awaiting their settlement.

`onClose` announces terminal route loss and returns an unsubscribe function. It is
not a native cleanup receipt. Throwing close/release observers cannot reopen authority;
ignored observer/cleanup exceptions do not establish successful physical cleanup.

### Returned work, effect evidence and settlement

`DeliveryContext.isCurrent()` and its abort signal fence a delivery; check again
immediately before effects after every await. Operation history records handler state
(`not-started`, `running`, `returned`, `failed`) independently of effect evidence
(`none`, `dispatched`, `target-acknowledged`, `observed`). Successful callback return
supplies `unverified`, not a physical observation. A trusted provider's report supplies
only the evidence it actually has. Stronger late ACK/observation may update historical
records after retirement; it never restores route authority or retries an operation.
A cancelled/expired callback can remain running, and its actual Promise retains the
runtime workload reservation until it fulfills or rejects.

`Connection.whenSettled?()` is an optional capability. When present on an embedded
route or its inspector facade, repeated calls return the same Promise. It fulfills
only after terminal retirement, synchronous close/release callouts and all that
route's runtime-reserved `apply` returns have settled, including reserved frozen
flush work. Observing it neither stops nor renews the route. Calling it while idle,
prepared or active waits for retirement; hung returned work keeps it pending.
Provider rejection updates ordinary history and still permits the barrier to fulfill;
fulfillment is a settlement result, not an operation-success result.

```ts
const whenSettled = route.whenSettled;
route.stop('owner-stop');
if (!whenSettled) throw new Error('Connection settlement is unavailable');
await whenSettled.call(route);
// Now dispose only resources whose lifetime is represented by those apply returns.
```

If the capability is absent, retain the host's own provider-work tracking; neither
`pending: 0` nor `onClose` is a substitute. The barrier does not await detached native
work, an asynchronous value returned from the synchronous `release(): void` callback,
process/socket shutdown, borrowed producer lifetime or physical cancellation.
Those need the provider's explicit teardown contract and actual host observation.

A Promise return type alone is not a universal quiescence guarantee.
`OwnerBackupController.close()` and `MediaRecording.close()` wait for their actual
owned tracked work, while `ProcessorInstallation.close()` and haptic close retire
synchronously. WebRTC/WSS `disconnect(): Promise<void>` retires the generation and
requests native port closure; it does not observe browser-internal or raw socket
quiescence. Preserve each API's documented ownership and failure boundary.

The [public names and compatibility policy](RELEASE-CONTRACT.md#public-names-and-compatibility)
separates package version, schema/profile/codec revision and negotiated wire revision.
Optional capabilities need presence checks; unknown revisions or undeclared semantics
fail closed. Experimental 0.x changes require a documented migration preserving
accepted consumers; 1.0 deprecation and security-revocation rules are in that policy.
Namespaced extension data remains inert and cannot select executable factories,
fetch URLs, revive grants or infer native support. This reference specifies software
contracts; it does not promote hardware, full-platform or physical qualification.

### Find a public schema or protocol

The local general SDK contains seven package roots: `@101/device-model`,
`@101/device-runtime`, `@101/transport-webrtc`, `@101/transport-websocket`,
`@101/device-web`, `@101/vision` and the `@101/connect` facade. Use an artifact's
export map and declarations for its exact public surface. Package version,
descriptor revision, capability schema version, profile/codec revision and wire
version identify different contracts; none supplies resource authority.

| Contract | Exact public reference | Boundary |
| --- | --- | --- |
| Device description | `DeviceDescriptor`, `DeviceCapability`, `ValueSchema`, `parseDeviceDescriptor`, `parseValueSchema` and `parseSignalValue`, from model or facade roots | Descriptor envelope `schemaVersion: 1`; each capability has its own positive schema version. Spatial and rich-input schemas require capability version at least 2. Rich input also requires event kind and reliable delivery. [Value contracts](#descriptions-and-signal-meaning). |
| Editor JSON schema | `@101/device-model/schema/device-descriptor.json` or `@101/connect/schema/device-descriptor.json`; Draft-07, `$id: urn:101:device-descriptor:1` | Structural editing aid. Runtime parsers additionally enforce finite values, relational/byte/depth limits and safe immutable snapshots. [Parser limits](#local-device-simulator). |
| Recipes and processors | `Recipe`/`parseRecipe` and `ProcessorManifest`/`parseProcessorManifest`, from model or facade roots; both manifest envelopes have `schemaVersion: 1` | Inert declarations need explicit resource resolution and trusted pinned code. A recipe or manifest grants no access. [Recipes](#declarative-recipe-v1), [processors](#processor-manifests-and-trusted-registry). |
| Runtime routes | `DeviceRuntime`, `Connection`, `AuthorizationRequest`, `RouteGrant` and `DeliveryContext`, from runtime or facade roots | Concrete registration identity, host grants, generation and currentness govern delivery. [Public lifecycle](#core-route-lifecycle), [operations](#property-command-and-job-operations). |
| Resource wire values | `WireControl`, `WireValue`, `WirePacket`, `WireCodec`, `encodePacket` and `decodePacket`, from browser or facade roots | `protocol: 'connect'`; control messages use version 1. Values use version 1 with `json/1`, or version 2 with negotiated `json/2`. The binder separately validates the selected resource, schema, codec, slot, epoch and authority. [Remote binding](#bind-a-remote-provider). |
| Compact pointer codec | `normalized-pointer/1` in `WireCodec` | Exactly 48 bytes, disposable sample lane, version 1; only the binder's compatible normalized two-coordinate pointer schema. No generic vector or physical pointer claim. [Pointer codec](#native-normalized-pointer-codecs). |
| Receiver invitation | `ReceiverInvitation`, `decodeReceiverInvitation` and related public invitation helpers | `protocol: 'connect-invite'`, version 1; current receiver application/session/epoch data. Possession or parsing grants neither endpoint identity nor resource consent. [Receiver connection](#explicit-connection-to-an-enrolled-receiver). |
| Manual diagnostic code | `ManualPeerCode`, `encodeManualPeerCode`, `decodeManualPeerCode` | `protocol: 'connect-manual'`, version 1; diagnostic offer/answer transfer. It does not authenticate an endpoint. [Remote binding](#bind-a-remote-provider). |
| Endpoint authentication | `AuthenticatedResourcePeer`, `AuthenticatedPeerOptions`, `AuthenticatedPeerScope`, `EndpointIdentity`, `EndpointCrypto` | Library-owned `connect-auth` version 1 handshake binds the actual transport transcript and locally expected scope. Endpoint proof, bilateral enrollment and owner grants remain separate. [Authentication](#bind-a-remote-provider). |
| Secure WebSocket transport | `SecureWebSocketTransport`, `WebSocketSessionBinding`, `WebSocketLimits`, `WSS_SUBPROTOCOL` | Subprotocol `101-resource-wss-1`; library-owned `connect-wss` version 1 handshake negotiates `ordered-bounded/1`. A supplied server port does not prove TLS. [WSS contract](#secure-websocket-fallback). |

`encodePacket()` validates and snapshots its input, returning a JSON string or
compact `ArrayBuffer`; malformed input throws. `decodePacket()` returns
`{ packet, codec }` or `undefined`, including for a malformed packet or wrong lane.
Samples use the disposable lane; controls and events use the reliable lane.
Wire value/control packets are bounded to 4 KiB, except the description envelope
which is bounded to 66 KiB. The runtime observation/options envelope has its own
independent 4 KiB bound; source and provenance fields consume that budget.
Successful decoding alone supplies no negotiated schema, grant, delivery or effect.
Use the binding and authentication APIs rather than implementing a new handshake
from this lookup table.

Additional resource/profile declarations and exported limits are documented in
the [contract-family references](#contract-families). Their individual exported
types and parsers remain authoritative; the descriptor editor schema is not a
universal validator for recipes, storage, extension packages or peer packets.

The selected local artifact additionally exports the Node-only
`@101/connect/examples/device-scaffold` factory (JavaScript, declarations and
source) and the ordinary MJS `@101/connect/examples/onboarding` entry. The latter
retains its same-directory consumer module. See the [six-stage walkthrough](#install-create-connect-test-extend-and-recover)
and [onboarding evidence](receipts/2026-10-07-developer-onboarding.json) for the exact
artifact and tested local toolchain. These are explicit local examples, with no
registry publication or platform acceptance implied.

### Resource operations and consent

| Operation in `AuthorizationRequest` | Resource contract | Consent boundary |
| --- | --- | --- |
| Source `read` | A latest `property` source advertising `read`; one fresh retained snapshot, then terminal retirement | Authorize the exact source registration and the selected sink operation. Missing or stale snapshots are refused. |
| Source `subscribe` | A source advertising `subscribe`; continuing publications under its declared delivery policy | Approve the exact resource, principal, application, session, rate/age and expiry. |
| Sink `write` | A compatible sink other than a command/job, advertising `write` | The sink's owner and host approve this registration; source permission does not imply destination permission. |
| Sink `invoke` | A compatible command/job sink advertising `invoke` | Reliable operation IDs/deadlines and current authority remain required; callback return is not target acknowledgment or observed effect. |

The runtime selects `invoke` for command/job sinks and `write` for other sinks;
an advertised operation is a capability declaration, not a grant. An omitted
source operation selects `subscribe` when advertised, otherwise `read`.
Host authorization may refuse either choice. Caller constraints only narrow
the host grant. Partition selection must match the sink's declared ownership.
Browser/OS permission, endpoint enrollment, resource-owner approval and runtime
authorization have separate lifetimes. Labels, descriptor IDs, membership,
invitation possession and encrypted transport replace none of them. See
[roles and permissions](RELEASE-CONTRACT.md#roles-and-permissions).

### Interpret support and versions

The canonical matrix is [support-catalog.json](support-catalog.json), schema
version 1, currently revision 30 with 65 rows and zero accepted rows. A row is a
release claim only when `status: 'qualified'` and `accepted: true`, with its exact
target and required current evidence. Implementation, contract, runtime and
physical evidence are independent. `embedded`, `candidate` and `historical`
describe their recorded scopes; an unknown target inherits no evidence.

[Current local SDK evidence](receipts/2026-10-07-sdk-content-audit.json) identifies
the concrete unpublished artifact and separately bounded consumer checks. A
successful local tarball build or example does not accept a support row. Node
22.13 is the declared engine floor; its qualification remains open. Use the
actual runtime/compiler versions in the selected receipt for tested claims.
Phone, hardware, native OS input and broader platform acceptance remain separate.
The [compatibility policy](RELEASE-CONTRACT.md#public-names-and-compatibility)
defines negotiated additions, 0.x migration, stable deprecation and security
revocation. Unknown revisions or undeclared semantics fail closed.

### Troubleshoot a failed attempt

These are diagnostic checks, not automatic retries or an onboarding sequence.
Core result reasons are open strings; other APIs have their own exported result
unions and exception boundaries. Keep a safe fallback for an unfamiliar reason.

| Symptom | Inspect | Required boundary |
| --- | --- | --- |
| Missing export or incompatible declarations | Exact artifact export map, matching package versions, declaration entry and configured `ES2022`/`DOM`/`DOM.Iterable` libraries | Workspace source resolution and private implementation imports do not establish a packaged public export. Match example availability to the exact artifact export map. |
| Descriptor/value rejection | `DeviceValidationError.code` and `path`, schema/capability revision, delivery kind and declared bounds | Correct the declaration or explicit migration; do not clamp values, strip fields to bypass validation or reinterpret a rich event as a latest sample. |
| `decodePacket()` returns `undefined` | Input lane, codec, version and bounded packet shape | Invalid bytes remain rejected. Decoding is not authentication or permission. |
| Description/binding remains unavailable | Current issued authenticated facade, expected application/session/roles/epoch and bilateral enrollment | Transport connection, a code or a copied scope object is insufficient; no diagnostic exemption supplies production authority. |
| `denied`, `busy`, `unavailable` or `unknown-endpoint` | Current endpoint handle/readiness, host decision, owner lease and registration lifetime | Do not substitute IDs or seize an incumbent lease. Authority and current provider availability must be established explicitly. |
| `incompatible` or `unsupported-operation` | Exact semantic/schema/value/delivery compatibility and advertised source/sink operations | Use an explicitly declared compatible provider or reviewed converter; a grant cannot make incompatible contracts compatible. |
| `payload-limit`, `capacity` or sender admission failure | Independent wire/runtime envelope sizes, provenance, effective route limits and outstanding provider work | Stay within negotiated bounds. Admission failure is not effect; do not repeat ambiguous non-idempotent operations. |
| `stale`, `expired`, invalid deadline or closed route | Original clock domain, age/deadline, owner expiry and terminal route status | Retired authority stays retired. Never extend a source timestamp, replay expired edges or renew a closed handle. |
| Callback returned but effect is unclear | Separate operation handler state and evidence (`dispatched`, `target-acknowledged`, `observed`) | Return or transport send success cannot establish a physical effect; ambiguity must remain visible. |
| Stop happened but owned work is pending | Actual returned provider work and the selected API's settlement/teardown contract | `pending: 0` or `onClose` is not quiescence. Optional `whenSettled()` does not await detached native work. [Settlement limits](#returned-work-effect-evidence-and-settlement). |

### Security reports and safe diagnostics

Follow the repository [security policy](../../SECURITY.md). It requests private
reports to maintainers and has no stable security-support window. It currently
provides no verified private reporting destination. A usable private contact
must be established by the owner before the security-reporting part of L02 can
be accepted; this reference supplies no invented mailbox, service or response SLA.

Prepare an affected package/version, artifact/source identity, failing phase,
bounded error code and minimal reproduction using disposable values. Exclude
tokens, private keys, device data/labels, recordings, live pairing payloads and
raw sample values. Do not post sensitive reports as public issues. The policy
permits public issues for non-sensitive hardening ideas and ordinary bugs.
The whole L02 deliverable remains open pending the verified reporting path and
review against the exact accepted release artifacts and support scope.


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

The complete [remote pointer surface](../../examples/device-pipelines/remote-pointer.ts) supplies both typed profiles, explicit owner selection, scoped host authorization, geometry and release. Run `node tools/qa-authenticated-peer.mjs chromium` for two browser pages with separate persisted identities, bilateral comparison and typed pointer routes. `qa-resource-peer.mjs` retains its explicit raw diagnostic scope. Values are generated by both harnesses; neither is a phone touch or OS pointer test. Local compiled ESM tarballs now support an external consumer of the current general SDK; broader platform qualification remains open.

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

## Adaptive encoded application video

`createBrowserApplicationVideoCodec` binds one caller-owned application canvas
to two independently approved private outputs. The packaged
`@101/connect/examples/application-video-codec` caller provides explicit source
and sink consent. Sampling is caller-driven; no camera or screen is acquired.

The controller probes the offered VP8/VP9 encoder and decoder configurations
before acquiring codecs. Missing APIs or a common configuration return
`unsupported`. Both owners approve the exact source, recipient, application,
session, codec and format tiers. Runtime subscription/write grants remain
separate. Revocation retires the real route and removes only its owned output.

Pressure moves an output from 320×180 at requested 20 Hz/384,000 bit/s to 160×90
at requested 10 Hz/128,000 bit/s; successful delivery can recover the approved
upper tier. These are requested configurations, not measured achieved bitrate.
Every admitted frame is an independent keyframe. A slow output keeps one waiting
frame and cannot occupy the other output's queue. Generation/currentness checks
discard stale native results before copying them to the visible canvas.

The selected profile limits eight binding attempts, thirty-two support probes,
512 capture attempts, 256 encodes, eight adaptations per output, 64 KiB combined
chunk/description bytes, 4 KiB descriptions, 128 KiB/s copied bytes per output
and 4 MiB total copied bytes per controller. Opening has a two-second deadline
and bindings last at most thirty seconds. Close retains issued API reservations
until support probes and native flush promises actually settle; it does not
claim browser-internal memory or worker quiescence.

Run `node tools/qa-application-video-codec.mjs --sdk-root <clean-consumer>` for
strict installed public declarations and actual owned Chromium/Firefox/WebKit
encode/decode, private pixels, adaptation, controlled chunk loss and teardown.
The selected actual codec is VP8. VP9 effect qualification, a dedicated expiry
fixture, interframe streaming, transported video, synchronization, hardware and
the full V06 matrix remain open.

## Output sharing policies

`createOutputSharingController` reviews destination-owner policies and separate
source/sink resource grants. `createBrowserOutputSharing` applies the accepted
policy to private audio and owned raster outputs. Two slots per destination
support mix, duck or exclusive audio, read-only camera observers, ordered app
layers and disjoint left/right app regions. Failed review preserves the incumbent;
accepted transfer retires old routes before fresh admission.

The profile bounds eight sources, four destinations, eight routes, 64 attempts,
32 policy changes, 128 effects and two actual pending reservations. Leases last
at most one second inside a thirty-second controller lifetime; no permission
is renewed automatically. Audio grants, selected camera ownership and original
application-view contexts remain independent. Expiry, revoke and callback races
are checked after upstream access, and close awaits issued work.

The packaged `@101/connect/examples/output-sharing` caller uses approved private
software oscillators, one canvas camera source and one application engine.
Native half-alpha raster readback allows the observed one-byte quantization;
source capture/PCM/scanout clocks remain unknown or unmapped. Run
`node tools/qa-output-sharing.mjs --sdk-root INSTALLED_CONSUMER` for the selected
profile. [Current software evidence](receipts/2026-10-06-output-sharing.json);
hardware, physical capture/control and transported media remain separate.

## Software media synchronization

`createMediaSynchronizationController` compares independently approved audio
and video observation routes in one declared display software clock. Return
`offer()` directly from each real sink's `apply` so its delivery context stays
retained until pairing, discard or actual effect settlement. The packaged
`@101/connect/examples/media-synchronization` caller renders private PCM and
raster observations without acquiring a user microphone, camera or speaker.

The selected profile declares a 20 ms conservative skew budget and 5 ms clock
uncertainty budget. Missing, unmapped, stale or excessive observations degrade
the visible owned output; recovery needs fresh maps and three fresh pairs.
Native capture time, caller video PTS and physical display scanout remain
unknown. Source labels do not authenticate clocks. One actual effect and two
live delivery contexts remain reserved through the returned Promise, including
after logical cancellation. Stop with an intercepted already-issued held RAF
callback remains unqualified. [Local evidence](receipts/2026-10-06-media-synchronization.json).

## Opt-in application recording

`createMediaRecording` stores selected raw 8×8 RGBA frames through an explicitly
provided owner-data store. Live routing does not record automatically. Capture,
playback, owner review, export and deletion require separate exact owner grants;
opaque capture/playback handles and grants are never restored from storage.
The packaged `@101/connect/examples/media-recording` caller uses its own canvas
and local IndexedDB, with separate live source/sink authorization.

The selected profile bounds four clips, 32 frames per clip, four pending frames
and four frames per export page. Original source clock, sequence, quality and
decoded media position remain distinct from host playback emission. Seek epochs
and deletion epochs fence stale work. Retention and consent expiry retire output;
raw storage operations remain reserved until actual settlement. Reviewed export
returns copies: deletion cannot recall copies retained by the caller. Audio,
encoded media, remote copies and physical acquisition remain separate profiles.
[Local evidence](receipts/2026-10-06-media-recording.json).

## Managed recording retention and deletion

`createRecordingOwnerData` binds `createMediaRecording` to an explicitly supplied `OwnerDataStorage`, owner signal and trusted clock. `openRecording` requires owner approval; capture/playback still need separate `authorizeRecording` decisions. Supply `retireOwned()` to stop your routes and clear private outputs when the managed port retires. Await both port/controller `close()` before disposing storage; already issued storage and producer work stay reserved until actual settlement.

`exportPage` returns a closed public projection of verified RGBA frame bytes, SHA-256 references, source clock, sequence and quality. `storeRegisteredExport` accepts only the exact current page issued by that controller, with separate reviewed purpose/destination consent. Registered copies keep the original ingestion expiry; a later approval or clock change cannot extend it, including at the final storage guard. Caller-retained, transmitted or unmanaged copies cannot be recalled.

`beginDeletion` persists a pending operation and advances the epoch before deleting selected clips and registered local copies. After restart, `inspectDeletion` exposes progress and `resumeDeletionReviewed` requires fresh approval for each bounded stage. No capture, playback, export or route authority is restored. Completed status follows retained-state verification. `sweep()` removes expired clips/copies and expired audit entries when explicitly invoked.

The selected profile bounds one producer port/mutator, eight issued storage operations, four frames/8 KiB per export page, 64 registered copy frames/64 KiB and 128 audit rows/64 KiB. Audit rows retain only operation/action/state/time/removal counts for 30 days; required audit capacity is checked before deletion, without early eviction. The unchanged recording producer does not cryptographically verify expired original frame bytes during deletion; exported frames and registered copies are verified.

The packaged `@101/connect/examples/recording-owner-data` caller supplies its own canvas and actual IndexedDB. This is a selected owner-local RGBA profile. Legacy/native/unmanaged stores, remote-copy deletion, other media formats and physical device qualification remain separate.

## Private application audio

`createBrowserApplicationAudio` and `BROWSER_APPLICATION_AUDIO_LIMITS` are public
exports of `@101/connect` and `@101/device-web`. Supply an existing runtime,
application/session IDs, monotonic `now`, owner signal and separate
`authorizeSource`/`authorizeOutput` callbacks. Register a borrowed, same-realm
`MediaStreamAudioDestinationNode` and its exact stream with
`registerSource({ sourceId, ownerPrincipalId, producerNode, stream })`.
The selected native graph requires an observed 48 kHz context, two-channel
destination node and one live audio track. Contradictory track settings reject;
missing emitted PCM metadata remains unknown.

Each `bind({ source, outputId, ownerPrincipalId, purpose, signal })` requires
both current owner decisions, returning `{ request, signal, grant }` for the
exact issued request, plus independent runtime subscribe/write authorization.
After `ready` succeeds, `output()` exposes only that recipient's private stream.
`setMuted` and `setVolume` affect that output independently. Output revocation
retires one recipient; source revocation retires all. Diagnostics require a
separate resource route and measure analyser retrieval, not capture time.

The adapter bounds one source, two recipients, one raw routing-context lifecycle,
64 attempts and a 30-second lifetime. Await `close()` to settle owned native
cleanup. Borrowed producer tracks/context remain the application's responsibility.
The [ordinary application caller](../../examples/browser-resources/application-audio.ts)
demonstrates the grants, private native graphs and cleanup. Its owned browser
fixture connects no speakers and acquires no devices; hardware output, encoded
audio and network routing retain their separate qualification.

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
Git tree, packs and installs both it and the seven SDK packages offline, then
verifies the installed code bytes against the manifest pin. The consumer uses
the public registry, graph validator, failure controller and two host-granted
routes to drive a simulated relay. The graph declares `subscribe` and `invoke`;
the host grants only the two exact source/sink operations for its owner. An
altered code artifact, incompatible output schema, invalid configuration and
an unapproved principal fail; input revocation cancels a queued command.

This is an independent local Node consumer and package-integrity example.
Third-party publisher identity, isolated execution, physical devices and
cross-target performance remain separate qualification work.

## Five independent reference applications

`node tools/generate-sdk-reference-apps.mjs IMMUTABLE_MANIFEST CLEAN_CONSUMER`
generates five complete projects in a fresh owned temporary directory. Each
contains readable instructions, TypeScript source, strictly compiled ES2022
output, the exact seven installed SDK packages, a closed asset inventory and a
Node loopback launcher. No install, remote service, game engine or monorepo
runtime import is required. Run `node serve.mjs` inside the selected project;
stop its launcher explicitly when finished.

The pointer application accepts native pad/key input and moves its own cursor.
The sensor dashboard charts the actual lateness of its browser timer. The
appliance remote invokes an authored software lamp and separately observes its
state. Media sharing captures and decodes the application's own drawing, with
truthful unavailable-format recovery. Collaborative controls use two local
producers with independently approved partitions and explicit request, decline,
cancel and transfer. These software producers establish no physical sensor,
appliance, user-camera, remote-person identity or OS cursor qualification.

Source and destination approval are separate; each activation lasts at most
thirty seconds. Stop, expiry, withdrawal, hide, blur and teardown retire owned
input/routes/native output, and retry requires fresh approvals. A held provider
Promise retains its reservation through actual settlement. Ordinary application
delivery uses one reliable queue entry; collaborative ownership routes allow
four. The generated instructions report these limits per profile. Pointer key
release after focus traversal and captured pointer release outside a button have
actual browser regressions. Strict manual capture-loss delivery within 100 ms
remains unqualified; the broader release-safety and UI matrices remain open.

Run `node tools/qa-sdk-reference-apps.mjs --installed IMMUTABLE_MANIFEST
CLEAN_CONSUMER` for fresh generated external projects and owned Chromium/WebKit
journeys. Append `--application pointer` or `--application collaborative-controls`
for the affected journeys. The check verifies immutable SDK inputs, ordinary
public ESM resolution, generated file bytes, explicit software/native-media
provenance and final owned-context cleanup.

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

## Microphone and linear-motion impulse fusion

`measurePcmImpulse()` and `createImpulseFusionProcessor()` are synchronous public
APIs through `@101/device-model` and `@101/connect`, profile
`microphone-linear-motion-impulse/1`. They produce a **coincident impulse candidate**;
physical table-tap accuracy and human false-activation rates remain unqualified.

The extractor accepts ordinary dense numeric arrays or ordinary same-realm
`Float32Array` PCM from a caller-owned source. At most 1024 finite samples within
±1, sample rate 8000–96000 Hz, and a window no longer than 50 ms are accepted.
Shared buffers, sparse/accessor arrays, nonfinite/oversized data and extra fields
fail closed. It returns dimensionless full-scale peak/RMS, window length and the
original timing without retaining or exporting PCM. These features are neither
sound pressure nor acoustic calibration. Capture time denotes **window end**;
the processor conservatively includes the entire window in timing comparisons.

The fusion configuration fixes independently selected audio/motion source IDs,
epochs, positive producer calibration revisions, processing clock and explicit
high/low thresholds. Motion requires valid gravity-removed `m/s2` measurements;
zero-filled/missing sensors, unverified calibration, changed bindings and source
loss cannot establish a candidate. Names and declared calibration are evidence
supplied by trusted callers; the processor supplies no source authentication or
microphone/motion permission. Ordinary current source and destination grants
remain required at SDK ingress and delivery.

Both sources must first supply low baselines, then fresh rising impulses within
the configured 1–100 ms coincidence window. At most two timing envelopes are
retained. Sustained signals cannot repeat; both sources must rearm after a
candidate, and impulses during the explicit refractory period are consumed.
Capture mappings preserve each source clock; the worst-case full capture span,
maximum age and uncertainty decide admission. Output preserves both complete
timing lineages and a separate processing stamp rather than inventing a fused
capture clock. Stale/unavailable/wrong-source/unsupported-unit/uncertain data
return an unavailable result and erase pending evidence. Malformed and reversed
input throws and resets; a processing gap disarms both sources. `reset()` is
required on input loss, revocation, stop or reconfiguration. Reset/rejection
clears pending and rearming evidence while retaining same-generation capture,
processing-clock and refractory floors; it cannot make consumed input fresh.
New epochs require a new processor.

The [independent caller](../../examples/impulse-fusion/consumer.mjs) labels its
synthetic inputs explicitly, covers positive/negative coincidence labels and
routes granted feature producers into one actual application event sink.
`tools/qa-impulse-fusion.mjs --sdk-root <installed-consumer> --sdk-manifest <manifest>`
verifies ordinary compiled public imports and exact installed/source hashes.
Neither the API nor that caller opens capture permissions, records audio,
certifies tap recognition, or establishes hardware latency, energy or thermal
performance. Opted-in capture/sharing and physical evaluation remain separate.

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

## Independent local workload hosts

The [cross-host workload caller](../../examples/cross-host-workload/cross-host-workload.ts)
uses the public handoff and route-group APIs with independently running Node
hosts. Its fixed `loopback-node-workload-handoff/1` profile sends approved typed
cursor input to an owned native raster application and shares its 4×4 RGBA
frames with separately approved outputs. Each host owns its identity, grants,
clock domain and routes. Host control uses private, bounded IPC; the loopback
relay is a trusted plaintext gateway, not an end-to-end encrypted channel.

`runCrossHostWorkloadQualification({ signal })` runs three bounded scenarios:
live transfer with source retirement, incompatible snapshot recovery, and host
loss followed by a new identity and fresh consent. It records confirmed native
state, distinct host PIDs, recovery durations and actual cleanup. Pending native
work remains reserved until its callback or process actually settles. The
caller accepts only the fixed reviewed workload, with at most two host
processes concurrently and 15 seconds per scenario, 45 seconds in aggregate.

Run the source caller with Node 24.14.0:

```sh
node tools/qa-cross-host-workload.mjs --source
```

To use the seven ordinarily installed SDK packages, pass the immutable local
consumer directory produced by `tools/qa-sdk-consumer.mjs`:

```sh
node tools/qa-cross-host-workload.mjs --sdk-root /tmp/101-sdk-consumer-EXAMPLE
```

The host-loss scenario includes 650 ms of unrelated target preparation. During
that work the current source supplies fresh native frames at nominal 150 ms
intervals under its original grants and frame/IPC quotas. Cached frames are not
restamped, expired routes are not reopened, and the receiver silence policy
stays unchanged.

The coordinator remains the explicit workspace `@101/hub-server` provider.
These checks qualify local software hosts; they do not establish physical
machine, IP interruption, clock mapping or performance service-level claims.

On unexpected failure, the workload error retains bounded `startupDiagnostics` after the real cleanup waits. It reports parent-clock spawn, hello and close times; at most three fixed child-clock module-body, identity-ready and hello-sent milestones; and process/callback/socket/timer/fixture cleanup counts. Raw stderr, identities, credentials, paths and grants are omitted. Child module-body entry occurs after static ESM imports, and child and parent times belong to separate clock domains. The hosted/private-IPC regression tests likewise report actual startup result/status, original approval expiry and sanitized probe error codes only on failure. [Scoped diagnostic evidence](receipts/2026-10-08-native-startup-diagnostics.json) preserves the genuine missing-diagnostic OLD, corrected forced-child cleanup check and original five-case selector. Their passing results verify instrumentation; the historical full-suite failures and their cause remain unresolved.

## Owned native raster application

`createHostedApplication()` from the workspace `@101/hub-server` export starts
the fixed reviewed `owned-node-raster-application/1` program in a separate Node
24.14.0 child. The child owns a 4×4 cursor state and renders 64 raw RGBA8 bytes.
Descriptions are inert: no caller-selected executable, path, code or application
is accepted. Launch approval binds the owner, provider, application, session,
code digest and native epoch. A private 0700 directory, 0600 socket, inherited
random capability, one-use permits and authenticated replies bind operations to
that child. This is a cooperative same-user boundary, not an OS sandbox or
account identity service.

Construction and declined launch create no child. Successful `start` returns
an opaque epoch with a paused child; the current workload handoff authority and
a separate resume approval activate it. `input` accepts only integer cursor
coordinates 0–3, a current SDK invoke delivery and an independent native input
approval. Its acknowledgment identifies the confirmed state revision. `frame`
requires separate read approval. An independent `ApplicationViews` output grant
is required to expose those pixels. `currentFrame` performs no new read or
render and returns only an already approved current frame. Revocation clears
that retained frame; retry requires fresh authority.

`handoffHost()` stages validated cursor state while paused. Transfer waits for
the old child's actual settlement before target resume; the target needs fresh
input, frame and output approvals. Missing captured state cannot silently
recover by launching default state. Restoring a captured snapshot requires
explicit launch/stage approval. Issued input that loses acknowledgment during
cancellation is marked uncertain; cancellation does not claim to undo effects.

Child `sourceTime` is render/emission time, with the original child PID and
native epoch in its clock identity. Host `receivedAt` and `receiptClockId` are
separate. The view's projection clock stays separate too.
`hostedApplicationRequirements(providerId, { sourceClockId, receiptClockId })`
provides a frame schema only after selecting the exact observed clock identities;
it authenticates neither identity and establishes no clock mapping. The 250 ms
receipt-age limit cannot be refreshed by projecting the same frame again.

Each owner admits one unresolved native operation, three starts, sixty-four
attempts and thirty-two operations. A child accepts two clients, 4 KiB per frame,
64 KiB lifetime traffic and sixty-four chunks. Native requests have a 2.5-second
deadline and children a ten-second lifetime. Stop fences authority immediately
and retains reservations through actual socket, IPC callback and child closure,
then removes only its private directory.

The [independent caller](../../examples/hosted-application/consumer.mjs) verifies
real child-rendered bytes, granted runtime input, separate private output,
two-child snapshot handoff, expiry, cancellation and teardown. Reproduce with
`node --experimental-strip-types tools/qa-hosted-application.mjs
--workspace-exports`. This named provider uses public source exports; it is not
part of the seven packed browser SDK artifacts. Cross-host/network service,
encoded media, audio, arbitrary applications, OS input, physical display and
general platform qualification remain unavailable here. R09 remains open.

## Sparse runtime load qualification

`examples/runtime-load/runtime-load.ts` exports `RUNTIME_LOAD_TIERS` and
`runRuntimeLoadQualification({ tier, signal, authorize })`. The
`subscribed-runtime-load/1` workload uses the public runtime with fixed adjacent
Node worker targets. The host's ordinary `Authorize` callback remains necessary;
declared tiers confer no permission. Each of four owner/application/session
scopes has its own actual worker. Only subscribed edges carry work.

| Tier | Subscribed edges per scope | Sources | Maximum fan-out per source | Native pending work |
| --- | --- | --- | --- | --- |
| 16 edges | 4 | 4 | 16 | 8 total; 2 per scope |
| 64 edges | 16 | 4 | 16 | 8 total; 2 per scope |
| 128 edges | 32 | 8 | 16 | 8 total; 2 per scope |

Each edge has one sink and one latest pending record containing bounded integer
sequence/state. Sixty sustained turns request a 20 ms interval; the receipt
reports actual elapsed time and turn rate. A turn publishes current state and
explicitly flushes the public runtime. Native acknowledgment confirms the exact
edge, sequence and state. Every admitted edge must receive current output, and
receipts report per-edge service and per-scope recovery. Latest delivery can
coalesce intermediate states; accepted, coalesced, dispatched, current and late
effects, cancelled work and retired queue counts remain distinct.

The runner rejects a foreign tenant before any target dispatch and denies an
extra route without displacing incumbents. It holds real native work in scope
zero for eight turns while the other three continue, then verifies all scopes
recover during twenty turns. Actual held operations exercise revocation and a
fresh constrained-grant expiry. Cancellation fences queued and late delivery,
retains its one runner reservation through four actual worker exits, and closes
every created route, including denied idle handles. Issued effects may finish
before cancellation reaches a worker; late and uncertain outcomes are retained.

Runs admit at most thirty-two lifetime attempts per module, have a twelve-second
deadline, and bound each target to two unresolved operations and 4,096 operation
IDs. Native producer messages are capped at 2,048 and captured output at 4 KiB.
Receipts are capped at 32 KiB. Worker heap/stack ceilings constrain this fixed
software target; they establish no RSS, thermal, battery or general OS sandbox
guarantee. Parent admission-to-ACK time and worker emission clocks are separate;
the receipt makes no hardware capture-to-output or network latency claim.

Run `node tools/qa-runtime-load.mjs --sdk-root <installed-consumer>
--candidate-tree <source-tree>`. It compiles the exact caller against the
immutable seven-package SDK, verifies all source and installed file hashes, and
executes ordinary public JavaScript imports without loader aliases. The named
macOS/Node software tiers are local qualification; accepted release capacity,
other platforms, media, networks and physical devices require separate evidence.

## Selected software transport recovery

`examples/runtime-recovery/runtime-recovery.ts` runs the fixed
`software-resource-recovery/1` workload through actual issued endpoint peers.
Both resource owners separately approve the pointer position/contact routes.
The reviewed fixture supplies native close and deliberate sender-admission or
callback impairments; it supplies no resource authority. Copied peer metadata,
wrong epochs, retired native owner signals and incomplete fixture methods fail
before taking ownership of the supplied pair.

The caller exercises direct mTLS WebSocket, the authenticated local gateway and
native WebRTC. Each path uses four fresh generations for owner withdrawal,
grant/lease expiry, native disconnect and explicitly approved recovery. Reliable
contact edges reach the actual SDK sink; a held sink Promise settles after
withdrawal without restoring output. Re-sending genuine resource arguments tests
receiver sequence/epoch rejection. It does not qualify outer transport replay,
IP packet loss, media recovery or physical input.

Each trial allows two routes, four registrations, two raw deliveries, sixty-four
latest offers, eight reliable offers, two captured packets of at most 1 KiB,
thirty-two checks and a 16 KiB receipt. One module-realm runner reservation remains
held through actual raw/native and asynchronous host-observer settlement. Trial
admission lasts four seconds; each native path has a fifteen-second logical
lifetime. Native credential provisioning has separately bounded OpenSSL calls;
logical cancellation does not establish an overall wall-time or native-memory
ceiling. Source/receiver wire clock IDs are `recovery-source-monotonic` and
`recovery-target-monotonic`; their provider origin is recorded separately.

Run `node tools/qa-runtime-recovery.mjs --source`, or
`node tools/qa-runtime-recovery.mjs --sdk-root CLEAN_CONSUMER` after the ordinary
offline SDK consumer check. The installed mode verifies the exact immutable SDK
manifest and package bytes, resolves public ESM exports before source hooks, and
uses explicitly identified source Hub/coordinator/gateway modules. WebRTC uses
two native peers and distinct ephemeral identities in one owned trusted browser
realm with no ICE servers. The gateway sees application plaintext. Installed Hub,
two-page isolation, internet/physical paths and the wider F09 matrix remain open.

## Separate media and control scheduling

The [media/control caller](../../examples/media-control/media-control.ts) uses
separate public `createDeviceRuntime` instances for media and contact events.
Two private Node Workers hold authored RGBA frames while contact apply/release
continues. Each media recipient has one latest waiting frame; a slow recipient
cannot hold the other recipient's queue. Resolution adaptation needs fresh
source and sink approval and a new format epoch.

The caller uses verified public resource chunks with independent owner, route
and resource grants. Stop, revoke and expiry release held contact state. Already
issued work keeps its raw-operation and byte reservations until an actual Worker
acknowledgement or exit; logical cancellation does not free those reservations.

The selected profile bounds two Workers/recipients, 64 KiB frames, 4 KiB chunks,
512 KiB of caller buffer reservations, sixty-four frame and control attempts,
and ten seconds of lifetime. The buffer limit is not a process RSS guarantee.
Run `node tools/qa-media-control.mjs --installed <manifest> <clean-consumer>
<immutable-caller-tree>` to compile the external caller against the ordinary
installed SDK and exercise its actual private Worker effects. It does not acquire
user devices, open a network listener, or qualify browser codecs, transported
media, physical latency or the full V02 matrix.

## Captured application-wire replay

The [WSS replay caller](../../examples/wire-replay/wire-replay.ts) exercises
`direct-wss-wire-replay/1` through the public authenticated peers, publisher and
receiver. Its private native fixture captures actual `101W` application bytes
at `socket.send` and reinjects them through an owned authenticated WSS socket.
Derived schema, profile, epoch and timing mutations are labeled separately.
Current incumbent routes and fresh native effects qualify rejection checks;
expiry and owner revocation have their own retirement evidence.

`node tools/qa-wire-replay.mjs --sdk-root <clean-consumer>` compiles the caller
against ordinary installed declarations with strict NodeNext checks, then runs
the bounded native suite. This selected path does not qualify TLS ciphertext
replay or other receiver/transport boundaries.

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

An async deadline retires the operation's authority but keeps its issued promise reserved until that promise actually settles. Further operations return `busy` while storage, approval or other awaited work remains unresolved; after settlement, an explicit new operation may start. Late approval cannot restart the retired operation. `close()` still retires authority synchronously; callers separately close their storage, and this API does not promise native-operation quiescence.

`examples/extension-installation/consumer.mjs` verifies both bytes and signatures before importing its two fixed reviewed local implementations. Its real route-backed caller changes the temperature threshold, exercises update and rollback, cancels queued effects, denies an unapproved route and reloads inactive in fresh processes. This is trusted in-process code: host factory binding, synchronous cleanup and checking `activation.isCurrent()` before effects remain explicit host obligations. Untrusted code isolation, synchronous hang preemption, connector/native/dependency/asset profiles and physical qualification remain open under E10.

## Durable browser processor installations

`createBrowserProcessorInstallationStorage({ ownerId })`, exported by
`@101/device-web` and `@101/connect`, supplies the existing installer's
`ProcessorInstallationStorage` port. Construction is inert. Explicit reads and
writes use browser Storage; a missing or denied facility fails closed. The
adapter accepts only the installer's exact encoded owner key and opaque document
bytes within the existing 4 MiB UTF-8 limit. It adds no document or wire schema.

Each compare-and-swap holds an exclusive Web Lock for that owner, checks the
original stored bytes and current native abort signal and approval guard, then
performs its synchronous write. Initial port/read callouts are followed by a
fresh approval check and final byte comparison. Injected ports must keep that
final read/write segment synchronous and native-equivalent, without callbacks
that change authority or clocks. Arbitrary host callbacks are not made atomic.
`isCurrent()` reads the actual stored bytes, so
another cooperating page's mutation can fence activation before a storage event
arrives. One issued request is retained until its returned promise settles;
abort and close cannot admit replacement work early. `close()` returns one
terminal barrier for this adapter's issued requests. Close the public installer
first to retire activation, then await the storage adapter. This barrier does not
claim settlement of WebCrypto work hidden behind another API.

`@101/connect/examples/browser-storage` exports
`createBrowserProcessorStorageExample`. The host supplies its fixed verified
publisher bundle, factories, conformance fixtures, configuration and fresh
management approvals. Stored releases, selected versions and revocation history
reload inactive; publisher trust, approvals and live resource grants are never
restored. Live routes still require separate source and destination grants.

This is a cooperative same-origin storage profile. It does not isolate hostile
same-origin code, prevent browser eviction or guarantee recovery after OS power
loss. Settings offers the explicit tab or browser choice described below.
General extension, native privilege, dependency and isolation work remains open.
[Scoped implementation and current installed browser evidence](receipts/2026-10-07-browser-processor-storage.json) records exact producer bytes, original failures and remaining limits.

<a id="tab-only-reviewed-processor-management"></a>

## Reviewed processor management

`/settings/processors`, linked from Settings, manages two built-in reviewed
number-threshold versions through the public signed installer and runtime. Arrival
is inert. Explicit management lasts at most 30 seconds; each install, activation,
rollback, revocation or removal has its own review. Installation does not activate.
Live use separately approves the page's Celsius number input and its indicator
output. Both versions use their original fixed reviewed factories and genuine
native P-256/SHA-256 verification; a manifest cannot select executable code.

The management review defaults to **Only this tab**. **Save on this browser**
explicitly selects the public browser storage adapter after fresh management
approval; selecting or declining the choice does not touch saved storage. Tab
documents stay in RAM. Browser documents retain reviewed source/history and
revocation records; a fresh page restores them inactive. Neither choice saves
factories, trust, grants or live permissions. No automatic migration or RAM
fallback occurs when browser storage is unavailable. Corrupt/future data stays
unchanged. Another page's stored-byte revision fences live effects; storage
notifications only retire authority and never supply consent.

Stop is available during verification and live use;
actual issued public returns and supported route settlement are retained through
close. A hung return remains pending. The page admits at most 32 changes and 32
derived commands at 10 Hz within the original lease, with at most one incumbent
and one candidate runtime. Pending latest input gets a bounded 100 ms drain;
stop cancels the drain before releasing authority. Focus returns to the initiating
action after its actual work settles. Existing monochrome, reduced-motion and
visible-focus styles are reused.

This is a software page indicator, not a temperature sensor, heater, general
connector installer or persistent identity/publisher management. Arbitrary code
isolation, native privileges, other profiles and physical/assistive technology
qualification remain open under U12/E10. [Scoped implementation and software
evidence](receipts/2026-10-07-processor-management.json) identifies exact inputs
and the distinction between implementation, runtime evidence and final gates.
[The browser-saved Settings build and focused source checks](receipts/2026-10-07-durable-processor-management.json)
leave its broader browser interaction checks deferred.

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
state without claiming the handler has stopped. A later ordinary return updates
its handler result while preserving expired/cancelled state. A stronger late
`target-acknowledged` or `observed` report may update historical state/effect
evidence; the route remains retired and no authority is renewed. The
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

Local admission cannot recall bytes already handed to a socket. The resource binder keeps source-clock mapping, maximum age, operation deadlines, latest replacement, reliable replay protection and silence release. Late data cannot restore a retired route. [Transport and view evidence](receipts/2026-10-06-transports-views.json) records the actual packed Chromium/Node path in both directions, a 700 ms stalled receiver, saturation, loss release and replacement enrollment. The browser uses an isolated localhost certificate exception; independent Node checks verify CA and hostname success/failure. The selected local authenticated gateway path is described below. Two-network and physical-phone acceptance remain open.

## Local HTTPS coordinator

`@101/hub-server` exports `createHttpsCoordinator`, `createCoordinatorFetcher`, `HTTPS_COORDINATOR_LIMITS` and their option/enrollment types. This is the selected `provisioned-loopback-node-mtls/1` rendezvous profile, separate from the seven browser SDK packages. The server binds only `127.0.0.1` and requires TLS 1.3, a matching valid server certificate/key with that IP SAN, a trusted client CA, exact HTTPS origins and unique provisioned certificate-to-principal/device enrollments. Native certificate verification plus current enrollment fingerprint/validity governs every request.

Authenticated creation, invitation join, host rotation, private offer/answer, reconnect and departure reuse the public pairing clients. Host and peer requests need their role bearer and authenticated principal; copying a bearer to another enrolled principal fails. Device identity comes from enrollment. The host sees only its session's peers and a peer can read only its own offer. Endpoint overrides and forwarded-header authority are rejected. Rendezvous permission grants no device resource access.

The finite ceilings include 64 enrollments, sixteen origins/sessions, four sessions per principal, eight peers per session, sixteen peers per principal, 32 total raw sockets, four resident authenticated sockets per enrolled principal across caller instances, 32 requests per principal per second, four pending caller requests, 401,024 request/response bytes and ten-minute sessions. `createCoordinatorFetcher` verifies CA/hostname, permits only its configured origin/endpoint, rejects redirects and closes its owned agent/requests. `stop` destroys accepted sockets and ephemeral authority; stopped coordinators cannot restart. Credentials are host supplied and never emitted by the public example or receipt. Enrolled-principal admission occurs once per authenticated TLS socket before HTTP; requests and keepalive do not acquire another slot. Only the actual native close event releases its slot, including during Stop. The [selected S11 evidence](receipts/2026-10-08-coordinator-principal.json) retains the genuine held-socket OLD failure and four-socket isolation result. Pre-authentication and unenrolled global saturation, aggregate multi-principal exhaustion and handshake CPU fairness remain open; forced TLS resumption has source review but no executed qualification.

`examples/coordinator/https-coordinator.ts` is the real provisioned Node caller. `node --experimental-strip-types tools/qa-https-coordinator.mjs` exercises disposable local certificates and the normal public exports. Its generated offer/answer proves private signaling, without claiming a WebRTC/media session. Browser client certificates, accounts, enrollment/key lifecycle, persistent directories, relay and phone/two-network qualification remain separate.

## Authenticated local relay

`@101/hub-server` exports `createAuthenticatedLoopbackRelay`,
`connectAuthenticatedRelay`, `AUTHENTICATED_LOOPBACK_RELAY_PROFILE` and
`AUTHENTICATED_LOOPBACK_RELAY_LIMITS`. The selected
`authenticated-loopback-gateway/1` profile binds a provisioned Node gateway to
`127.0.0.1` on an ephemeral port. It requires native TLS 1.3/mTLS, exact HTTPS
origin, current certificates and unique certificate/principal/device/endpoint-key
enrollments. The client validates the CA, host and exact gateway certificate
before sending its bearer, then proves the pinned gateway endpoint key through
the existing signed WSS transcript.

Creation validates inert configuration. `start()` opens the owned listener;
`issuePair(request, authorize)` requests independent current owner approvals
for the source and receiver. Each approval binds its exact frozen request,
principal, role, application/session, epoch, certificate pins, gateway endpoint,
purpose and expiry. Two separate random 256-bit credentials bind those fields
and are consumed once. A gateway credential authorizes this connection only;
source subscription and sink writing need separate public SDK resource grants.

Connect both roles concurrently with `connectAuthenticatedRelay`. A client is
ready only after a bounded authenticated gateway acknowledgment binds the actual
leg transcript to the pair, role, epoch and application/session. The selected
path receipt records the endpoint, gateway certificate/key pins, transcript and
`plaintextGateway: true`. Each leg terminates at the trusted gateway; its
operator can inspect or modify the forwarded resource payload. This profile
provides no end-to-end payload encryption or operator sandbox.

The fixed ceilings are eight enrollments, four pairs, twelve native connections,
sixteen lifetime allocation attempts and one pending allocation. Credentials and
service lifetime are limited to fifteen seconds; pairing and handshake each have
a three-second bound. Per leg, messages are at most 8,192 bytes, queues hold at
most four messages, one raw write may be unsettled and total buffered admission
is at most 16,384 bytes. Pair traffic is at most 262,144 bytes. These admission
ceilings are not throughput or network-latency guarantees. One stalled pair
cannot consume another pair's queue or restore retired authority.

`revokePair()` and `stop()` retire authority immediately; socket and raw-write
reservations persist until their native completion. Already issued writes may
have an uncertain effect and cannot be recalled. Replacement needs a fresh
instance, gateway identity, pair credentials and resource approvals. There is no
automatic downgrade, scanning, redirect, query-token forwarding or reconnect.

`examples/coordinator/loopback-relay.ts` exercises typed resource delivery and
independent denial/release through the public exports.
`node tools/qa-loopback-relay.mjs --source` uses disposable local certificates,
actual native gateway legs and a separately selected direct WSS path for
comparison. `--sdk-root CLEAN_CONSUMER` uses the seven normally installed SDK
packages while retaining source-bound hub, pairing, protocol and input APIs;
the hub is not a packed SDK package. Both modes remove their owned software
fixtures. Internet/TURN hosting, account enrollment, two physical networks,
phones and relay performance qualification remain open. The existing
`fixed-coordinator-directory/1` operator configuration still disables relay;
a combined operator harness is separate O02 work.

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
directories, enrollment/key lifecycle, browser client certificates and
physical/two-network qualification remain open. Current peer publication is
described below.

## Authorized software-gateway inventory

`createGatewayInventoryConnector()` is a public `@101/hub-server` source API for
`authorized-node-agent-gateway-inventory/1`. Its selected endpoint is an explicit
owned `https://127.0.0.1:<port>` software gateway. One fixed GET reads the enrolled
peer's existing private-directory metadata; the caller cannot choose a URL,
method, redirect, scan, program or fallback. Router/vendor/LAN and inaccessible
isolated equipment remain unsupported by this profile. A stopped gateway returns
unavailable; retry requires a fresh explicit approval. No unrestricted scan is
attempted to fill missing equipment or metadata.

The constructor is inert and requires explicit CA trust, matching client
certificate/key, exact server certificate SHA256, origin, session, peer, bearer,
owner signal and an owner authorizer. Ordinary CA/hostname validation and the
exact server pin must pass before the bearer reaches HTTP. Each immutable issued
request binds the owner, selected gateway/endpoint, both certificate fingerprints,
session/peer, purpose and GET scope. Approval must return that same request plus
an intrinsic AbortSignal and an absolute host-performance-clock expiry within
five seconds; copied requests or signal-like objects do not authorize a read.
Possession of directory metadata is separate from device ownership and operation
grants; returned candidates do not establish authenticated, authorized or ready
resource state and contain no RSS reading.

One raw request remains reserved through actual request/response/socket closure
after cancel, expiry or owner revocation. `close()` waits for that settlement;
late bytes cannot restore a retired result. Bounds are 64 lifetime attempts,
burst four with one token per second, an absolute 2500 ms operation deadline,
64 KiB/128 response chunks, 16 resources/eight capabilities and at most 60 seconds
advertised metadata lifetime. Invalid UTF-8, malformed/oversized metadata,
non-JSON responses, wrong scope, redirects and credential/identity failures
produce fixed redacted outcomes; no alternate endpoint is contacted.

The selected [software gateway](../../examples/gateway-inventory/node-agent-gateway.mjs)
qualifies its RSS capability through the actual private Node agent and ordinary
SDK read before exposing that current epoch's scoped inventory. The
[independent caller](../../examples/gateway-inventory/consumer.mjs) uses an owned
mTLS context. Native agent retirement also retires its owned gateway; replacement
requires a new agent identity, session and approvals. This source distribution
does not establish physical router support, cross-network access, hardware
qualification or a packaged native gateway installer.

## Watch companion report resources

`decodeWatchCompanionReport()`, `watchCompanionReportDevice()` and
`createWatchCompanionResources()` expose the selected
`watch-companion-report/1` profile through the ordinary model/runtime packages
and `@101/connect`. The companion's existing 53-byte version-1 packet and
legacy 101 game path are preserved. The report contains the original 16-bit
sequence, 32-bit **relay emission** milliseconds, reported quaternion components,
acceleration in g, rotation in degrees per second, unqualified crown value and
sampled tap bit. Nonfinite fields and invalid packet grammar are rejected.

These are raw reports with `physicalValidity: 'unspecified'`. Version 1 carries
no sensor-presence bits, measurement validity, calibration, capture timestamp or
watch generation. Apple tap reports include synthetic identity/zero motion;
Wear reports can contain zero defaults for absent sensors. These values cannot
qualify motion measurements, haptic effects or tap recognition. The latest
sampled tap bit supplies no guaranteed button edges or reliable event semantics.
Phone receipt time is separate from watch emission time and establishes receipt
inactivity only; it cannot establish capture freshness or translate clocks.

The native module's additive `createWatchResourceBridge()` issues opaque
phone-side enrollments. Apple enrollment describes the current paired
WatchConnectivity session; Wear selects a reachable native capability node and
filters message senders to that selection. Copied objects, node IDs, player IDs
and report fields do not issue enrollment authority. These native associations
are trusted bridge facts, with no cryptographic hardware-identity claim. Phone
epochs fence callbacks after enrollment loss; the unchanged wire cannot prove a
report's original watch generation. Re-enrollment requires fresh owner approval.

Construction is inert. Explicit start requires an intrinsic owner AbortSignal
and an exact owner-approved resource request. Source enrollment/owner consent
and each destination route grant remain separate. Loss, abort, stop and expiry
unregister the source and release held downstream state; late native completion
cannot restore a revoked source. Two enrollment/raw-work slots are shared per
runtime, and one unresolved native operation is retained per actual bridge/port
through cleanup. Other bounds are one latest report, 30 Hz, 250 ms receipt
inactivity, 30-second owner/session consent, 64 lifetime starts and a 1000 ms
caller route lease. Reservations precede trusted callouts; native listener
cleanup also handles cancellation during listener registration.

The [independent caller](../../examples/watch-companion/consumer.mjs) checks
ordinary public runtime registrations, independent source/sink grants, report
arrival, expiry, loss and releases. `tools/qa-watch-companion.mjs --sdk-root
<fresh-consumer> --candidate-tree <tree>` verifies exact installed package and
source bytes, unchanged executable Swift/Kotlin report producers and the native
TypeScript issuer through explicitly injected software ports. The new Swift
issuer has syntax-only checks. Native Expo Swift/Kotlin framework compilation,
actual scoped watch/phone delivery, permissions and physical qualification
remain open under W01; software ports do not establish native OS delivery.

### Declared wearable calibration inputs

`createWearableCalibrationProcessor()`, `wearableFusionInputDevice()`,
`WEARABLE_CALIBRATION_PROFILE` and `WEARABLE_CALIBRATION_LIMITS` are public
runtime/facade exports. The selected `reviewed-wearable-projection/1` projects
**reported** watch inputs; it does not qualify sensor presence, physical motion,
capture timing or native watch/phone delivery.

Construction is inert. `configure()` requires closed host-reviewed profile
id/version/hash/revision and raw `watch-companion-report/1` semantics,
namespaced source/reference/target frames, explicit mounting/neutral unit
quaternions, hand/calibration revision, raw source authorization reference and
intrinsic owner signal/deadline. Unknown semantics are unavailable; malformed
replacement preserves the incumbent. Valid newer calibration issues a private
handle and retires the old generation. Delivered observations verify the source
registration/device/capability tuple; descriptor revision remains a host declaration.

`process(handle, observation, context, deliveryScope)` consumes actual raw
route data plus a fresh conservative host snapshot:

~~~ts
const limits = computeRoute.limits();
if (!limits) return;
const result = processor.process(handle, observation, context, {
  routeId: computeRoute.id,
  expiresAt: limits.expiresAt,
  maxAgeMs: limits.maxAgeMs,
});
~~~

`WearableCalibrationDeliveryScope` binds its own-data route ID to the context.
The snapshot does not grant/authenticate access. A final fresh clock follows
two bounded currentness callouts, then checks private generation, both intrinsic
signals, owner/route expiry and intersected receipt age. No exact-clock equality
or fence loop is required. This is a local projection snapshot under captured
route time caps/observed delivery authority. Source/sink readiness deadlines
absent from the snapshot and arbitrary lying hosts are not certified. Recheck
the actual raw context and current processor before publication; recheck the
actual application context before an effect.

Mounting computes `q_report*q_mount` and inverse-rotates vectors; neutral changes
attitude only. Hand labels never mirror by themselves. Declared frame reflection
maps polar acceleration and applies determinant parity to axial angular velocity.
Reported g and deg/s remain explicit; the grams converter is not used. The
distinct `wearable:reported-fusion-input/1` capability uses schema version 2
for its framed quaternion and retains `captureTimeKnown: false` and
`physicalValidity: 'unspecified'`.

Provenance preserves reviewed profile/version/hash/revision, mounting/neutral,
hand/frames/calibration/private generation, source reference/delivery caps,
sequence, relay emission and host arrival. Replay floors survive reset,
replacement and A→B→A; descriptor metadata cannot mint an epoch. Copied/retired
handles, stale/reordered input, invalid/saturated quaternions/vectors, revoked
signals and clock failure are refused. Bounds: 32 lifetime configuration
attempts, one active handle/synchronous admission, 32 source/profile floors,
30-second ownership, 250 ms receipt age, 30 Hz, 4 KiB input/output, no retained
reports or timers. `reset()` and synchronous `close()` retire local computation;
no native/async work or quiescence promise.

The [external reference caller](../../examples/watch-companion/calibration.mjs)
is deliberately unpacked ordinary JavaScript. Retained genuine encoder bytes
enter an explicit software bridge and real watch report resources. Capture,
raw compute and projected application routes need separate exact approvals.
Calibration/source loss removes queued output and releases the owned effect.
Run `node tools/qa-wearable-calibration.mjs --installed SDK_MANIFEST CLEAN_CONSUMER CALLER_TREE`
on an immutable artifact set. Current evidence includes 19 source runtime tests,
20 ordinary installed caller checks and seven verified public package
resolutions. It opens no physical watch/phone.

### Shared watch report contract fixtures

`bindings/watch-report/fixtures/watch-report-v1.json` is the shared source for
eight golden reports and 26 decode cases. The unchanged Swift and Kotlin
`WatchPayload` codecs each execute 42 encode/decode commands; ordinary installed
JavaScript checks the strict `watch-companion-report/1` decoder. Three reserved
button-bit cases deliberately differ: the legacy native codecs mask the bits,
while the strict JavaScript profile rejects them. C has no watch report codec.

Run `node tools/qa-watch-report-bindings.mjs --installed <SDK-manifest>
<clean-consumer> [--caller-tree <immutable-tree>]`. The caller verifies the exact
installed package file allowlist, unchanged native producer bytes, shared
fixtures and public ESM resolution. Each language's actual encoded bytes also
pass 16 independent source/sink grant, epoch, sequence-wrap, revoke and expiry
checks through explicitly supplied software bridge ports. Relay emission time
remains separate from host receipt time; neither proves capture freshness.

Fixture limits are 32 KiB, 16 golden reports, 64 decode cases, 128 commands,
4 KiB per command line and 256 raw input bytes. Native consumer stdout and
stderr are each capped at 128 KiB. Their commands have a 30-second deadline
and retain the child until actual close; the existing cached Kotlin compiler
helper has its separate 1 MiB output limit and 30-second timeout. The selected
proof uses Swift 6.3.3, Kotlin 2.1.21 and JDK 21.0.12.
This adds shared executable contracts; native watch/phone OS delivery,
hardware, authentication, calibration and broader Q02/E12 coverage remain open.

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

The selected native producer now checks its finished package contents before
returning. `normalized-pointer-bindings-content-audit/1` binds the immutable
manifest hash, all declared regular file hashes and three bounded USTAR archives.
It rejects extra payloads, links, unsafe/duplicate paths, hidden GNU/PAX metadata,
known private filenames, PEM private-key markers and explicitly supplied workspace
roots. Kotlin's five-entry JAR is independently decoded with bounds and CRC checks.
The producer suppresses macOS auxiliary metadata and Swift SourceKit source-info;
clean Swift module imports still pass. Current output contains 33 declared files:
14 Swift, 9 Kotlin and 10 C. The adjacent redacted `content-audit.json` is separate
from the immutable manifest and always records `releaseAccepted: false`.

Run an independent read-only contents check with
`python3 -I -S -B tools/audit-native-binding-contents.py --manifest MANIFEST --manifest-sha256 SHA256 --artifact-root ROOT --output NEW_RECEIPT --workspace-root WORKSPACE`.
It writes only that new receipt; it does not extract or execute package content.
Manifest input is capped at 1 MiB, each archive at 2 MiB compressed/16 MiB decoded,
each member at 4 MiB and nested JAR output at 4 MiB. Decoded bytes are staged in
bounded buffers; this is not an OS sandbox or an arbitrary secret detector. Its
finite private-marker policy and cooperative filesystem identity guards do not
prove all SDK/app contents safe. [Actual native contents and clean consumer
evidence](receipts/2026-10-07-native-binding-contents.json) remains partial K12/K03/E12.

## Selected Swift structured telemetry codec

`structured-telemetry-json2/1` supplies `One01StructuredTelemetryWire` for the
existing `json/2` disposable sample envelope and the page-reading record/table
schemas. A record contains `step` in unit `1` from 0 to 100, `mode` (`count-up` or
`count-down`) and optional Boolean `ready`; tables contain 1 to 8 records. Absent
`ready` remains distinct from `false`. Epoch, slot, sequence and finite nonnegative
source time are preserved. Re-encoding preserves meaning; JSON key order and
number spelling need not match JavaScript's original bytes.

`StructuredTelemetryWire.decode(Data, lane:)` returns an inert typed sample or
`nil`. `encode(_:)` throws the fixed `.invalid` error for invalid typed values.
Raw input is limited to 4 KiB and container depth 3. UTF-8, raw markers, control
bytes and encoding boundaries are checked before Foundation's complete JSON
parser; Boolean and numeric values remain separate.

Build locally from an immutable tree and the ordinary installed matching SDK:
`node tools/build-structured-telemetry-bindings.mjs TREE --sdk-root INSTALLED_CONSUMER --sdk-manifest SDK_MANIFEST`.
The local Swift package contains source, compiled module/library, callers,
license, selected schemas/fixtures and exact hashes. The builder executes seven
Swift Testing groups, five reciprocal JS/native vectors, wrong-lane rejection
and six CLI framing checks. The standalone caller accepts `D disposable HEX`
or typed `E` commands; it caps commands at 128, lines at 16 KiB, and total input
and output at 1 MiB. Valid streaming outputs may precede a later framing exit 2.

The selected codec was run with Swift 6.3.3 on this macOS arm64 host. Wider
`json/2` schemas, other languages/platforms/ABIs, native runtime ownership,
authentication, grants, freshness, clock conversion and physical effects remain
outside this codec. The host must enforce those separately. Full E12/Q02 and
public distribution remain open. [Exact source/native build evidence](receipts/2026-10-07-structured-telemetry-swift.json)
records the actual marker regression and remaining limits.

## Selected Kotlin structured telemetry codec

`structured-telemetry-kotlin-jvm/1` supplies `one01.structuredtelemetry` for the
same selected `structured-telemetry-json2/1` record/table contract above.
`StructuredTelemetryWire.decode` returns an inert typed sample or `null`;
encoding validates an owned snapshot and throws a fixed invalid-value error.
Strict Gson parsing consumes the complete JSON document. Numeric values remain
distinct from strings and Booleans; optional `ready` retains absence and false.

Build locally with
`node tools/build-structured-telemetry-kotlin.mjs TREE --sdk-root INSTALLED_CONSUMER --sdk-manifest SDK_MANIFEST`.
The nine-file package contains a thin library JAR, source, caller, selected
fixtures/profile and license. Gson 2.11.0 and Kotlin stdlib 2.1.21 are explicitly
provided external dependencies with pinned hashes; their JARs are not packaged.
Embedded dependency license declarations record provenance, not complete
redistribution approval. The builder requires the declared installed dependencies
and downloads nothing.

On this macOS arm64 host, Kotlin 2.1.21 produces JVM 17 bytecode for the selected
JDK 21.0.12 runtime. Actual checks cover 171 assertions, five public SDK/native
reciprocal vectors, wrong-lane rejection, six bounded CLI framing checks and a
clean extracted thin-module caller. The caller uses the same D/E grammar and
limits as Swift and checks actual `PrintStream` write failures. No native runtime
authority, Android/other OS/JDK compatibility or physical effects are established.
E12 remains open. [Scoped build and consumer evidence](receipts/2026-10-07-structured-telemetry-kotlin.json).

## Selected C structured telemetry codec

`structured-telemetry-c-jansson/1` supplies the same selected record/table
contract through `one01_structured_telemetry_wire.h`. Decode returns 1 on
success and leaves the output unchanged on failure. Encode captures a fixed
sample, validates its owned rows and publishes complete bytes only on success;
failure sets the encoded size to zero without changing the byte buffer. Caller
pointers must identify valid, stable, nonoverlapping owned memory.

Jansson 2.15.1 performs complete JSON parsing and encoding after bounded UTF-8
and depth preflight. This selected producer profile rejects duplicate keys.
Boolean, number and absent values remain distinct. The standalone D/E caller
uses the same bounds as Swift/Kotlin, preserves finite subnormal values and
returns exit 2 for an actual closed output pipe.

Build locally with
`node tools/build-structured-telemetry-c.mjs TREE --sdk-root INSTALLED_CONSUMER --sdk-manifest SDK_MANIFEST`.
The ten-file package contains its own static module, header, source, tests,
caller, schemas/fixtures, profile and license. Jansson headers/library are
provided externally and pinned; none are redistributed in this package.
Actual C11/Apple Clang 21/macOS arm64 checks cover eight native groups, five
public SDK reciprocal vectors, the public finite minimum, six CLI framing
checks, closed output and a clean extracted caller. Other platforms, ABIs,
schemas, runtime authority, physical effects and full E12 remain open.
[Scoped native and consumer evidence](receipts/2026-10-07-structured-telemetry-c.json).

## Explicitly remembered past devices

The reference application's `/devices` flow keeps connections temporary by
default. An explicit reviewed action can remember only a past reported name and
public key ID in this browser. **Show remembered devices** reads those records;
they always appear offline. **Pair again** starts a fresh pairing with complete
code comparison and separate resource approval. Saved names and changing keys
do not establish physical-device identity or restore connection authority.

The selected local store caps records at eight and its document at 8 KiB. A
fixed native Web Lock serializes reviewed changes; denial, quota, conflicting,
corrupt and newer-format data have explicit recovery outcomes. Corrupt data is
preserved. Cancellation retains issued storage/lock work until it returns.
**Forget remembered device** removes the selected public metadata separately
from a current connection. No offer, answer, credential, descriptor, preview,
input, grant or connection is saved.

The implementation passes 24 focused cooperative source checks. Native browser
storage/lock and broader interaction journeys are deferred; this is not account
enrollment, physical identity continuity or whole U02 completion.
[Scoped implementation evidence](receipts/2026-10-07-remembered-devices.json).

**Review public metadata export** shows the exact past names and public pairing
IDs. A separate confirmation within 30 seconds prepares a bounded version 1 JSON
copy for manual selection/copying. **Restore remembered names** accepts that
manual text, reviews every entry and requires a second confirmation. Restore
works only when the dedicated remembered list is empty and its exact stored
revision has not changed. It never merges, replaces or resets saved data.

The same eight-record/8 KiB store/parser and exclusive Web Lock protect restore.
Expired reviews, cancellation, unavailable storage, quota and conflicts preserve
existing data. Restored records stay offline and require fresh pairing and input
approval. No clipboard, file picker, account backup or connection authority is
added. The extended flow passes 34 focused cooperative source checks; native
browser and broader UI checks remain deferred.
[Scoped backup/restore evidence](receipts/2026-10-07-remembered-public-backup.json).

## Structured readings in enrolled device previews

The `/devices` preview derives record and table choices from each current,
authenticated descriptor. Review the fields and units before approving selected
resources. Readings use readable column names; missing optional values display
as missing, while a reported false value displays as Off.

The selected preview supports the existing schema version 1 scalar, boolean and
enumerated reading fields, with six fields and eight rows at most. It retains
bounded projected cells only during current approval, and clears them on stop,
expiry or disconnect. Commands, jobs and unsupported schemas remain unavailable.
Remembered names and public metadata backups never include readings or grants.

The implementation passes 19 focused cooperative source checks. NativeRTC,
broader UI and device checks are deferred; full U02/U03 acceptance remains open.
[Scoped source evidence](receipts/2026-10-07-enrolled-structured-preview.json).

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
content integrity. Neither authenticates a malicious filesystem host.

Registered local recipient copies require explicit `registeredCopies: 'include'`
on backup, read-backup, reviewed migration or reviewed restore. Approval binds the
exact all-registered-local count and content hash; a changed set fails closed.
Omission keeps nonempty registered copies unsupported. Recovery preserves original
record/batch hashes, source timestamps, quality and expiry, and restores no capture
or upload handles. The earliest retained-copy deadline also bounds archive life
and current approval. Remote storage and unmanaged/native/desktop recovery remain
excluded.

`close()` revokes authority synchronously and returns an idempotent Promise that
waits for actual authorization and storage work to settle. A timed-out attempt
keeps its reservation until that work finishes. Await `backup.close()` before
closing the backing storage port; direct `managedStorage` transactions are included
in cleanup and retain the backing engine's own quotas.

Run `node tools/qa-owner-backup.mjs --sdk-root INSTALLED_CONSUMER` for the original
filesystem and IndexedDB callers. The registered-copy caller is checked with
`node tools/qa-owner-backup-copies.mjs --installed MANIFEST INSTALLED_CONSUMER CALLER_TREE`;
its current qualification and limits remain in the checklist evidence.

## Pending delivery limits by authorized scope and principal

`RuntimeOptions.maxPendingDeliveriesPerScope` optionally bounds actual pending
provider work for the exact principal/application/session tuple.
`maxPendingDeliveriesPerPrincipal` additionally aggregates all approved app/session
tuples for one exact principal. Select an integer from one to
`maxPendingDeliveries` for either cap; omission preserves the existing global
policy. The principal cap also rejects explicit non-number values.

For example, global capacity four, scope capacity one and principal capacity one
keep an owner with several approved sessions from reserving all four slots.
Other approved principals can use the remaining global capacity. These are host
admission choices; they grant no route authority or guaranteed service across
separately authorized identities.

Logical cancellation or route replacement retains its reservation until the raw
provider result settles. The existing rotating recipient order applies to both
reliable and latest delivery. The [selected source and fresh installed SDK
checks](receipts/2026-10-08-principal-delivery.json) cover settlement and replacement.
These bounds apply to cooperating returned provider work; they do not sandbox
callback CPU. Optional encoded-envelope byte admission is described below. Enough
distinct approved principals can still occupy global capacity. F05 remains partial.

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
automatic reconnect. Native or host-supplied TLS socket capability must be available. Successful cancellation or Disconnect during a provisional review/connect callback fences later review publication, approval and socket issuance. Withdrawal reserves admission through synchronous Stop notifications, native close and timer cleanup; nested review/connect report busy until it returns. A fresh explicit review afterward remains possible, while cancelling a replacement preserves the current connection.

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
QR scanning, account identity or physical phone/network qualification. Add `--node-only` to exercise the actual Node TLS/P256/RSS path while browser execution is deferred. [Selected cancellation evidence](receipts/2026-10-08-invitation-admission.json) records97 source checks,13 fresh installed public Node checks, immutable genuine OLD witnesses and repaired source review. The owned QA credential/listener cleanup covers setup failures; the full-tool native OpenSSL failure path is separately verified.

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

## Selected browser microphone envelopes

`createBrowserMicrophoneProvider` and `BROWSER_MICROPHONE_LIMITS` are public
`@101/device-web` and facade exports. Construction is inert. `inspect()` returns
opaque current handles for at most eight observed audio inputs, omitting empty,
`default` and `communications` IDs. `start(handle, { purpose })` requires an exact
current owner/application/session capture approval with the same frozen request,
an intrinsic abort signal and an absolute expiry of at most thirty seconds.
It requests only that native device ID; browser/OS consent remains independent.
If the browser conceals device IDs before permission, inventory stays empty;
this selected profile does not bootstrap access through generic default capture.

The provider validates a single live audio track and the returned native device
ID. An owned AudioContext, stream source and fixed 256-sample analyser publish a
typed `{ rms, peak, sampleCount, sampleRateHz }` envelope at an admission ceiling
of 20 Hz. No source connects to the speaker destination. This is dimensionless
digital amplitude, with no acoustic calibration, raw PCM export or audio playback.
Capture approval supplies no route permission: source subscription and sink
writing require independent current SDK resource grants.

SDK timestamps describe JavaScript analyser retrieval in `runtime.clockDomain`.
The AudioContext position and generation remain separate provenance with
`captureTimeKnown: false` and `clockMappingEstablished: false`; they do not
establish microphone acquisition time or cross-device synchronization.

At most one native inspection/open/resume/cleanup may be unsettled. Selection
and capture last at most thirty seconds; logical opening is bounded to five
seconds, with sixty-four lifetime attempts, six hundred polls and one latest
256-sample buffer. Blur, hide, page exit, device change, track end/mute, owner or
capture revocation, expiry and invalid clock retire the source and release its
sink. Retry needs fresh inspection, capture approval and resource grants.
`close()` awaits actual native settlement; an unresolvable native promise can
keep it pending after logical cancellation. Trusted factory/removal failures do
not establish native cleanup or a host sandbox.

`examples/browser-resources/microphone.ts` is the public caller.
`tools/qa-browser-microphone.mjs --source`, or
`--installed MANIFEST CLEAN_CONSUMER CALLER_TREE`, distinguishes native policy
readback from an explicitly owned oscillator/stream/analyser fixture. Unknown
policy remains inert; a native denial probe requires recognized denied policy.
The owned digital producer supplies no physical microphone or acoustic evidence.
Actual browser outcomes must be read from the exact receipt. Camera providers,
audio output, physical permission/loss, media tracks and full N02/V01 remain open.

## Selected browser gamepad resources

`createBrowserGamepadProvider` is an inert browser provider exported by
`@101/device-web` and `@101/connect`. `inspect()` returns the actual observed
slot, axis count and button count; it does not choose a device. Call
`select(index)` for an opaque handle bound to that controller, observed
connection generation and exact inventory. Native reconnect, reindexing,
inventory change and stop invalidate the handle. This is browser observation,
not physical device authentication.

`start(selection, { purpose })` asks `authorizeCapture` for the exact request
object, an intrinsic `AbortSignal` and an absolute expiry at most thirty seconds
away. The request binds owner, application, session, purpose, index and declared
resources. Capture permission and each SDK source subscription/sink write
permission are independent. Returned source handles require normal explicit
routes; selecting a pad never starts a game or grants control of an output.

The provider declares only observed normalized axes and numbered button edges.
It reuses `createGamepadDetailProcessor` with zero deadzone and no inferred
trigger, hat, touched-state, mapping or haptic capability. Button pressure
accompanies pressed-state transitions; continuous analog button sampling is
absent. Observation timestamps use the caller's JavaScript polling clock, which
must match `runtime.clockDomain`. Original `Gamepad.timestamp` remains
last-update provenance with `captureTimeKnown: false` and
`clockMappingEstablished: false`; polling does not establish hardware capture
freshness.

Blur, hide, page exit, disconnect, revoke, expiry, invalid clocks and stop retire
the selected sources and cancel owned listeners, animation work and expiry
timers. Unregistering sources releases separately authorized held sink effects;
the provider does not invent a native neutral sample. Retry needs fresh explicit
selection, capture consent and SDK route grants. Bounds are eight slots,
sixteen axes, thirty-two buttons, sixty-four controller attempts, 1,800 polls
per activation, thirty-three samples per poll and at most one animation request
plus one expiry timer. The declared sixty-per-second ceiling is not a measured
hardware delivery guarantee. Injected `environment` functions are synchronous
trusted host code for separately labeled software fixtures.

`examples/browser-resources/gamepad.ts` supplies a standalone public API caller
with explicit capture and route approvals. `tools/qa-browser-gamepad.mjs`
checks owned Chromium and WebKit pages without opening a device dialog. Actual
empty/denied native inventories and injected positive logic fixtures have
separate evidence. Chromium's policy-denied result is observed; an empty
WebKit inventory does not establish policy enforcement. Physical positive
input, hardware loss/permission behavior and remaining browser providers stay
unqualified; N02 remains open.

Run `node tools/qa-browser-gamepad.mjs --installed MANIFEST CLEAN_CONSUMER
CALLER_TREE` after `tools/qa-sdk-consumer.mjs` passes for that manifest. This mode
compiles only the example against installed declarations, checks exact source,
tarball and installed-file hashes, and serves the ordinary installed JavaScript
to the owned browser pages. `--source` is a separate public-source check and
does not qualify packed bytes. Neither mode counts injected fixture input as
physical gamepad evidence.

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
cleanup guarantee. This coordinator/directory harness does not start the separately selected authenticated gateway; the combined dependency harness remains O02 work.

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

## Disposable upgrade, rollback and incident drills

Run `node tools/operator-drills.mjs --exercise` to execute
`local-operator-recovery-drills/1` using only newly created private local state.
`--help` explains the three drills without binding a listener. The CLI accepts
no endpoint, credentials, configuration path or shell command. Its stage events
and final receipt contain redacted outcomes and exact source hashes. SIGINT or
SIGTERM requests retirement; a cancelled run cannot print a passing receipt.
`node tools/qa-operator-drills.mjs --source` checks the actual CLI, teardown and
an unrelated owned sentinel. Hub and SDK modules use explicit public source
barrels; this command does not consume a packed Hub release.

| Drill | Executed recovery boundary |
| --- | --- |
| Interrupted update and reviewed rollback | Reject an altered genuine runtime envelope without claiming a valid signature; stage and fsync a reviewed candidate, cancel its final commit and preserve the accepted bytes. A compatible update and explicit retained-version rollback preserve the highest publisher sequence, version/publisher revocation and separate route grants. |
| Damaged local state after deletion | Complete owner deletion, capture the current external owner/revision floor and recover only a damaged inner producer. Preserve current deletion/audit/owner records, fence old writers and retain the original telemetry expiry. The pre-deletion archive is unavailable; restoring files supplies no recording or route authority. |
| Credential incident and fresh owner | Reject invalid operator schema and a genuine native bind collision while retaining the incumbent. Rotate actual local mTLS identity, reject removed enrollment, old TLS identity and bearer, then stop and recover with a fresh owner. Independently confirm all four retired listeners refuse new connections. |

The receipt contains 32 drill checks. One invocation remains reserved until
actual native work, pending storage and asynchronous stage observers settle.
Bounds are six native owners, four live clients, twelve client instances,
128 socket attempts, eight pending operations, 64 operation grants, twelve
stage events and a 16 KiB drill receipt. The 20-second logical native lifetime
starts after fixed private provisioning; the existing OpenSSL calls each have
their separate ten-second limit. Source closure is capped at 256 files/8 MiB
and 48 KiB of hashes; CLI QA caps output at 64 KiB and requests teardown after
35 seconds. These are admission and logical teardown limits, without a total
walltime, memory or forced-settlement guarantee for a trusted pending callout.

Normal teardown removes the private state and credentials and preserves the
unrelated sentinel. The runbook does not qualify SIGKILL cleanup, production
rollout, persistent accounts/key stores, arbitrary operator data, physical
devices or rollback of an independently current checkpoint or revocation.
Broader O04–O06, security, backup and distribution qualification remain open.

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

## Selected browser camera raster

`createBrowserCameraProvider` is an inert public browser provider. `inspect()`
issues opaque choices for exact, nonempty video-input IDs; empty inventory can
mean the browser has concealed IDs before permission. It does not acquire a
default camera to discover an ID. A choice expires after thirty seconds and
cannot be transferred to a different provider or inventory generation.

`start(choice, { purpose })` requires a same-request capture approval bound to
the owner, application, session, purpose, exact native ID and generation. The
approval contains an intrinsic AbortSignal and an absolute deadline of at most
thirty seconds. Native acquisition requests that exact video input with no
audio. Independent SDK source-subscription and sink-write approval remains
necessary before routing pixels.

The `camera-frame` resource uses `media:camera-rgba8/1`: `{ format: 'rgba8',
width: 8, height: 8, rows }`, with eight rows of thirty-two integer channels.
Each copied raster contains 256 pixel bytes. An owned Canvas2D scales the full
decoded video into this fixed raster; this profile provides no crop, camera
controls, encoded video, orientation or colour-calibration contract. Native
video is limited to 1,280 × 720 pixels. Decoded frames require
`requestVideoFrameCallback`; no timer invents a decoded-frame observation.
JavaScript retrieval time, native media position and presented-frame count are
separate provenance. Physical capture time, freshness and clock mapping remain
unqualified.

The provider bounds eight choices from thirty-two inventory records,
sixty-four attempts, one active source or unsettled native setup, a five-second
logical open, thirty-second capture, 300 samples at a ceiling of ten per second,
600 issued frame callbacks, one pending callback and one expiry timer. These
are admission limits, not measured camera performance. Stop, owner revocation,
loss, mute, hide, blur and expiry release the SDK source and held destination.
Late acquisition/play and native frame work retain their reservations until
actual settlement. An unreturned frame token or failed cooperative factory
cleanup retains a truthful failure or pending reservation.

`examples/browser-resources/camera.ts` composes the public provider and grants.
Its explicit owned-canvas fixture produces actual native stream and decoded
pixels; it does not qualify a physical camera. The browser QA default path
performs availability/policy readback with zero native camera opens. Physical
selection, permission enforcement, camera controls and complete N02/D03/V01
qualification remain open.

### Selected camera reported settings

The same `BrowserCameraProvider` adds `inspectControls(activation)`,
`bindZoom(activation, { purpose })` and `controlStatus()`. An activation must be
the exact privately issued current capture handle. Only its owned track is used;
no raw track, second camera owner or automatic permission request is exported.

Inspection reports coherent finite `getCapabilities().zoom` range/step and
`getSettings().zoom`. Absent, malformed or changing facts cannot become a working
control. Focus and exposure remain unsupported. Pan and tilt are offered only when the
current owned track reports a finite coherent numeric range and setting. Capability reports
are availability facts; they do not grant effects or prove optical magnification.

`authorizeControl` is optional and defaults to denial. A grant must retain the
exact request, an intrinsic signal and an expiry no later than capture consent.
Declining an unissued control preserves the captured frame. The command sink
declares `media:camera-zoom-setting/1`, reliable scalar `invoke`, and the reviewed
range/step. A readable application **event** source with the same semantic/schema
requires a separate real `subscribe` → `invoke` route approval. Reliable
operation IDs are canonical positive integer strings; queue capacity is one.

`controlDeliveryLimits(context)` also defaults to denial. The trusted caller
matches the exact delivered route to its actual owned `Connection`, reads
`limits()` and the exact running operation from `operations()`, then returns:
~~~ts
{
  context,
  expiresAt: Math.min(limits.expiresAt, operation.deadline),
  maxAgeMs: Math.min(limits.maxAgeMs, 250),
  maxHz: Math.min(limits.maxHz, 2),
}
~~~
Runtime and provider use the same host clock. This numeric declaration cannot
grant permission. All observer/native getter callouts precede a final fresh
clock; private epoch, intrinsic signal, capture/control/operation deadline,
age and cadence checks then fence native issuance. This is an honest cooperating
host contract, with no atomic all-readiness or hostile-host authentication claim.

Only the fixed selected-axis constraint `{ advanced: [{ zoom: value }] }`,
`{ advanced: [{ pan: value }] }` or `{ advanced: [{ tilt: value }] }` is issued. One control sink, one native
Promise reservation, thirty-two attempts, two commands per second, 250 ms age,
sixteen history entries and one timer are admitted. Values use the reported step
within 0–1,024 for zoom and −1,024–1,024 for reported pan/tilt, with at most
1,024 positions and minimum step 0.000001. These are opaque API settings with
unit `1`; no angle, physical movement or accuracy is inferred. Control
consent is bounded by the original capture deadline; logical native wait is at
most five seconds and narrows to the actual delivered operation deadline.

Stop, revocation or expiry retires the command endpoint promptly. If a setting
was already issued, capture is conservatively retired and its outcome remains
uncertain. The owned raw slot survives until the actual returned Promise settles;
`close()` waits for this settlement. Unknown returned work or cleanup failure
quarantines control admission, without claiming native cancellation or quiescence.
False or thrown removal of a late endpoint records cleanup failure; quarantined
controls remain busy. A zero raw count does not establish successful removal.
Promise fulfillment and a subsequent settings report prove API return only.

The packaged `@101/connect/examples/camera-controls` caller exposes
`createBrowserCameraControls`, `checkCameraControlsWithoutDevice`,
`runOwnedCameraControlsCanvas` and `runSoftwareCameraZoom`. Its frame/display
and event/command routes have separate grants and bounded registrations.
An actual owned canvas stream verifies decoded red/blue RGBA8 pixels and reports
zoom unsupported with zero constraints. An explicitly labeled software track
verifies API-shaped setting and held-Promise cleanup. Four source and four ordinary
installed Chromium/WebKit runs at the earlier zoom candidate passed twelve checks
each; those historical checks do not qualify this new pan/tilt candidate or native
camera zoom, physical optics, focus/exposure/PTZ or the complete V05 scope.

`bindPan` and `bindTilt` require the same issued activation and independent
control approval as `bindZoom`. They declare `camera-pan` / `camera-tilt` and
`media:camera-pan-setting/1` / `media:camera-tilt-setting/1`. Unsupported pan/tilt
retain their original `unsupported` string; supported reports are immutable
range/current snapshots. All three axes share one control binding and raw slot.
Changing reported facts invalidates the selected control before issuance.

The packaged caller adds `connectPan`, `connectTilt`, `setPan`, `setTilt` and
`runSoftwareCameraPanTilt`. The current source suite passes 80 checks, including
the existing zoom cases. A fresh seven-package/405-file SDK builds, and an
ordinary offline Node installation passes the existing zoom and new pan/tilt
cooperative caller fixtures. Native camera, OS PTZ permission, physical effects
and broader UI/device qualification remain open.
The caller accepts `routeLeaseMs` as an integer from 1 through 30,000, defaulting
to 5,000. This requests only the initial route window. Actual grants and the
original capture/control consent may shorten it; no consent is renewed.
Invalid options are rejected before caller runtime/provider construction.
[Scoped software build evidence](receipts/2026-10-07-camera-pan-tilt.json).

### Local player camera task

`/connections/camera` reuses the existing camera provider and reviewed control
caller. Arrival is inert. Explicit inventory gives numbered private choices;
capture, frame source and local display require separate approval before Start.
A preview lasts at most 30 seconds within the original selection and consent
deadlines. Nothing renews automatically. The canvas is an honestly labelled
scaled 8×8 sample, with no saving or sending.

Reported zoom/pan/tilt facts determine available settings. One axis per capture
requires separate native-setting, page-command and target-invocation approval.
Returned settings are API reports only. Stop, hiding, focus loss, owner abort or
leaving clears the preview and retires consent. An actually issued native return
remains owned until the existing caller close settles; replacement is blocked
while that work is pending. Capture and native permission are separate.

Sixteen focused cooperative source checks cover these selected software paths,
including a delayed approval that must fit the original selection deadline.
The combined local type check, lint and fresh application build pass.
Native/browser/device interaction and full U03/U10/U11/V05 qualification
remain separate.
[Scoped implementation evidence](receipts/2026-10-07-camera-player.json).

### Local player microphone levels

`/connections/microphone` reuses the selected microphone provider for digital
average and peak signal levels only. Explicit inventory and numbered current
choices precede separate capture, source-reading and local-display approvals.
No default capture requests browser permission to populate hidden IDs. Empty
inventory has a browser-access recovery path. Nothing opens on arrival.

The original 30-second setup deadline starts before inspection and cannot be
extended by later approvals. One real route supplies one immutable current
record projection; missing readings and supplied zero remain distinct. Stop,
background, loss and expiry retire authority and clear the projection. Actual
provider close and route settlement remain owned before retry. Native cleanup
failures quarantine the page; a clock callback cannot overwrite an issued run.
No PCM, recording, playback, remote recipient or acoustic accuracy is claimed.

Twenty-one focused cooperative source checks pass. Actual browser/device/UI
qualification and complete U03/U10/U11 remain open.
[Scoped software implementation evidence](receipts/2026-10-07-microphone-player.json).

### Local player brief screen preview

`/connections/screen` reuses the existing screen preview pipeline without a new
capture owner. Arrival and review are inert. Three separate approvals allow
capture, frame subscription and display on this page. The explicit Choose action
invokes the browser chooser synchronously. The original 10-second permission
window includes chooser time, cannot renew, and narrows the existing route.

Capture readiness does not prove current display. Only an actual valid latest
sample within 250 milliseconds of its JavaScript retrieval time and current
permissions makes the 8×8 scaled sample visible. Missing surface/cursor facts
remain unknown. No audio, recording, saving, sending or remote control is added.
Stop, background, resize, loss and expiry clear the output and require a fresh
review. Actual held native returns remain owned through close; cleanup failures
quarantine retry.

Seventeen focused cooperative software checks pass. Native OS chooser/capture,
browser/device/UI and full U03/U11/V07 qualification remain open.
[Scoped implementation evidence](receipts/2026-10-07-screen-player.json).

### Local player sound

`/connections/audio` reviews one generated page tone, its private connection and browser sound separately, then requires explicit Start. Arrival and review create no audio. The same opaque five-second review cannot renew its deadline; the ten-second active deadline starts at the first approved-start clock reading before any trusted/native callout. It includes preparation and clips all owner/runtime grants.

The caller uses the existing private application-audio SDK. It owns the low-gain tone producer and original track/context; the SDK owns routing clones/context and private output stream. The page owns an exact media element, including after its React ref is cleared. Stop synchronously pauses/detaches it and retires authority. Readiness, play and close returns hold admission until actual settlement; cleanup failures quarantine recovery before observer notification. Review-only retirement also stays reserved through timer cleanup/status callbacks, and owner close immediately records closed state.

Four starts,64 actions,1000 task callbacks, one20ms active task timer, one source/output/route, four runtime registrations and one pending delivery bound this caller. Volume0–0.5 and mute remain inside the approved scope; hiding/unfocusing, loss and expiry stop it. A non-speech tone has an equivalent visible description and keyboard controls; no speech-caption track is fabricated. No speaker/headphone choice, remote audio, microphone or recording is offered. Selected48kHz/two-channel graph configuration is not emitted PCM or physical hearing evidence.

[Selected implementation evidence](receipts/2026-10-08-audio-player.json) retains38 focused checks with123 actually loaded public dependencies, genuine OLD failures, original source BLOCKs and current CLEAR, types/lint/fresh local build and2selected audio/gamepad SSR checks. Browser gesture/playback, physical audio, manual accessibility and full V03/U03/final-candidate acceptance remain open.

### Local player gamepad readings

`/connections/gamepad` uses the existing selected browser provider and public runtime. Arrival and reading selection instructions are inert. Inventory exposes actual slots and counts; an opaque selected handle remains pinned through the five-second capture/input/display review. Access begins only after all three permissions and explicit Start, lasts at most ten seconds from the first approved-start clock reading, and never renews during setup or routing.

The page shows current normalized axes and declared button reports without inferring physical mappings. The first report can show a button already held. Button values describe the last pressed/released report, not continuous pressure or when a physical press began. Stop, loss, background, expiry and owner close withdraw routes and clear readings; withdrawal remains reserved through status callbacks. Failed trusted cleanup blocks retry.

Four starts,64 actions,1000 total finite review/active callbacks, one20ms task timer (1ms with pending reliable work), two routes and64 queued/pending work bound this caller. A real32-button software burst drains within the unchanged100ms producer event deadline. [Selected software evidence](receipts/2026-10-08-gamepad-player.json) records39 focused checks with123 actually loaded public dependencies, type/lint/fresh local build and1selected SSR regression. Broader browser, physical gamepad, assistive-technology and full checklist qualification remain open.

### Local player feedback presets

`/connections/feedback` derives Tap, Impact and Warning from the existing
browser haptic profile. Arrival is inert. Page preset requests and browser
feedback output need separate current approvals. The original 30-second setup
scope begins at first review and cannot renew. Each button sends one explicit,
bounded request; no custom intensity or duration is added.

API return, dispatch and physical effect remain separate. A pending request
cannot display the helper cancellation placeholder or a preceding preset result.
Stop, background, expiry and owner abort withdraw authority before callbacks.
Actually issued returns remain owned through cleanup. Clock reentry cannot
replace an approved run. Deferred cancellation is outside the synchronous port
contract, quarantines retries and remains owned until its actual return.

Twenty-three focused cooperative source checks pass. The combined camera,
microphone, screen and feedback candidate passes type checking, lint and a fresh
local application build. Browser/device, physical feedback and full
I08/U03/U10 qualification remain open.
[Scoped implementation evidence](receipts/2026-10-07-feedback-player.json).

### Selected BLE switch output

The same `createBrowserBleSwitchProvider` adds `inspectOutput(activation)`,
`bindOutput(activation, { purpose })` and `outputStatus()`. Optional reviewed
`writeFormat: 'boolean-byte/1'` declares an absolute false byte 0 / true byte 1
protocol. Profiles without this field retain notification-only behavior. The
exact private current capture activation and its characteristic remain the sole
owner; no raw characteristic, extra chooser or second GATT connection is exposed.
Actual `properties.write === true` and `writeValueWithResponse` are required.
There is no generic write/without-response fallback or inferred vendor meaning.

`authorizeOutput` defaults to denial and binds the exact request, intrinsic signal
and expiry no later than capture consent. Declining an unissued output preserves
notification input. A separate reliable application **event** source needs real
`subscribe` → `invoke` approval for `app:ble-switch-setting/1`. Its payload is a
boolean; operation IDs are positive canonical numeric strings and queue is one.
`outputDeliveryLimits(context)` defaults to denial and returns only the exact
context plus numeric expiry, age and cadence from the same actual `Connection`
and its exact running `OperationRecord`. The expiry narrows to their minimum,
age to at most 100 ms and cadence to at most 2 Hz. All observer callouts precede
the final fresh clock; private epochs and intrinsic signals fence issuance after
it. This same-clock trusted-host contract adds no permission or authentication.

The output has one sink, one pending byte, 32 bind/command attempts and 16 history
entries. Capture retains its original seven listeners; output owns at most two
additional abort listeners, so the combined ceiling is nine. Existing capture
and native-wait timers are reused. The public caller has four registrations,
two separately granted routes and at most 31 command IDs per command source.

The provider and returned runtime sink work both retain the actual issued
native write Promise. Stop/revoke/expiry removes authority without a reset byte;
notification shutdown and disconnect wait for its actual settlement. Unknown
issued returns quarantine work and may keep `close()` pending. API-returned is
separate from independently routed notification state. A cancelled issued row
remains uncertain even when its response later returns; no target observation,
physical acknowledgement or native cancellation is inferred.

`@101/connect/examples/ble-switch-output` exports
`createBrowserBleSwitchOutputCaller`, `checkBleSwitchOutputWithoutDevice` and
`runBleSwitchOutputWorkerFixture`. Its explicitly software GATT target is a genuine
owned Worker, with separate writes and state-report requests. Four source and four
ordinary installed Chromium/WebKit runs pass 15 checks each, using three writes,
seven replies and one held response per run. Worker terminate API return is
observed; native Worker exit, BLE radio/peripheral, Permissions-Policy enforcement
and hardware behavior remain unqualified. Whole A03/N02 remain open.

### Selected HID and Serial switch output

The existing `createBrowserHidSwitchProvider` and
`createBrowserSerialSwitchProvider` add `inspectOutput(activation)`,
`bindOutput(activation, { purpose })` and `outputStatus()`. Input-only reviewed
profiles retain their existing capture behavior. The exact private current
activation owns the output; no second native chooser or raw device is exposed.

HID declares `output: { reportId, format: 'boolean-byte/1' }` with an integer report
ID in 0–255 and requires its actual matching absolute eight-bit output report.
`sendReport` receives the ID separately and one owned false byte 0 / true byte 1.
Serial declares `writeFormat: 'boolean-byte/1'` and uses its same opened port's
actual `WritableStream` writer. There is no raw-byte/vendor fallback, feature
report, extra port, automatic reset, Modbus register or CRC meaning inferred.

Output approval defaults to denial and binds the exact request, intrinsic signal
and expiry within capture consent. A separate reliable application event source
requires real `subscribe` → `invoke` approval for `app:hid-switch-setting/1` or
`app:serial-switch-setting/1`. Exact numeric limits from the same actual
`Connection` and its running `OperationRecord` narrow deadline, age to 100 ms
and cadence to 2 Hz. Callbacks precede a final fresh clock and private/intrinsic
issuance fence. A profile declaration cannot grant a command.

Each output owns one sink/write/byte, at most 32 attempts and 16 history entries.
The public caller has four registrations, two routes, two runtime pending slots
and 31 command IDs. Original capture quotas and timers remain; HID adds two
listeners for a combined nine, Serial adds two for a combined eight. Declining
unissued output preserves independent input. Route denial requires explicit
Stop, actual cleanup settlement and fresh selection; in-place retry is not
claimed. Direct caller clock exceptions retire provisional state and return
`unavailable`; regressions cover this recovery in HID, Serial and BLE callers.

HID close waits for the actual issued `sendReport` Promise. Serial retains the
actual continuous read/cancel and issued write, releases both locks, then closes
the owned port. Stop/revoke/expiry removes local authority without reset bytes;
unknown issued returns quarantine pending work. API return is separate from
independently routed input reports or read state. A cancelled issued command
stays uncertain even after its response returns; physical acknowledgement and
native cancellation are not inferred.

`@101/connect/examples/hid-switch-output` and
`@101/connect/examples/serial-switch-output` export their respective
`createBrowser…SwitchOutputCaller`, `check…SwitchOutputWithoutDevice` and
`run…SwitchOutputWorkerFixture`. The linked switch-output receipt’s seven-package offline SDK had 173
source inputs and 391 installed files. Each corrected HID, Serial and BLE caller
passes four source and four ordinary installed Chromium/WebKit runs, 15 checks
per run. Native-shaped software ports and genuine owned Workers establish the
selected software contract; hardware, policy enforcement, native Worker exit and
whole A02/A03/A04/N02 remain unqualified. [Evidence](receipts/2026-10-07-switch-output.json).

## Disposable coordinator, directory and gateway stack

`node tools/disposable-stack.mjs --exercise` creates, exercises and removes a
new local stack. `--serve` keeps that owned stack available for its remaining
native service budget; SIGINT/SIGTERM requests teardown. Both modes accept no
endpoint, credential, filesystem path or live configuration. The source example
exports `runDisposableStack({ mode, signal, onEvent })`; it is not a packed Hub
distribution.

`disposable-coordinator-directory-gateway/1` composes the existing mTLS HTTPS
coordinator and private directory with the separate authenticated WSS gateway.
The existing operator configuration still disables relay. Both listeners run
concurrently during the exercise. Directory visibility, gateway admission,
source subscription and destination write are separate approvals. The exercise
checks denials, four typed software effects, withdrawal and fresh owner/endpoint
identity, epoch and resource grants across at most two generations. It reuses
the newly owned TLS fixture certificates; this is not certificate rotation.
The trusted gateway can see plaintext.

Only a fresh private directory and its fixed generated keys are used: directory
mode 0700 and eleven key files mode 0600 before any bind. Native service ownership
has a total fifteen-second budget from the first bind attempt. Existing bounded
synchronous OpenSSL provisioning is separate from that budget. The harness
bounds four pending/live relay clients, four sequential pairs per generation,
128 owned native socket attempts, thirty-two checks and a 16 KiB receipt.

Cancellation fences new work. Cleanup waits for actual component/client socket
close and issued write callbacks before removing only the new keys and releasing
the run reservation. A held observer cannot delay native retirement; its actual
settlement still retains the invocation reservation. The QA reads key modes,
checks former listener ports, and verifies an unrelated sentinel is untouched.
SIGKILL, host loss, remote deployment, physical endpoints, persistent accounts
and an installed Hub remain outside this software example.

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

## Page-owned resource connection task

Connections also links to **Connect page controls** at `/connections/resources`.
Select a compatible local timer, slider or switch and a number, meter or switch
readout. Source and output approvals are separate. Cancelling or declining a
review keeps the current connection; explicitly replacing it releases its old
output first. Stop, revocation, expiry and navigation retire the connection and
await its owned work. Approvals last at most 30 seconds without renewal.

This source application flow uses public descriptor/recipe/runtime APIs and
page-owned software values. It does not enroll remote devices or access hardware.
Run `node tools/qa-resource-task-flow.mjs OWNED_LOOPBACK_ORIGIN/ --served-proof
PINNED_SERVER_PROOF.json` against the owned source server. `--engine chromium`
or `--engine webkit` selects one native browser; omitting the option requests
both. [Local task evidence](receipts/2026-10-07-page-resource-connections.json)
keeps each actual engine revision and the remaining U03 scope explicit.

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

## Native provider contract

Native providers use the same public model and runtime as browser providers.
The host binds reviewed native code explicitly; descriptor fields never load
code, choose an executable or grant OS access. The native bridge projects its
validated profile output into these shared interfaces:

| Boundary | Shared contract and provider obligation |
| --- | --- |
| Description | `parseDeviceDescriptor` validates capabilities, schemas, units, delivery and ownership. Permission lists declare supported operations; they do not authorize them. |
| Registration and readiness | `DeviceRuntime.registerSource` / `registerSink` return local `EndpointHandle`s, initially unavailable. `setReadiness` reflects actual native availability with bounded freshness; missing or denied permission cannot become an available resource. |
| Authority | `AuthorizationRequest` binds principal, application, session, source/sink registrations, operation and partition. `RouteGrant` narrows rate, age and absolute expiry. Native registration, OS permission and native operation approval are separate prerequisites; sensitive results require their own authorized resource route. |
| Data and effects | `PublishOptions` / `Observation` preserve validated values, quality and clock provenance. Host receipt and native source clocks stay distinct until explicitly mapped. `DeliveryContext` binds the current route/generation, abort signal and operation; awaiting native work must recheck authority before exposing output. Acknowledgment and observed effect remain separate evidence. |
| Loss and cleanup | Native loss retires its epoch before host callbacks, marks resources unavailable, unregisters them and releases held output. Stop/revoke fences late results immediately; issued native work keeps its quota until actual settlement. Replacement uses fresh native identity/epoch, registration and owner approvals. Cleanup claims identify the native acknowledgment or exact host-owned removal that actually occurred. |
| IPC | Each reviewed native profile defines its closed versioned messages, caller proof, permitted operations, frame/client/work limits and failure semantics. The bridge validates native replies before publishing. Unknown versions and stale epochs fail closed; descriptors cannot extend the allowed native operations. |
| Conformance | A provider has a faithful producer/output oracle and exercises denial, loss, expiry, stale generations, bounded work and teardown through the public runtime. `runConnectorConformance` covers trusted unpartitioned streaming adapters; other operation/ownership/IPC profiles need their own actual consumer checks. |

The real macOS/Node desktop consumer in `examples/agent-ipc/consumer.mjs`
implements this contract for `private-node-agent-rss/1`: a fixed child reads only
its own RSS, native registration/read approvals are independent of SDK invocation
and sensitive-result grants, and crash/replacement retires old runtime resources.
Its fourteen profile regressions and eighteen actual native/public-runtime checks
provide the selected IPC/lifecycle oracle; RSS was not run through the generic
streaming conformance suite. [Exact source and runtime evidence](receipts/2026-10-06-agent-ipc-license-texts.json)
defines this first native contract consumer. Installation/update, account isolation,
other OS providers and physical qualification remain their separate N02–N14 rows.

## Scoped native agent IPC

`createScopedAgentIpc` from the workspace `@101/hub-server` export explicitly
starts one fixed Node child in the `private-node-agent-rss/1` profile. A new private
0700 directory and 0600 Unix socket hold its endpoint. The random capability and
one-use read permit arrive over inherited private IPC; neither is written to
environment, files or diagnostics. The child authenticates capability, version,
epoch and permit before reading its own native RSS. It cannot select another
process or an arbitrary executable.

Owner, registration, read and delivery permissions require current intrinsic
AbortSignals. Retirement invalidates admission before its redacted host callback;
the public caller unregisters the old source immediately. Crash, stop and expiry
await actual socket/IPC/child settlement. Fresh registration creates a new opaque
epoch and new grants; stale handles cannot read the replacement. Capture and
receipt timestamps keep separate child/host clock provenance.

The controller bounds one pending read, two native clients, thirty-two operations,
three starts, 4 KiB frames, 64 KiB input, a 2.5-second readiness/operation deadline
and ten-second native lifetime. Forced termination reports host-owned directory
removal without claiming a native unlink acknowledgment. Run
`node tools/qa-agent-ipc.mjs --workspace-exports --hub-barrel` for actual source
export and native/public-runtime checks. Installed updates, OS account isolation,
other targets and the full N14 lifecycle remain unqualified.

## Local license text inventory

`node tools/generate-license-inventory.mjs` collects exact legal text available in
ordinary installed JavaScript package files. It checks each name/version against
the lockfile, preserves license/copyright/notice bytes as UTF-8 text with SHA-256
hashes, deduplicates identical text and atomically replaces the existing JSON
inventory after successful collection. Importing the collector has no effect.

The collector allows 2,048 locked packages, 64 legal files per package, 128 KiB per
text, two nested legal-directory levels and 16 MiB of distinct text. Symlinks,
identity drift, invalid UTF-8 and exceeded bounds fail before replacing the
inventory. Missing packages and missing local texts remain explicit incomplete
coverage. Local text presence is not legal approval; native/model terms, omitted
target packages and complete redistribution review remain K09 work.

`node tools/generate-rust-license-inventory.mjs` collects local crate text using
`cargo metadata --locked --offline`. Importing it neither starts Cargo nor writes
an inventory. Cargo metadata is bounded to 8 MiB and ten seconds; native manifests
and legal files are each bounded to 128 KiB. Name/version/source must match the
lockfile, manifests must belong to the ordinary selected crates.io cache, and
declared license paths cannot escape the package. The collector reuses the
JavaScript collector's legal-file limits and byte-preserving reader. A successful
collection atomically replaces the existing Rust inventory; absent packages or
texts remain incomplete, and a failed collection preserves prior inventory bytes.

## Local application sharing task

Sharing offers two explicitly started local control sets and either one shared
play area or independently owned left/right sides. A control requests its selected
area; the destination separately reviews the recipient, pointer/contact scope and
thirty- or sixty-second duration. Decline, cancel and stale requests preserve the
incumbent. Approval transfers ownership and releases the prior held output.

Stop and area changes preview the exact current recipients. A stale review needs
fresh confirmation; an old review cannot revoke a replacement. Native input loss,
backgrounding, stop, expiry and unmount release held output. Recovery requires
fresh approval, and periodic route renewal never extends the approved absolute
deadline. The task bounds two control sets, four routes, sixty-four requests and
activations, eight area changes, 100 ms sample age and one owned animation loop.

Run `node tools/qa-sharing-flow.mjs OWNED_LOOPBACK_ORIGIN/sharing` for actual local
Chromium/WebKit keyboard, pointer, consent, transfer, partition and recovery checks.
WebKit button traversal uses Alt+Tab, with its default Tab limitation preserved.
These same-page controls establish no remote person/account identity, observer
distribution, OS cursor injection, phone ergonomics or full U04 qualification.

### Read-only observers

`/sharing/watch` adds one owner and up to two independent observers of this
page's software movement/press record. Each endpoint verifies the full peer
comparison; source consent and every recipient's display approval remain
separate. Decline, cancel or revoke affects only that observer. The original
source approval lasts at most 30 seconds and cannot be renewed by pausing.
The actual public resource receiver retains its slot watermark across fresh
approvals and conservatively narrows consent using its real clock mapping.
Source emission time is a page clock stamp, not hardware capture time.
Stop awaits the task's issued-return barrier; backgrounding retires approvals
and unmount initiates tracked close. [Selected build and 19 source checks](receipts/2026-10-07-watch-sharing.json)
leave broader browser/phone interaction and full U04 qualification deferred.

## Local workspace administration

`createWorkspaceAdministration` provides one explicitly created ephemeral
workspace with an immutable provisioned owner, membership, delegated roles,
resource-sharing rules and complete bounded change audit. The trusted host
authenticates each actor and approves the exact administration request through a
current AbortSignal; an actor string supplies no identity proof. Only the owner
appoints/removes administrators. Delegates cannot replace the owner or expand the
provisioned resource/rate envelope. Observer routes are limited to trusted
observe-owned property outputs and cannot invoke controls.

Compose the host's runtime authorization through `authorizeRoute` and create
managed connections through `route`. Sharing policy narrows access; the exact
source and sink owners independently approve every route. Membership removal,
role/policy loss, either owner signal, expiry and close revoke actual runtime
connections and release held output. Already-issued provider work retains its raw
quota until actual settlement. A provisional route reservation fences synchronous
host reentry before the returned public connection can be attached.
Each exact principal/application/session/resource/operation/partition tuple has
one managed connection, including a provisional connection. Duplicate tuples are
refused before runtime dispatch so owner revocation always reaches the active
handle. A stopped connection permits a separately approved fresh replacement.

The profile bounds sixteen members/resources/rules/routes, two administrators,
sixty-four changes/route attempts/authorizations/audit events, 32 KiB snapshots and
thirty-second approvals. A full audit rejects new changes rather than truncating.
The actual `examples/workspace-administration` public caller verifies typed
delivery, independent owner denials, delegated-role limits, removal and native
timer expiry. Durable accounts/team storage, cross-process identity, unmanaged
host enforcement, installed distribution and full S17 qualification remain open.

### Reference device inspection

The reference `/devices` page can temporarily enroll one explicitly reviewed peer and inspect its self-reported resources. Both ends approve the complete verified digest. A separate approval enables up to four compatible subscribe-only scalar, boolean or vector previews for at most 30 seconds; commands and media are unavailable in this flow. Stop, removal, expiry, loss, hide and navigation retire previews; retry requires fresh enrollment and grants. Device descriptors establish compatibility, not access or physical identity. This selection is volatile and does not create an account or persistent device record. [Selected source UI evidence](receipts/2026-10-07-devices-enrolled-resources.json) records the local software journeys and remaining limits.

## Reviewed browser HID switch input

`createBrowserHidSwitchProvider` is exported by `@101/device-web` and `@101/connect`; the ordinary installed caller is `@101/connect/examples/hid-switch`. It reads one explicitly reviewed HID input report: one byte whose only valid values are 0 and 1, mapped to `app:switch/1` with channel `switch-0`. The profile pins VID/PID, usage, report ID, revision and the exact supported native input layout. It exposes no output report or arbitrary decoder. Software fixture IDs are not physical product support declarations.

Construction is inert. Explicit `choose()` requires current native availability and user activation; `start(selection, {purpose})` requires a separate capture grant. Real runtime source and sink route grants remain independently required. Proxy parsing and listener teardown cannot admit overlapping selections or authorizations. Issued native/owner promises remain reserved through their actual settlement; cancellation and the 5 second logical wait do not release raw capacity. `close()` retires authority and awaits owned returned work. A never-settling host wrapper stays pending; failed native close quarantines admission.

Capture is capped at 30 seconds, with one selected device/source/resource, one pending selection/authorization/open, one native close, 64 attempts, one-byte reports, 20 reports/second with burst 4, and 600 reports/capture. The included caller owns its route queue 8 and pending delivery 1; those are not aggregate limits over arbitrary host routes. Timestamps describe host JavaScript receipt. Native event provenance is unmapped and does not establish hardware capture time.

[Selected source/installed software evidence](receipts/2026-10-07-browser-hid-switch.json) covers real owned browser Worker bytes through trusted software HID ports, real resource routing, release and cleanup, plus native API/policy negatives without chooser dialogs. Physical HID/USB reports, permission/replug, BLE/serial/output profiles and general hardware compatibility remain unqualified.

## Reviewed browser Serial switch input

`createBrowserSerialSwitchProvider` is exported by `@101/device-web` and `@101/connect`; the ordinary caller is `@101/connect/examples/serial-switch`. The read-only profile explicitly pins USB vendor/product and revision, with 9600 baud, 8 data bits, one stop bit, no parity/flow control and a 256 byte buffer. Each byte 0 or 1 is one `app:switch/1` frame; all other bytes fail closed. This is a reviewed software wire contract, not a declaration of physical product compatibility.

Construction is inert; explicit `choose()` and a separate exact capture grant precede owned open/read. Real source and sink route approvals remain independent. An entire chunk of at most 32 bytes is copied and validated before effects. Capture is capped at 30 seconds, with 64 attempts, 600 bytes/chunks/frames, 20 frames per second and burst 4. No writes, arbitrary decoder, auto-selection or retained fragments are supplied. The example owns one queue of 8 and one pending delivery; unrelated host routes have separate bounds.

The 500 ms read deadline retires authority without releasing actual native reservations. Cancellation, pending read settlement, reader lock release and owned port close are awaited in order. A never-settling trusted wrapper stays pending; failed cleanup quarantines further admission. Timestamps describe JavaScript read receipt. [Selected software evidence](receipts/2026-10-07-browser-serial-switch.json) distinguishes real ReadableStream/browser Worker effects through trusted software ports from native API negatives; physical UART, chooser permission and replug remain unqualified.

## Bounded browser screen preview

`createBrowserScreenPreviewProvider` is exported by `@101/device-web` and `@101/connect`. Its first caller is `examples/browser-resources/screen-preview.ts`. `start({purpose})` requires an exact synchronous capture grant and current browser gesture before fixed video-only `getDisplayMedia`; real resource route grants remain separate. It does not start capture on arrival or remember a selected surface.

The resource is `media:screen-preview-rgba8/1`: an explicitly downsized 8×8 RGBA8 preview, 256 raster bytes within the actual 4 KiB runtime publication envelope. Native selected surface/cursor settings remain unknown when absent. Native decoded dimensions and JavaScript retrieval time are separate facts; neither proves hardware capture time. Resize, Stop, revoke, hide, loss and expiry release the preview and require fresh capture approval.

One actual chooser/play task and owned native frame remain reserved through real settlement or cancellation. `close()` retires authority and awaits owned returned work; a never-settling factory remains pending and failed cleanup quarantines admission. The provider retains only a small sampling raster; native capture/decoder buffers are opaque. Trusted clock/environment factories are software seams, not a sandbox.

[Selected software evidence](receipts/2026-10-07-browser-screen-preview.json) records 23 focused checks and owned Chromium/WebKit canvas-to-native-video-to-typed-preview checks. Default OS display choosers were never invoked. Native screen capture/permissions, encoded or HD streams, cursor/input mapping and physical freshness remain unqualified.


## Reviewed browser BLE switch

`createBrowserBleSwitchProvider` is exported by `@101/device-web` and `@101/connect`; its installed example is `@101/connect/examples/ble-switch`. Supply a reviewed canonical service/characteristic UUID pair and revision. `choose()` requires a current browser gesture and one explicit native device chooser; `start(selection,{purpose})` obtains a separate exact capture grant before connecting the selected initially disconnected GATT server. Runtime output routes still require their own resource grants. No native identifiers or vendor claims are retained.

The selected read-only profile maps notifications of exactly one byte, 0 or 1, into `app:switch/1` channel `switch-0`. Invalid relationships, notification properties or bytes retire the source and release held output. Stop/revoke/loss requires fresh selection, consent and generation. One action, one native data operation and one cleanup chain remain reserved until actual returned work settles; `close()` is idempotent and waits that tracked work. Failed cleanup quarantines the provider. Native radio work beyond returned API settlement is not certified.

The installed caller proof uses an owned Worker and explicitly trusted software GATT ports. It proves packaged public routing, denial, release and generation recovery, not peripheral or vendor compatibility. Notification time is JavaScript receipt time; hardware capture time remains unknown.

## Haptic release during dispatch

`createHapticOutputController` honors release or `close()` called synchronously inside a trusted backend's `invoke`: an issued attempt receives its one optional cancel request after its route is recorded. Synchronous refusals create no dispatched effect. The actual issued Promise keeps the backend busy until settlement; logical cancellation or the 100ms timeout cannot free it. `close():void` remains synchronous retirement, and optional cancellation requests do not prove physical cancellation.

Late dispatched/unverified reports retain cancelled/expired/failed operation status and actual dispatched history. Existing stronger target acknowledgement/observation may update historical evidence without resuming work. The installed software proof uses genuine public runtime grants and held software Promises; native haptic dispatch and physical feedback are deferred.

## Private desktop replay retention

The Hub’s local main window uses `desktop-local-replay-retention/1` for explicitly
saved bare Replay101 data. The selected macOS native store fixes expiry at the
original native ingestion time plus seven days; replacement never extends it.
Limits are16 MiB per replay,32 live entries,50 MiB including old/new/staged and
unaccepted bytes,64 directory entries,64 KiB index/audit and128 redacted audit
rows retained30 days. One issued native operation runs with zero queue.

Captured no-follow directory/file identities, private permissions and a lifetime
native lock fence local filesystem changes. Durable cleanup intent precedes body
creation/deletion; bounded rename/fsync commits metadata. A stale deletion
generation reports conflict. Uncertain cleanup claims no removed count; restart
resumes the exact intent before serving data. Corrupt/unknown files fail closed.
Legacy adoption is an explicit review using conservative native file dates, never
source timestamps; it does not restore runtime grants or autoplay recordings.

Expiry runs when the Hub next checks history, with no offline erasure timer claim.
Backwards/invalid native clocks refuse access. Opaque `event.data` remains bounded
local JSON and is not certified secret-free; this profile exposes no generic
export. Whole-index backup rollback, power loss, malicious same-user access and
other OS targets are unqualified. The built UI uses inline confirmation, retry,
redacted failures,44px controls and visible keyboard focus. Background status
polling pauses history refresh during selection/focus. WebKit’s observed button
keyboard mode was Alt+Tab; Chromium used Tab. Controlled browser invoke fixtures
qualify the built DOM, not an actual Tauri bridge or native app launch.
[Scoped native and UI evidence](receipts/2026-10-07-desktop-replay-retention.json).

## Public route settlement example

`@101/connect/examples/runtime-settlement` exports `runRouteSettlementCaller`,
`RouteSettlementTarget` and `RouteSettlementAttempt`. It uses public roots only,
exact separately approved reliable subscribe→invoke routes, and the optional
[returned-work barrier](#returned-work-effect-evidence-and-settlement). A private
owned Node Worker holds two actual command returns, supplies one late software
ACK and one rejection, then exits separately. Host release errors cannot skip the
raw-return/barrier waits. This example proves software return/evidence semantics;
it neither moves the OS pointer nor establishes native/physical quiescence.

The scoped current offline SDK has174 source inputs,394 installed files and
seven tarballs; ten clean consumer checks pass. The ordinary installed public
caller adds nine checks with actual owned Worker exit observed. Existing matching
consumer migrations and experimental helpers follow the release compatibility
policy. [E01 evidence](receipts/2026-10-07-runtime-settlement.json).


## Encoded-envelope delivery byte admission

`RuntimeOptions.maxPendingDeliveryBytes` bounds the sum of outstanding raw apply
reservations, measured as UTF-8 `JSON.stringify({observation, options: copied})`
bytes. The observation includes the runtime's source, sequence, timestamps and
clock; options and provenance consume their actual encoded space. A publication
still fits the existing 4096-byte envelope limit. The global default is 4096 times
`maxPendingDeliveries`; an explicit value is an integer from 1 to 16777216.
`maxPendingDeliveryBytesPerPrincipal` defaults to the global byte cap and accepts
an integer from 1 through that cap. Explicit non-number or non-integer budgets
fail closed.

Each actual fanout delivery reserves its original envelope cost before consuming
a latest slot or reliable FIFO head. Count, exact scope, exact case-sensitive
principal and byte limits all apply. A blocked reliable head stays accepted;
smaller work on another route may progress. Property reads retain the original
publication cost. Stop, revoke, replacement and runtime close keep reservations
until actual raw return settlement; synchronous return/throw and asynchronous
fulfillment/rejection release them once. These are encoded-envelope reservations,
not total JavaScript heap, queued snapshot, transport, CPU or service-capacity
limits. F05 remains open for broader acceptance.

## Peer-owned current directory publication

The source Node `createPrivateDirectoryClient` supplies explicit `publish`,
`update` and `unpublish`; the packed model exports
`parsePrivateDirectoryPublication`. Publish one descriptor whose ID equals the
current enrolled device, with its current peer generation, selected existing
capability IDs, original expiry and `consent: true`. Updates require a strictly
higher descriptor revision and retain the original expiry. Removal pins the exact
generation and revision; a bounded current-lease revision floor rejects replay.

Publication gives recipients no visibility. The host must separately select
allowed resource IDs, and runtime registration and operation grants remain
independent. Update, removal, expiry, reconnect, departure and session retirement
clear prior visibility. An owner explicitly unpublishes a lost resource; this
metadata API does not probe physical availability. The existing startup catalog,
8 KiB requests, 64 KiB responses, sixteen resources, eight capabilities and eight
current peer/visibility records remain bounded. The Hub package is a source Node
API, separate from the seven packed SDK packages.

## Discovered receiver review with independent enrollment

`InvitationConnectionOptions.discoveryEnrollments` optionally binds at most eight
exact observation/identity candidate snapshots to independently provisioned
endpoint IDs and a current generation callback. The host supplies that mapping
from its trusted enrollment review. Candidate receipt IDs, scope and expiry are
compared to the immutable mapping; discovered bytes never select a URL or key.

`reviewDiscovered(candidate, invitationText, {source, endpointId})` explicitly
reviews both the candidate pins and the enrolled endpoint/key. Arrival and review
are inert. Connection still needs a separate exact connection grant, bilateral
P256 authentication and independent source/resource/runtime grants. Generation,
receipt scope, candidate expiry, endpoint currentness and the original invitation
and grant deadlines remain checked throughout held approval, socket issuance and
connected use. Loss or Stop fences late work and requires fresh explicit review
and grants for retry. There is no automatic scan, fetch, connection or reconnect.
The existing reading example exposes `reviewDiscovered`; optical QR, native LAN
and device qualification remain deferred.

## Bounded Node pure processor execution

The explicit `@101/device-runtime/node` entry exports
`createNodeProcessorExecutor`. It verifies the existing signed dependency-free,
asset-free compute-local processor release and interprets a closed JavaScript
subset without evaluating guest JavaScript. The existing temperature-band source
runs unchanged. Unsupported syntax, host globals, imports, prototype access and
general calls are rejected before worker launch. The synchronous trusted registry
remains available; the new `process` and `reset` APIs return Promises.

Guest values, record metadata and byte allocations occupy one fixed
`maxMemoryBytes` arena. This guest-data bound excludes source/parser/AST, host
dictionaries, Worker/V8 heap and RSS. Source, tokens, AST depth, names and output
transfer also have separate closed bounds. Interpreted instruction/time checks
and parent termination bound construction, process and reset; the Worker supplies
scheduling and preemption. It is not an arbitrary-JavaScript security sandbox.
Current owner approval gates output, and `close()` fences authority immediately
but awaits actual Worker exit. Runtime resource grants remain separate. Generic
connectors, dependencies/assets, native privileges, total RSS and full S14
qualification remain open.

[Scoped four-lane local software evidence](receipts/2026-10-08-local-software.json) retains genuine OLD witnesses, the independent source review and matching public callers from the seven-package SDK (186 inputs, 411 installed files). The final Node-only consumer records seven checks and strict NodeNext/Bundler types. All four checklist rows and broader qualification remain open; final candidate gates have separate retained evidence.
