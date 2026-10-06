# Device SDK release contract

Contract revision 1, 2 October 2026. This defines C01–C08 for the [master checklist](MASTER-CHECKLIST.md). The owner authorized implementing the complete checklist in the current local checkout. This contract defines acceptance; no distributed or live release is approved.

## Scope and matrix

The [support catalog](support-catalog.json) is the machine-readable matrix. A row identifies OS/version, runtime/version, form factor, transport, connector/version, profile/schema/codec, resources and unavailable features. Its implementation, contract, runtime and physical evidence are independent arrays. Empty means unverified, never implied support. `unknown` combinations inherit nothing. `candidate` identifies work to qualify; `historical` preserves limited earlier receipts; `embedded` describes the implemented single-process scope. Only `qualified` plus `accepted: true` denotes a current release claim.

Current implemented scope is `@101/connect` 0.1.0 with descriptor schema 1, boolean/scalar/vector/enum values, in-process routing and a bounded general peer resource bridge. Foundation source/tests are at `32e0e37`; subsequent exact peer/binding sources and local Chromium/WebKit runtime receipts are linked through the catalog. The actual current harness uses Node 24.14.0 on macOS 26.5.2 (25F84). The package engine floor is Node 22.13.0, but floor qualification is open under Q07/Q10. No full browser, native, gateway or physical combination is yet qualified for the new SDK. The 101 v2 and input-q1 receipts remain historical, separately cataloged.

| Required candidate | Versions to qualify | Form/resource scope | Acceptance tasks |
| --- | --- | --- | --- |
| JS embedded/external | Node 22.13.0 and 24.14.0; TypeScript 5.9.3 | Independent pointer and sensor apps, packaged ESM/types | K01–K02, E01/E13, Q02/Q07/Q10 |
| Browser application | Chromium/Chrome, Firefox and Safari/WebKit: exact installed build frozen in each receipt | Desktop/phone/tablet; keyboard, pointer, touch, gamepad; permissioned camera/mic and supported chooser APIs | N02, T07/T14, V, U09/U13, Q07–Q10 |
| Apple phone/tablet | iOS/iPadOS 26.5; exact hardware/OS build in receipt | iPhone 16 Pro first physical source; iPad remains unverified; touch/pen, motion, permissioned camera/audio | N04/N13, T08, I, V, Q08–Q10 |
| Android phone/tablet | Android 13 on OnePlus IV2201 first; API 36 emulator is separate | Touch/motion and permissioned camera/audio/Bluetooth; no inferred sensor inventory | N03/N13, T08, I, V, Q08–Q10 |
| Desktop OS agents | macOS 26.5.2; Windows 11 24H2; Ubuntu 24.04 LTS with named X11/Wayland compositor/portal | Permissioned system pointer/keyboard; independent media/display resources | N05–N09/N14/N16, I12, Q04/Q08/Q10 |
| Watches | watchOS and Wear OS exact physical versions captured at enrollment; simulator versions are separate | Companion input, crown/buttons, selected permitted sensors, release/lifecycle | W01–W09, G16, Q08 |
| Receiver/closed platform | Android TV/browser receiver exact OS/hardware; console APIs only where permission is established | Application input/render surface; inaccessible native resources absent | N10–N11, V08, Q08 |
| Headless/gateway/peripheral | Named OS/firmware and selected first protocol profile in each A/W/N qualification record | HID/USB, BLE, serial/Modbus, MQTT, commissioned home bridge, IR, actuator, industrial, ROS, printer/media and typed sensors | A01–A16, N12/N15, W05–W06, Q03/Q08 |

The table sets required qualification work and version targets, not broad compatibility promises. Later supported versions are added as new catalog combinations with their own receipts. A candidate version unavailable here remains open; a simulator is never promoted to a physical result. The full 272-task vision remains required even if a smaller intermediate candidate is useful.

Browser versions are frozen from actual runtime readback, rather than a mutable label such as “latest”. Browser API availability is probed through the relevant provider; labels do not imply WebHID/WebBLE/WebSerial support, system input, background execution or permission. WebRTC direct LAN is the first transport; HTTPS identity/coordinator, relay and bounded WSS are separately qualified. WebTransport/QUIC stay candidates until T13's caller and measurements justify them.

## Workload and performance profiles

Performance claims are bound to a catalog row and a measured profile. The current catalog has **zero accepted rows**, so current supported capacity is zero routes, devices and sessions, with no phone-to-browser latency claim. A candidate target below is an acceptance budget, not a statement that the target has passed. New route types, fan-out, media, hardware or network conditions need their own profile and receipt before they acquire a performance claim.

| Profile | Route, device and session load | Sample, event and media load | Latency, loss and clock budget | Status |
| --- | --- | --- | --- | --- |
| P1 local browser pointer | One source and one receiver context on the same Mac; one WebRTC peer session; position and contact are two routes; fan-out one | Measured workload: 80 sequential position deliveries over 2.830 s (28.27/s), with at least 20 ms between inputs. Contact/release is exercised functionally, not as a sustained event-rate test. Zero media streams and 0 media bit/s. Negotiated ceiling is 60 position samples/s and 60 contact events/s, each at most 100 ms old. | Candidate SLO at the measured workload: mapped JS capture-to-DOM conservative upper P95 ≤25 ms, P99 ≤50 ms, clock-mapping uncertainty ≤5 ms, all 80 positions observed, no lost contact/release, and no injected packet loss. Audio/video skew is inapplicable. | Local diagnostic only; measured latency and rate below. The 60/s ceiling and impaired-network behavior are not throughput qualifications. |
| P2 physical phone pointer | One iPhone 16 Pro **or** OnePlus IV2201 source and one browser receiver; one direct-LAN session, the same two routes and fan-out one. Devices are tested separately, never inferred from each other. | Qualification target: 25 delivered position samples/s for a sustained session, contact/release up to 2 transitions/s, zero media streams and 0 media bit/s. The descriptor and grant still cap each route at 60/s and 100 ms age. | Proposed finger-to-pixel SLO: conservative upper P95 ≤80 ms and P99 ≤150 ms, clock-mapping uncertainty ≤5 ms; zero missed contact/release transitions or held output after loss. Baseline has no injected loss; a separate 1% packet-loss/30 ms jitter run must recover current position within 100 ms after traffic resumes. Audio/video skew is inapplicable. | Target only. T08, F06, F09 and F10 remain open. F02 provides selected instrumentation; there is no physical timing or impairment result. |

P1 was reproduced by `node tools/qa-pointer-ui.mjs chromium http://127.0.0.1:3003/pointer-lab` against a local production build from `b26f26a2538b56b70898f87cb574ac16881f8cc9` (built server SHA-256 `d621fbe18ec0a2b0bdf8afb3902fbee77670d88f522f53962bf83e30cb39930e`, QA script SHA-256 `a0d3f0a9a5559f99899095ac5c06258ec7c7311c4208815ddb44fcf88a6e5358`). Environment: macOS 26.5.2, Node 24.14.0, Playwright 1.61.1, Chromium 149.0.7827.55. Eighty of eighty mapped positions were observed with no page errors; conservative upper P50/P95/P99 were 4.97/11.71/13.20 ms, maximum 21.94 ms, maximum clock uncertainty 0.565 ms. These values start at browser JS capture and end at the DOM callback; they exclude physical touch, display scanout and energy/thermal cost. The script emits the per-sample distribution for reproduction. The 60/s cap, one unsent latest sample, 64 queued reliable events and transport byte ceilings are implementation bounds, not measured capacity. Contact edges, 60/s load, nonzero packet loss and physical sessions need their own measurements before qualification.

F03's [local pointer cost receipt](receipts/2026-10-05-f03-pointer-cost.json) measures the only compact fast codec currently implemented, `normalized-pointer/1`, with `QA_POINTER_COST=1` on the same application route. The 80 delivered position packets were 48 bytes each; during 2.821 seconds, all application data totaled 14,882 bytes in 134 messages, while the selected WebRTC ICE pair reported 21,656 sent bytes and 134 packets. The 6,774-byte difference includes transport/control overhead and cannot isolate SCTP, DTLS, IP or link-layer headers. Contact heartbeats accounted for 51 reliable JSON events and 10,506 payload bytes. The actual receiver negotiated compact position and JSON contact, both at 60/s and 100 ms age ceilings. Fourteen precision fixtures measured maximum normalized-coordinate quantization error `2.960465e-8`, within the declared `2^-25` bound. These are local Chromium costs, not physical phone, cellular, relay or sustained 60/s measurements.

### Subscribed runtime load tiers

The named `subscribed-runtime-load/1` software workload publishes three test
tiers: **16, 64 and 128 subscribed edges** across four independent
owner/application/session scopes. They use respectively four, four and eight
sources, one sink per edge, fan-out at most sixteen, one latest queued record per
edge, and eight actual pending native operations with at most two per scope.
Four fixed Node worker targets confirm bounded integer state effects. These
published test tiers do not promote accepted release capacity above zero.

Each run requests sixty sustained turns at a 20 ms interval, reports the actual
cadence, and requires current confirmed output on every admitted edge. It also
checks cross-tenant denial, overload without incumbent displacement, held-scope
isolation, recovery, real revoke/expiry cancellation and actual worker teardown.
Intermediate latest states may coalesce; receipts retain service, drop and late
effect accounting. This is a macOS 26.5.2 arm64 / Node 24.14.0 local software
qualification, with no network, physical input, media, memory/RSS, battery or
thermal SLO. See the [exact workload and reproduction](SDK.md#sparse-runtime-load-qualification).

## Roles and permissions

| Role | May do | Boundary |
| --- | --- | --- |
| Device/resource owner | Inspect owned resources; consent to named source/destination/operation/rate/duration; stop/revoke; approve transfer | OS/vendor permission and local safety limits still apply |
| Participant | Join an invited session; request routes; use granted operations/partition | Membership or pairing alone grants no resource access |
| Observer | Subscribe to explicitly shared telemetry/output | Cannot write/invoke or acquire exclusive control |
| Developer | Declare apps/resources/processors/routes and request access; inspect redacted diagnostics | App declarations and embedded callbacks are trusted host code, never remote authority |
| Connector/processor author | Publish reviewed pinned manifests/code and conformance evidence | Installation confers no native, network, filesystem or resource grant |
| Administrator | Manage workspace membership, sharing policy, quotas and redacted audit | Cannot bypass resource-owner consent or OS permission; removing membership revokes associated access |
| Operator | Configure/run services, rotate service keys, control admission and maintain redacted health | Cannot invent endpoint consent; relay/gateway plaintext access is declared by topology |

Each route binds both concrete endpoint registrations, peer identity, principal, application, session, operations, rate/age, expiry and generation. Source and destination grants are independent. Descriptor IDs, friendly names, discovery hints, QR possession and channel encryption are not a resource grant. Exclusive owners retain control while another request is pending. Revocation/loss/expiry releases held output promptly; reconnect obtains a new generation and rechecks authority. Native privileged resources use narrowly allowed IPC operations. Audit/history is scoped and redacted; live input creates no telemetry recording by default.

## Product information architecture

The player job is to find an application, understand what each device can provide, connect permitted resources to an application, and stop or change that use. The developer job is to inspect capabilities and diagnose a route without gaining extra authority. A device owner must be able to see and revoke what that device shares. The same object names and actions apply to browser, native and desktop clients; each client offers only capabilities it can actually expose. This is the U01 navigation and behavior contract. U02–U13 still own the screen implementation and qualification.

| Object | Identity, ownership and relationship | Lifecycle and source of truth |
| --- | --- | --- |
| Device endpoint and resource | An endpoint has a stable local identity, current registration and owner. Its resources are typed descriptors scoped to that registration, with advertised capabilities rather than implied OS permission. | Discovery candidate → identified → authenticated → unavailable/available; owner-controlled registration and descriptor are authoritative. A stale registration is not a live device. |
| Invitation and connection | An invitation names a proposed session and expires. A connection binds authenticated endpoints, principal and session; membership is distinct from resource access. | Offered → accepted/declined/expired → connecting → connected/interrupted/closed. The session authority, not the URL or QR code, determines current state. |
| Grant and route | Separate source and destination grants bind owner, principal, application, resource, operation, limits, expiry and generation. A route names its source, optional processors and destination. | Requested → consented/denied/expired; a route is pending → active → interrupted/stopped/revoked. The owning endpoint and route authority decide effective access. No refresh, reconnect or copied link revives an expired grant. |
| Application and settings | An application declares accepted resources and outputs; its manifest is capability metadata, not permission. Settings belong to a local identity, device or explicitly scoped workspace policy when that exists. | Installed/available/unavailable application and current local preferences are authoritative; there is no assumed global account directory or cross-device settings sync. |

| Surface and target location | Job, actor and permitted action | Navigation and recovery |
| --- | --- | --- |
| Play `/`, application details `/games/:id`, running application `/games/:id/play` (present) | Player chooses an application from its manifest and starts only with supported inputs; an owner may stop an active route. | Primary Play destination; details lead to play and back to Play. Missing capability explains the alternative or returns to the catalog; exit and stop remain visible during use. |
| Devices `/devices` (present), device details `/devices/:id` (target) | Owner inspects local/connected endpoint identity, freshness, resource availability and permission; participant sees only an endpoint shared into their session. Owner can add, forget or inspect their device. | Primary Devices destination; add opens a connection task, details return to Devices. No device, unknown/partial discovery, denied OS access and offline state each retain retry, manual method or return. Forget previews the affected connections and grants. |
| Connections `/connections`, connection details `/connections/:id` (target) | Participant requests a connection and permitted source-to-destination route; both resource owners consent to their side. Any current owner can stop their grant. | Enter from Devices, application input choice, or a current connection. Details show participants, source, destination, limits and status; back returns to the entry context. Waiting, mismatch, declined, timeout, interruption and conflict allow cancel, change selection, retry or stop. |
| Sharing `/sharing` (target) | Owner reviews recipients, exact resources/operations, duration and current grants; approves, declines, partitions or revokes. Observer sees only explicitly shared output and has no write action. | Enter from Devices/details or an active connection. Pending requests and active grants remain separate. Revocation previews affected routes, confirms scope, then shows the stopped result; a failed revoke stays visible and retries safely. |
| Settings `/settings` (target) | Local identity owner manages permissions, privacy, trusted connectors, installed providers, device removal and restore where supported; admin policy has its own explicit scope and cannot override consent. | Enter from player chrome and return to prior task. Permission denial links to the relevant OS/browser recovery; removal previews local data and active routes. Unsupported options are explained, not shown as available actions. |
| Studio `/studio` and its labs (present) | Developer inspects diagnostics, manifests and redacted route state; resource use still requires owner/OS permission. | Separate developer door and navigation, with explicit return to Play. Deep links preserve their diagnostic context; a failed probe has a stop/retry path and cannot silently start control. |
| Controller `/controller` (present) | Invited participant supplies the granted controller inputs to one session. | Opened by invitation, outside player chrome; expired/invalid invitation explains how to request a new one. Disconnect releases held input and offers re-entry or exit. |

Today the player rail and phone tab bar expose Play and Devices; Devices has local capability display and a 101 controller invitation, while Studio has its own rail. The target Connections, Sharing, Settings and device/connection detail routes above are **not implemented destinations**. They enter primary or contextual navigation only as their U02–U12 flows become usable; empty tabs and links to nonexistent pages do not satisfy this contract. Native, watch and TV clients use the same jobs and permission boundaries, with navigation adapted to their supported inputs and screen area rather than copied browser chrome.

The connection journey has one accountable transition at each step: (1) participant discovers or manually enters an invitation; (2) endpoints identify and authenticate; (3) participant chooses a named application, source and destination from manifest/descriptor-compatible options; (4) each owner reviews the exact operation, recipient, rate and duration and grants only their side; (5) route shows connecting, active use and a visible stop; (6) stop, expiry, owner revoke, disconnect or app exit releases held output and updates every affected view. Back or cancel before consent leaves no grant. Duplicate acceptance cannot create a second route. Offline discovery retains manual entry; stale descriptors require refresh; incompatible resources return to selection; denied OS permission gives local recovery; expired invitations require a new invitation; reconnect reauthenticates and obtains a new generation; competing exclusive control shows the current owner and request/decline path. A deep link selects a view or request only, never grants access.

For every surface above, loading preserves its title and cancel/back control; empty state says what can be added; partial/stale data is labeled without offering unsafe actions; denied and offline states name the next local action; expired/conflicting requests return to selection; active routes show recipient and stop; stopped/revoked routes clear held input and show the result. Async requests distinguish waiting, success, failure, cancellation and expiry. Status is readable and announced, focus moves to the resulting heading or actionable error, keyboard controls equal pointer/touch controls, and reduced-motion preference is honored. No assistive-technology detection changes what actions exist. U02–U13 must verify these outcomes on their implemented and qualified surfaces before their rows close.

## Data retention and storage contract

Persistence is opt-in per data purpose, owner and destination. A route, pairing, diagnostic view or permission prompt never opts a user into recording. Local browser, native and desktop stores belong to their respective app/device owner; there is no implicit cross-device sync or remote backup. Clearing site/app data can erase local identity and preferences. Restoring files or reinstalling an app never restores an active grant: the owner must enroll and consent again. A future hosted store needs its own declared owner, region, access, retention and deletion policy before use.

| Data | Storage and retention decision | Current implementation and qualification boundary |
| --- | --- | --- |
| Endpoint identity | Persist one app-origin identity until explicit removal or app/site-data clearing. Keep private key material in browser nonextractable WebCrypto/IndexedDB or the native OS key store; store only public metadata outside it. Identity removal invalidates captured signers and requires re-enrollment. Do not copy keys into telemetry, exports or application backups. | Browser `createWebCryptoIdentityStore` uses IndexedDB; iOS uses device-only Keychain, Android AndroidKeyStore. The older 101 controller device ID is a separate convenience ID in browser session/local storage or native SecureStore, not an SDK signing key. Native physical lifecycle/backup behavior still needs N/T qualification. |
| Invitations, pairing and route grants | Invitations and scoped route grants live in memory through their explicit expiry and are discarded on revoke, disconnect or process exit; new generations need new consent. A resume credential may persist only for its exact session/endpoint through the ticket expiry, and an expired credential must be rejected and removed at next read. Never treat a remembered code, device ID, profile or backup as resource authorization. | The browser keeps an expiring Hub host token in localStorage and removes it when read after expiry. The native 101 controller stores its last pairing ticket in SecureStore as a reconnect convenience; next read rejects expired/malformed tickets and removes them when the keychain permits removal. Failed removal still returns no usable credential and retries on a later read. Its single owner serializes reads/writes so old cleanup cannot erase a replacement. [Local software evidence](receipts/2026-10-06-pairing-recovery.json) includes native compilation; physical keychain execution, every lifecycle path and remote grants remain S/B qualification work. The local Hub's sessions are in memory. |
| Profiles and configuration | Versioned connector/resource profiles and game manifests are reviewed artifacts, not user permission. Owner-selected layouts, handedness, setup choices and Hub settings may persist locally until reset or app-data deletion; keep secrets and live samples out of these records. Stores must be owner-scoped with explicit removal and migration behavior before qualification. | The SDK owner settings store supplies bounded preference/profile records, atomic IndexedDB writes, declared v1-to-v2 migration, corruption recovery and unavailable-device pruning; see [settings contract](SDK.md#versioned-owner-settings). Legacy browser localStorage/sessionStorage and desktop Hub `settings.json` are separate formats. Cross-device sync, full configuration backup/restore and native migrations remain unqualified. |
| Live payloads and telemetry | Default retention is **zero recorded samples, frames, audio, commands or location history**. Processing may hold only bounded in-memory queues/windows needed for the live route; discard them on expiry, stop and process exit. Explicit telemetry consent is per owner, resource, fields, destination and purpose; cap local history at 7 days from trusted ingest and 50 MiB per owner, dropping old records under pressure without delaying controls. No offline upload or remote forwarding without separate opt-in. | The [bounded telemetry API](SDK.md#opted-in-telemetry-history) records only separately approved scalar/boolean/enum samples, with smaller fixed producer quotas, trusted ingestion expiry and separately granted upload. Live routing does not create it. The [managed owner engine](SDK.md#managed-owner-data) adds authorized export/deletion and registered local-copy removal for its selected namespaces. Legacy stores, unmanaged/uploaded copies, sensitive wearable data and recorded media remain B05/S15/V11/W08 work. |
| Replays and audit | A replay requires an explicit save action and owner-visible delete; it is never created by live routing alone. Redacted security audit may record who granted/revoked access and when, never secrets or raw payloads; target retention is 30 days from trusted event time. Export/deletion is owner-scoped and must propagate to derived copies. | The managed owner engine retains bounded redacted deletion/expiry audit for 30 days and removes its registered derived copies. It supplies no general security audit service. Desktop Hub has an explicit replay file path capped at 16 MiB per file, but no expiry/delete/quota contract enforcement; it remains unqualified under B05/S15/V11. |

Store versions, owner scope and trusted ingestion timestamps must be recorded with any future persistent history. Failed, corrupt or unknown-version records fail closed and cannot revive authority. B03/B06/O06 must prove migration, isolation, backup exclusion or restore behavior and recovery on disposable storage before support acceptance. These are contract decisions for B01; the open implementation and physical rows below still govern release claims.

## Public names and compatibility

- `@101/device-model`, `@101/device-runtime`, `@101/connect`, `@101/transport-webrtc` and the first provider/binding package `@101/device-web` use the public working namespace, version 0.1.0. Public JS/type/schema distributions are K01 work; current TypeScript workspace exports are explicitly not an installable release.
- Existing `@101/sdk`, 101 protocol v2, controller roles and `input-q1` retain their public behavior. New platform packages do not import game/session/input code. The 101 bridge imports the general layer, never the reverse.
- Descriptor schema 1 stays closed and immutable; changes to required fields, meaning, ranges/units, frame or operation semantics require a new incompatible revision. Namespaced extensions remain inert data. Unknown operations/types/codecs reject with a recoverable incompatibility result.
- Schema/profile/codec IDs are exact namespaced IDs with positive integer revisions. Wire protocol revision is independent from package semver. A peer must negotiate all relevant revisions before resource use; old bytes never enter a new profile or epoch.
- Compatible additions use optional negotiated features and fixtures for both directions. Experimental 0.x APIs may evolve only with a documented migration and tests preserving currently accepted consumers. Before a stable 1.0 release, deprecations carry replacements, migration fixtures and at least one minor release of coexistence. Security revocation can stop unsafe versions immediately with a documented recovery path.
- No automatic lossy conversion, asset download, extension execution or arbitrary URL fetch is introduced by a description. Converters/processors are pinned, explicit, independently granted consumers.

## Migration and write ownership

The active integration controller of this checkout is the single write owner for schemas, root package/lockfile/tsconfig, generated assets, central ledgers, release manifests and qualification decisions. A disjoint lane may propose files; it cannot integrate shared state or commit behind the controller. The predecessor controller retains history and no repository write authority.

| Boundary | Owner and first tested caller |
| --- | --- |
| device-model/runtime/connect and generated descriptor schema | Integration controller; `examples/device-pipelines` and model/runtime/boundary tests |
| reusable peer transport | Integration controller; 101 WebRTCTransport regression before adopting it in the general bridge |
| general resource codecs/binding | Integration controller; independent remote pointer/sensor caller plus adversarial loopback and actual peer-runtime tests |
| 101 application translation | Integration controller; existing protocol/session/controller tests and all declared game controls |
| browser/native providers | Disjoint implementation lane allowed after contract freeze; independent pointer caller and platform-specific denial/lifecycle checks |
| connector/processor packages | Disjoint reviewed profile lane; actual independent resource consumer and conformance/physical receipt before support |
| support/task evidence, QA and release artifacts | Integration controller; `node tools/audit-platform-records.mjs` and repository gates |

Migration order is C → general T/M/S/I vertical slice → D/U → bounded N/A/W/P → S/V/R/B → E/F/Q throughout → G/K/O/L/Z. Preserve old consumers while bridging actual producers. Each new package must land with a runnable first caller and meaningful check; do not create speculative empty packages. Changes to a qualified boundary reopen affected catalog/task qualification and regenerate artifacts once after inputs settle.

## Operator limits and responsibilities

O08 establishes this contract before any live service claim. **Accepted service
capacity remains zero** because the support catalog has no accepted rows. The
limits below are enforced admission ceilings for the selected disposable local
Node coordinator/directory. They are not sustained-throughput, latency, regional
availability, physical-device or Internet capacity measurements.

| Selected component | Enforced ceiling / traffic budget | Unavailable scope |
| --- | --- | --- |
| Provisioned TLS coordinator | 64 enrolled identities, 16 exact HTTPS origins, 32 native connections; 32 requests/second per enrolled principal; 4 pending requests per caller | Public account/enrollment service, shared production hosting and regional failover |
| Private rendezvous | 16 sessions total, 4 sessions per principal, 8 peers per session, 16 peers per principal; session TTL at most 600,000 ms | Persistent sessions or automatic authority restoration |
| Coordinator HTTP | 401,024 bytes per request/response; 400,000 signaling characters; request timeout 5,000 ms and header timeout 3,000 ms | Unlimited signaling, arbitrary URL/proxy forwarding or a payload archive |
| Private directory | 32 provisioned catalog resources; 16 visible resources and 8 members per session; 8 capability selections per resource; 8,192-byte requests, 65,536-byte responses, 60,000-ms directory TTL | Visibility as a resource-operation grant or unrestricted device scanning |
| Relay in `fixed-coordinator-directory/1` operator configuration | Disabled: zero relay sessions, bytes and allocated credentials; relay configuration fails closed | Combined coordinator/directory/relay harness and Internet/TURN hosting |
| Separate `authenticated-loopback-gateway/1` | 8 enrollments, 4 pairs, 12 native connections, 16 lifetime allocation attempts, 1 pending allocation; 15,000-ms credential/service lifetime; 3,000-ms pair wait/handshake; 8,192-byte messages, 4 queued messages/leg, 1 unsettled raw write/leg, 16,384 buffered bytes/leg, 262,144 traffic bytes/pair | End-to-end payload encryption, operator sandbox, public enrollment, two physical networks and relay throughput/latency qualification |
| Explicit identity replacement | 16 lifecycle attempts, one pending operation; replacement startup requests teardown after 5,000 ms; actual native teardown retains its reservation until settlement | OS key storage, in-place live migration, persistent account recovery or fleet rotation |

These values come from `HTTPS_COORDINATOR_LIMITS`, `PRIVATE_DIRECTORY_LIMITS`
`OPERATOR_IDENTITY_LIFECYCLE_LIMITS` and the separately selected
`AUTHENTICATED_LOOPBACK_RELAY_LIMITS`. The [local startup/harness
receipt](receipts/2026-10-06-operator-filesystem-artifact.json) records genuine
mTLS startup, directory access, quota rejection and teardown. Configuration
selects the fixed ceilings; it cannot increase them. The separate gateway has its own explicit admission, traffic, expiry, failure
and native-settlement budgets. It does not enable relay in the existing operator
configuration. Future providers must establish those budgets before becoming
enabled options.

The operator is trusted to provision the server/CA/client identities, enrollment
snapshot, exact origin list and private catalog. The coordinator terminates mTLS
and can inspect its permitted rendezvous/directory metadata; this is the actual
trust topology. TLS identity and session membership do not authorize a device
operation. Device owners independently approve exact resource, recipient,
application/session, operation, direction, limits and expiry. A caller must not
forward credentials to another endpoint or infer permission from a directory,
name, invitation or successful connection.

The operator must protect provisioned private keys and any chosen persistent
backend using the applicable OS/account access controls. The current library
accepts explicit host inputs and provides no OS key store or persistent backend.
The disposable harness creates only new private credentials and removes its
owned temporary directory on normal teardown. Logs and health snapshots contain
bounded redacted operational metadata, excluding keys, certificates, session
bearers and private resource payloads. No retention/export/deletion claim extends
to unmanaged logs, uploaded copies or recorded media; the declared data policy
and B/S/V qualification tasks govern those separately.

Maintenance requires an inventory of exact build/profile/identity generations,
current owners and accepted support rows. Before an upgrade, changing trust,
origins, quotas or providers reopens affected qualification. Validate the exact
candidate, reject unsupported configuration and preserve failed receipts. A
credential incident requires stopping affected authority, removing compromised
enrollments and provisioning a fresh reviewed owner. Successful replacement
retires the old native owner before publishing the new endpoint; sessions,
directory membership, bearers and resource grants are never copied. Consumers
review the replacement endpoint and obtain fresh resource approvals. A failed
candidate preserves a still-valid incumbent; terminal stop requires a fresh
lifecycle and cannot resume discarded authority.

Operators must expose overload/expiry/unavailable states with bounded admission
and recovery, and keep an unresolved native operation reserved until actual
settlement. Normal cleanup does not prove recovery after SIGKILL, host failure
or an irreversible already-issued effect. Stop/revoke receipts must distinguish
requested teardown, actual native closure and verified data removal. Backup,
restore, upgrade/rollback and incident drills remain O04–O07 and their dependent
security/data tasks; this responsibility contract does not certify those drills.
Owned contacts, signing, distribution, service operations and any live action
remain L04–L07 authorization/qualification work. No endpoint, reporting contact,
on-call coverage or live maintenance service is invented here.

## Evidence and final acceptance

[task-evidence.json](task-evidence.json) contains every stable checklist ID, its dependency IDs, equipment and receipt references. The checklist checkboxes remain authoritative. Each receipt records source/build identity, environment, reproduction, outcome, scope, preserved failure and equipment; relevant physical/performance detail follows the [qualification envelope](MASTER-CHECKLIST.md#qualification-evidence-envelope-required-per-support-row). Use immutable commit/build/hash references. `pending` or `unavailable` is explicit and never closes a task. One receipt can prove multiple tasks only if it states each exact scope. Runtime/emulator and physical levels remain independent.

Run `node tools/audit-platform-records.mjs` after each ledger change. It verifies task coverage, stable IDs, dependencies, links, tally and evidence levels, rejecting current acceptance from historical receipts. Current acceptance also binds each receipt to an exact immutable target snapshot; a changed OS/runtime/device/connector/profile/codec/resource combination invalidates it. Passing task evidence retains nonempty receipt links and declared evidence levels. A pass audits records; it does not perform or certify their claimed hardware tests. The [qualification template](QUALIFICATION-TEMPLATE.md) supplies the full physical/runtime evidence envelope.

The final candidate must satisfy all Z tasks and all required predecessor rows, with exact packaged artifacts, target/version matrix and passing source/contract/runtime/physical/security/performance/accessibility evidence. Freeze one revision; every commit passes TypeScript, lint, unit tests and rendered checks against a fresh build when source changes. A required missing target, failed permission/isolation/release/upgrade/security case, stale output, unbounded resource use, corrupted semantics or inaccessible required journey blocks release. Repeated flakes must be resolved, not averaged away.

Supported lifecycle includes attach, denial/cancel/retry, loss, reconnect, background/lock/process death within OS limits, ownership conflict/transfer/expiry and teardown. Required outputs stop safely on loss; interrupted/non-idempotent effects remain explicitly unverified. Performance claims include capture-to-output distributions with clock uncertainty and complete payload/load/energy conditions. No receipt substitutes ping for finger-to-pixel or a hardware label for capability probing.

Security maintenance uses versioned disclosures, reproduced negative tests, affected-version/catalog reopening, prompt unsafe-grant/key/package revocation and validated update/rollback. A stable release includes a real reporting contact and owned update channel under L02/L04; inventing a mailbox or live service is not permitted. Operator obligations and supported load are O08 gates. Current local-only policy persists through L04. L05 presents concrete accepted artifacts, owned destinations and exact external actions for explicit authorization; L06–L07 and Z06 stay open until actual authorized publication and consumption succeed.
