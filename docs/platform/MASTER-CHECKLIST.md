# SDK and system master checklist

Updated: **5 October 2026**. Source baseline: **`576202b`**. This is the canonical task ledger for the full platform vision and the 101 reference application.

**Outcome:** a documented, secure, extensible SDK and complete reference system that developers can install outside this repository, use across the declared device/runtime matrix, extend with connectors and processors, and release with reproducible evidence.

**Snapshot tally:** 272 tasks — 89 completed with recorded evidence; 183 open. The checkboxes are authoritative as work progresses.

## How completion works

- `[x]` means the exact deliverable has evidence linked here. `[ ]` means it remains open, including partial implementations and tests that have not run. Historical receipts prove only their recorded scope.
- Each row has a stable ID, deliverable and acceptance condition. Before coding a subsystem, create its bounded implementation plan with exact interfaces, files and failing/passing tests. Do not create empty packages for every device or protocol.
- The integration agent maintains this ledger, implements and runs available checks, and records receipts. People, external accounts or absent hardware are dependencies; they are not silently replaced by simulations.
- To close a row, link its commit, tests and applicable runtime/physical receipt. If an implementation changes, reopen affected qualification rows. Preserve failed evidence and the regression that repaired it.
- A release claim covers named **connector + profile + runtime + device/firmware versions**. Extensibility supports new device families; it does not establish that every manufactured product is compatible. Closed/proprietary targets need a permitted API or gateway and an explicit supported/unsupported result.
- All full-vision workstreams below remain in this ledger. A smaller release can be labeled with its accepted scope; it cannot mark the full vision complete. Research candidates need qualification before becoming support claims.
- Publishing readiness and actually publishing are separate gates. Current repository policy permits local work; this checklist does not publish, deploy, push, add external services or create preview URLs.

## First execution order

1. **C01–C08:** freeze the support/evidence rules, reconcile prior receipts and map package ownership.
2. **T01–T14**, with required **M**, **S**, **N** and **I** tasks: implement the general transport bridge and prove physical phone → browser application pointer while preserving 101.
3. **D** and **U:** expose discovery, sharing, connections and conflict/recovery through a complete product flow.
4. **N**, **A**, **W** and **P:** add OS agents, qualified gateways, wearables and independent processors in bounded lanes.
5. **S**, **V**, **R** and **B:** finish global sessions, media, coordinated workloads and opted-in data services.
6. **E**, **F** and **Q:** finish developer authoring, measured performance and conformance qualification throughout the preceding stages.
7. **G**, **K**, **O**, **L** and **Z:** finish 101 acceptance, release artifacts, operations, publication readiness and final sign-off.

Sections are workstreams, not permission to skip their dependencies. Security, accessibility and disconnect behavior belong in each implementation, with final checks repeated on one frozen candidate.

## Workstream dependencies and code ownership

| Workstream | Depends on | Existing boundary / proposed first caller |
| --- | --- | --- |
| C — contract and evidence | Current inventory | This ledger; platform design; QA and support records |
| H — embedded foundation | Completed at baseline | `packages/device-model`, `device-runtime`, `connect`; `examples/device-pipelines` |
| M — model evolution | C, H | Model/runtime; versioned schemas; first structured resource caller |
| T — transport and 101 bridge | C, H; relevant M/S/I | `packages/protocol`, `pairing`, `session`, `link-controller`; first `transport-webrtc` and `device-web` consumers |
| D — discovery | C, T, S | Browser/native choosers, pairing, scoped directories |
| S — security and global sessions | C, H, T | Pairing/Hub; new identity/coordinator boundary with local integration harness |
| N — OS/runtime providers | C, H, T, S | `apps/controller-native`, `apps/desktop-hub`; shared native provider contract |
| I — input and feedback | M, T; relevant N | Existing input adapters and controller layouts; general typed input profiles |
| V — media and surfaces | M, T, S, N | Camera/audio/render paths; authorized track and surface callers |
| A — gateway connectors | M, T, S; relevant N | `packages/hardware`, HID/BLE/serial; selected `connector-*` with a real profile |
| W — wearables | M, T, N, A | Existing watch companions; selected BLE/vendor profiles |
| P — processors | M, T; relevant V/W/A | `packages/vision`, `motion`; independent `processor-*` callers |
| R — coordinated workloads | M, T, S, N, V/P | Route groups and snapshot-aware application host |
| B — persistent data | M, T, S | Explicit telemetry/history/job caller; no default recording |
| E — developer ecosystem | M, T, S, N/P/A | Facade, schemas, scaffolder, recipes, package verification |
| U — product experience | C, D, S, T; relevant N/I/V/E | `app/devices`, launcher, native app, desktop agent, Studio; optional shared UI package |
| F/Q — performance/qualification | Each implementation | Diagnostics, fault harnesses, support matrix and exact candidate receipts |
| G — 101 acceptance | Compatible T bridge; relevant changes | Existing games, native controllers, cameras and physical runbook |
| K/O/L/Z — release/operations | Required implementation and qualification | Packaging tooling, operator runbooks, candidate manifests and release approvals |

### C — Release contract, support scope and evidence

- [x] **C01 — Define the release matrix.** Name supported OS/runtime/browser versions, form factors, transports, connectors, profiles, resources and explicit unavailable features; every claim resolves to a qualification row. [Contract evidence](CONTRACT-QA-2026-10-02.md).
- [x] **C02 — Create the machine-readable support catalog.** Store implementation, contract-test, runtime-test and physical-verification levels independently, with versioned evidence references; unknown devices remain unknown. [Contract evidence](CONTRACT-QA-2026-10-02.md).
- [x] **C03 — Reconcile historical 101 status.** Update stale dispositions using the chronological 1 October receipts; retain earlier failures and distinguish old smoke results from final candidate acceptance. [Contract evidence](CONTRACT-QA-2026-10-02.md).
- [x] **C04 — Define roles and permissions.** Document device owner, participant, observer, developer, connector author, administrator and operator actions; no administrator bypasses resource-owner or OS permission. [Contract evidence](CONTRACT-QA-2026-10-02.md).
- [x] **C05 — Freeze public naming and compatibility rules.** Define package names, schema/profile/codec versions, stability guarantees, deprecation and migration behavior; existing `@101/sdk` callers continue to work. [Contract evidence](CONTRACT-QA-2026-10-02.md).
- [x] **C06 — Map migration and write ownership.** Assign each shared schema, lockfile, generated artifact, integration boundary and evidence ledger one owner; every new package has a tested first caller. [Contract evidence](CONTRACT-QA-2026-10-02.md).
- [x] **C07 — Establish per-task evidence records.** Record source/build, environment, reproduction, result, failure and required equipment for each row; skipped and unavailable checks remain open. [Contract evidence](CONTRACT-QA-2026-10-02.md).
- [x] **C08 — Define final acceptance and support policy.** Specify required profiles, supported life cycles, security maintenance and release-blocking failures; approve a named scope rather than an unrestricted compatibility claim. [Contract evidence](CONTRACT-QA-2026-10-02.md).

### H — Embedded foundation already completed

All H rows are proven at `32e0e37` by [foundation QA](FOUNDATION-QA-2026-10-01.md), [SDK guide](SDK.md) and their linked source/tests. They verify providers in one process.

- [x] **H01 — Independent model/runtime/facade packages.** `@101/connect` imports without game dependencies; dependency-direction checks pass.
- [x] **H02 — Typed initial values and semantics.** Boolean, scalar, x/y[/z] vector and enum values retain declared unit, frame, range and semantic version.
- [x] **H03 — Bounded immutable descriptor parser.** Byte/depth/count limits and malformed, getter, prototype, cyclic, duplicate and nonfinite cases are tested.
- [x] **H04 — Generated descriptor editor schema.** Structural fixtures pass and checked-in schema matches its export; parser-only limits are annotated.
- [x] **H05 — Identity-bound endpoint registrations.** Forged handles fail; readiness and resource removal govern routes.
- [x] **H06 — Host-authorized routes.** Both source and sink operations bind concrete resource references to principal, application and session.
- [x] **H07 — Ownership and expiring leases.** Exclusive, observer and partitioned policies exist; wrong-owner renewal and scoped release are tested.
- [x] **H08 — Bounded delivery lanes.** Latest replacement, reliable counters/deadlines, rate/age intersections and overload/replay behavior are tested.
- [x] **H09 — Async cancellation and historical evidence.** Revocation releases immediately; unresolved work remains bounded and late evidence retains bounded history.
- [x] **H10 — Application pointer example.** Normalized coordinates map to a resized surface; exclusive ownership transfers after release.
- [x] **H11 — Sensor/processor/feedback example.** Celsius, hysteresis, independent route grants, provenance, upstream loss and observed/unverified evidence are tested.
- [x] **H12 — Integrated baseline gate and review.** 503 unit tests, 31 rendered checks, TypeScript, lint, fresh build, examples and independent review passed at the recorded baseline.

### M — Complete device/resource model

- [x] **M01 — Structured signal schemas.** Add bounded records, arrays, timestamped batches and optional fields with a real consumer, version migration and malformed/oversized fixtures. [Structured-signal evidence](STRUCTURED-SIGNALS-QA-2026-10-02.md).
- [x] **M02 — Spatial schemas.** Define quaternions, poses/joints, transforms and reference frames; rotation, handedness and metric conversions preserve declared meaning. [Spatial-signal evidence](SPATIAL-SIGNALS-QA-2026-10-02.md).
- [x] **M03 — Rich input schemas.** Model contacts, pen, key transitions, text/IME composition, wheels and relative motion without collapsing events into replaceable samples. [Rich-input evidence](RICH-INPUT-QA-2026-10-02.md).
- [x] **M04 — Binary/document resources.** Define chunked bounded blobs, text/documents and typed asset references; size, integrity, content type and cancellation are verified. [Binary-resource evidence](BINARY-RESOURCES-QA-2026-10-02.md).
- [x] **M05 — Media/surface descriptions.** Define tracks, render targets, codecs, capture/output properties and geometry; unsupported resources cannot advertise a working route. [Media-description evidence](MEDIA-DESCRIPTIONS-QA-2026-10-02.md).
- [x] **M06 — Units and conversions.** Validate unit representation and explicit converters, scale/offset, precision and error budgets; incompatible measurements fail without silent normalization. [Unit-conversion evidence](UNITS-QA-2026-10-02.md).
- [x] **M07 — Calibration and quality.** Promote needed calibration revision, uncertainty, faults and stale/unavailable state into validated contracts; fixtures preserve producer meaning. [Measurement-quality evidence](MEASUREMENT-QUALITY-QA-2026-10-02.md).
- [x] **M08 — Clock and observation provenance.** Define remote clock identity, offset uncertainty, drift, capture/receipt timestamps and processor lineage; unsupported clock comparisons are rejected. [Observation-timing evidence](OBSERVATION-TIMING-QA-2026-10-02.md).
- [x] **M09 — Device health/resources.** Model battery, charging, thermal, firmware, connectivity and hardware faults as truthful readiness/telemetry with supported resource limits. [Device-health evidence](DEVICE-HEALTH-QA-2026-10-02.md).
- [x] **M10 — Property/action/event/job semantics.** Specify readable properties, subscriptions, set-state commands, non-idempotent operations and asynchronous jobs with distinct result/effect evidence. [SDK evidence](SDK.md#property-command-and-job-operations).
- [x] **M11 — Schema evolution and extensions.** Test unknown types/fields, compatible upgrades, incompatible revisions and preserved inert extensions; data cannot introduce executable authority. [SDK evidence](SDK.md#descriptor-revisions-and-extensions).
- [x] **M12 — Interoperable description import/export.** Implement a bounded WoT mapping with declared extensions and conformance fixtures; do not claim standard compatibility from a similar JSON shape. [SDK evidence](SDK.md#bounded-wot-thing-description-mapping).

### T — Transport bridge and 101 continuity: first implementation lane

- [x] **T01 — Write the transport-bridge spec and plan.** Freeze wire messages, resource binding, peer authority, reconnect epochs, limits, first callers and regression tests against the existing v2 path. [Transport evidence](TRANSPORT-QA-2026-10-02.md).
- [x] **T02 — Extract reusable peer transport.** Introduce the first `transport-webrtc` caller while preserving current reliable/disposable channels and existing 101 codecs/tests. [Transport evidence](TRANSPORT-QA-2026-10-02.md).
- [x] **T03 — Negotiate general resources.** Exchange bounded descriptors, schema/codec revisions, supported operations and effective route limits; incompatible peers get a recoverable rejection. [Resource binding evidence](RESOURCE-BINDING-QA-2026-10-02.md).
- [x] **T04 — Bind remote resources to authenticated peers.** Remote packets cannot choose arbitrary source IDs, sink registrations, sessions or permissions; cross-peer and cross-session fixtures fail. [SDK evidence](SDK.md#bind-a-remote-provider).
- [x] **T05 — Implement general wire codecs.** Use a versioned readable baseline and selected compact profiles; arbitrary sensor values retain units/ranges and are not encoded as game axes. [Resource binding evidence](RESOURCE-BINDING-QA-2026-10-02.md).
- [x] **T06 — Implement sample/event/control scheduling.** Apply freshness, sequences, epochs, deadlines, deduplication and bounded send queues; button edges and relative deltas survive loss policy correctly. [Pointer provider evidence](POINTER-PROVIDER-QA-2026-10-02.md).
- [x] **T07 — Implement generic browser/native provider binding.** A phone source and browser application sink use the new SDK end to end rather than a special game role. [Physical Android and browser evidence](POINTER-PROVIDER-QA-2026-10-02.md#5-october-2026-physical-android-update).
- [ ] **T08 — Prove physical phone → browser pointer.** Test iPhone and Android sources, both diagonal directions, contact/release, resize and no anchor; measure capture-to-render latency. [Partial phone evidence](POINTER-PROVIDER-QA-2026-10-02.md#5-october-2026-physical-android-update).
- [x] **T09 — Implement a compatible 101 application bridge.** Map approved typed resources to game controls/roles explicitly; new platform packages never import game code. [Pointer provider evidence](POINTER-PROVIDER-QA-2026-10-02.md).
- [x] **T10 — Verify disconnect and reconnect generations.** Loss releases held output; stale packets/commands cannot enter replacement routes; reconnect renegotiates ownership and formats. [Resource binding evidence](RESOURCE-BINDING-QA-2026-10-02.md).
- [x] **T11 — Add network impairment tests.** Loss, jitter, reordering, duplicates, queue saturation and slow receivers retain bounded memory and visible recovery. [Resource binding evidence](RESOURCE-BINDING-QA-2026-10-02.md).
- [ ] **T12 — Implement a secure WebSocket fallback.** Negotiate its delivery behavior and bounds; late interactive data is discarded instead of accumulating behind old messages.
- [ ] **T13 — Compare optional transport candidates.** Benchmark WebTransport/native QUIC only with a justified caller; retain or reject each using supported-runtime, security and end-to-end measurements.
- [ ] **T14 — Close stage 2 compatibility acceptance.** Non-game physical pointer, permissions, ownership, loss/reconnect and existing game/controller tests pass on one exact candidate.

### D — Discovery, identification and resource inventory

- [x] **D01 — Define discovery candidate/evidence types.** Separate observed, identified, authenticated, authorized and ready states; each candidate has scope, expiry and a recovery path. [Scoped receipt and SDK consumer evidence](receipts/2026-10-02-d01-discovery.json).
- [ ] **D02 — Integrate explicit invites and pairing.** QR, links, manual entry and enrolled-agent discovery identify the intended endpoint without turning an invitation into unlimited grants.
- [ ] **D03 — Integrate OS/browser choosers.** HID/BLE/serial/camera/audio selection remains permissioned; cancellation, denial, disappearance and retry produce recoverable states.
- [ ] **D04 — Add scoped native network discovery.** Implement supported mDNS/DNS-SD providers with cancellation, deduplication, quotas and expired-device removal.
- [ ] **D05 — Verify live capability inventory.** Selected resources are probed through their adapter/profile; model/vendor labels do not invent sensors, operating systems or control features.
- [ ] **D06 — Implement private remote directories.** Authorized users see only enrolled resources and allowed metadata; membership and resource access remain separate checks.
- [ ] **D07 — Support profile/manual resolution of unknown devices.** A reviewed profile or explicit configuration establishes semantics; unknown/unsupported states stay visible.
- [ ] **D08 — Support authorized gateway/router inventories.** Inventory APIs are explicit connectors; isolated networks and inaccessible equipment have documented limits and no unrestricted scanning.
- [ ] **D09 — Secure discovery metadata/links.** Bound parsing and rate, reject unrestricted URL fetching, redirects/credential forwarding and identity spoofing; discovery grants no operation.

### S — Security, identity and global sessions

- [x] **S01 — Persist the platform threat model.** Cover network peers, native privilege, packages, processors, directories, media, gateways and operators with assets, trust transitions and abuse cases. [Model location and evidence](SDK.md#platform-threat-model); `threat-model-2026-10-02` in [task evidence](task-evidence.json).
- [ ] **S02 — Implement endpoint identities and key storage.** Use established cryptographic/OS facilities; test enrollment, key loss, rotation, revocation and copied identity rejection.
- [ ] **S03 — Implement owner consent and scoped grants.** Bind source/destination, principal/app/session, operation, direction, rate, expiry and peer endpoint; deny unsupported scope.
- [ ] **S04 — Implement encrypted authenticated remote channels.** Verify peer binding and certificate/key failures; document the actual trust topology rather than assuming encryption grants access.
- [ ] **S05 — Build the HTTPS coordinator locally.** Authenticated create/join, restricted origins, private rendezvous and startup configuration checks pass disposable integration tests.
- [ ] **S06 — Implement membership/invitation lifecycle.** Expiring invitations, removal, reconnect and lost-device recovery cannot expose another participant's resources.
- [ ] **S07 — Implement direct and relay negotiation.** ICE/TURN or authenticated gateway fallback uses scoped short-lived credentials and records the selected path.
- [ ] **S08 — Prove two-network and relay-required sessions.** Physical endpoints on different networks connect, recover and revoke access; direct-only LAN tests cannot close this row.
- [ ] **S09 — Implement wire replay protection.** Test epochs, sequence windows, IDs/deadlines, revoked grants and stale schema/profile bytes at every receiver boundary.
- [ ] **S10 — Implement resource/tenant isolation.** Cross-user, cross-session and cross-directory requests fail; private audio/video/telemetry cannot leak to unintended subscribers.
- [ ] **S11 — Implement abuse and capacity controls.** Limit invitations, discovery, authentication, connections, rates, bytes, subscriptions, jobs and expensive processors per authorized scope.
- [ ] **S12 — Minimize native privileged APIs.** Use explicit allowed operations and IPC caller verification; descriptors/recipes cannot invoke arbitrary shell, filesystem or device operations.
- [ ] **S13 — Verify third-party publisher and package integrity.** Version/hash/signature policy, tampering, revocation, dependency substitution and rollback tests precede installed code activation.
- [ ] **S14 — Enforce plugin/processor isolation.** Resource grants, compute/memory/network limits and lifecycle teardown prevent installed extensions from acquiring additional privileges.
- [ ] **S15 — Implement privacy and audit controls.** Capture/sharing is visible, revocation is prompt, secrets/personal streams stay out of logs/caches, and retention/export/deletion follow the declared policy.
- [ ] **S16 — Complete independent security validation.** Review each frozen new trust boundary, repair reproduced findings, rerun affected negative tests and define incident/security-update procedures.
- [ ] **S17 — Implement workspace/team administration.** Create/manage membership, roles and resource-sharing policy with auditable changes; removal/revocation and delegated administration never bypass device-owner consent.

### N — OS/runtime libraries and native agents

- [ ] **N01 — Define the native provider contract.** Share descriptors, permissions, readiness, lifecycle, IPC and conformance with a real browser/mobile/desktop consumer.
- [ ] **N02 — Implement browser resource providers.** Keyboard, pointer, touch, gamepad, camera, microphone and supported hardware APIs expose typed resources with permission/loss recovery.
- [ ] **N03 — Implement Android native providers.** Inventory and expose selected motion, touch, audio/camera, Bluetooth and hardware resources; permission/background/lock behavior is qualified.
- [ ] **N04 — Implement iOS/iPadOS native providers.** Selected motion, touch/pen, camera/audio and external surfaces use permitted native APIs; denial, suspension and reconnect are qualified.
- [ ] **N05 — Implement macOS system pointer/keyboard.** Permissioned native events target the intended surface; denial/revocation, coordinate mapping, held-key release and lease transfer pass.
- [ ] **N06 — Implement Windows system pointer/keyboard.** Respect supported permission/integrity boundaries; test denial, desktop/screen mapping, release and reconnect on the target OS.
- [ ] **N07 — Implement Linux system pointer/keyboard.** Qualify supported portal/virtual-input paths and desktop sessions; permissions, revocation and release are tested per supported environment.
- [ ] **N08 — Implement desktop camera/mic/audio/display providers.** Each OS resource has independent grants, capture ownership, route changes and truthful capability inventory.
- [ ] **N09 — Implement external screens and multi-monitor geometry.** Screen selection, scale, rotation, safe area, unplug and changed coordinates preserve or safely stop the route.
- [ ] **N10 — Add qualified TV/receiver paths.** Implement selected Android TV/browser/Cast/AirPlay-style application receivers where permitted; demonstrate actual input/output behavior on representative hardware.
- [ ] **N11 — Establish console/closed-platform outcomes.** Research permitted runtimes/APIs, implement a viable receiver/gateway where available, and publish explicit unsupported boundaries where access is unavailable.
- [ ] **N12 — Support an embedded/headless runtime.** A selected Linux/MCU/gateway target exposes a typed sensor and command with bounded memory, disconnect policy and a tested client.
- [ ] **N13 — Enforce OS lifecycle behavior.** Background, screen lock, battery saver, process termination and permission revocation follow OS rules and expose recovery; they do not fabricate continuous access.
- [ ] **N14 — Qualify native agent IPC/update lifecycle.** Unauthorized local callers fail; crash/restart, agent version mismatch and upgrade release authority and recover predictably.
- [ ] **N15 — Implement dedicated terminal/SSH connectors.** Verify host identity and scoped credentials; allowed sessions/operations, bounded output, cancellation, reconnect and audit pass a disposable local host test.
- [ ] **N16 — Implement scoped clipboard/filesystem/app operations.** Explicit resource permissions, destination/path limits, sensitive-data handling and denied/revoked/cancelled operations pass an independent client test.

### I — Human controls, relative motion and output feedback

- [x] **I01 — Define reusable input profiles.** Pointer, keyboard, text, gamepad, touch, pen and accessibility resources declare event/sample semantics and supported control operations. [Profile contract](SDK.md#input-profiles) and [packed consumer evidence](receipts/2026-10-05-i01-input-profiles.json).
- [x] **I02 — Implement smooth relative trackpad input.** Accumulate bounded unsent deltas or publish recoverable targets; no coalescing loses movement, and lift/recontact introduces no anchor or jump. [Pointer driver and current browser evidence](POINTER-PROVIDER-QA-2026-10-02.md#relative-trackpad-acceptance--5-october-2026).
- [x] **I03 — Implement click/drag/scroll gestures.** Tap, press, drag, wheel and multi-finger scrolling have clear cancellation, pointer capture, rate and reliable transition behavior. [Selected browser source and packed consumer evidence](receipts/2026-10-05-i03-gestures.json); physical finger and ergonomic qualification remain separate.
- [x] **I04 — Implement independent multi-touch contacts.** Stable contact IDs, simultaneous actions, contact cancellation and orientation changes preserve intended ownership without stuck buttons. [Independent browser source and packed runtime evidence](receipts/2026-10-05-i04-touch-contacts.json); physical device/ergonomic qualification remains separate.
- [x] **I05 — Implement keyboard/text composition.** Key-down/up, modifiers, repeats, layouts and IME/text composition remain distinct; disconnect releases keys without corrupting text. [Browser source and independent packed caller evidence](receipts/2026-10-05-i05-keyboard-text.json); physical OS input-method/layout qualification remains separate.
- [x] **I06 — Implement pen/rotary/gamepad details.** Pressure/tilt, crown/encoder deltas, triggers, hats, axes and button edges preserve profile-specific ranges and calibration. [Calibrated processors and packed consumer evidence](receipts/2026-10-05-i06-input-details.json); physical device qualification remains separate.
- [ ] **I07 — Implement responsive control descriptions.** Pads, joysticks, sliders, toggles, gestures and buttons adapt to measured surface/input modes with equivalent accessible controls.
- [ ] **I08 — Implement haptic output profiles.** Declared patterns, intensity/duration limits, unsupported-device fallback and physical distinguishability are tested.
- [ ] **I09 — Implement input ownership and transfer UI.** Current owner retains control during a second request; consent, partition assignment and release produce visible, recoverable outcomes.
- [ ] **I10 — Verify handedness and ergonomic layouts.** Thumb reach, both hands, short landscape, safe insets and simultaneous inputs are physically tested across claimed form factors.
- [ ] **I11 — Support accessible input/output profiles.** Qualify selected switch/assistive HID and tactile/Braille resources plus keyboard equivalents; do not detect assistive technology to hide choices.
- [ ] **I12 — Prove release safety across all inputs.** Blur, hide, unmount, disconnect, role change, deadman expiry and process loss leave no held pointer/key/button state.

### V — Audio, video, screens and multiple outputs

- [ ] **V01 — Implement authorized media endpoints.** Camera, microphone, screen, application view and output tracks negotiate compatible formats and independent source/sink grants.
- [ ] **V02 — Separate media and control scheduling.** Large frames, adaptation and slow subscribers cannot starve pointer/events; bounds and cancellation are independently tested.
- [ ] **V03 — Implement audio capture/output routing.** Source and speaker/headphone destinations are explicit; private recipients, route changes, mute, volume and device loss are verified.
- [ ] **V04 — Support wired and wireless audio devices.** Microphone and playback capabilities are qualified separately; plug/unplug, Bluetooth route changes and latency/skew are recorded.
- [ ] **V05 — Implement camera selection and controls.** Camera ownership, supported focus/exposure/zoom/PTZ, switching, denial, unplug and retry expose only verified controls.
- [ ] **V06 — Implement adaptive encoded video.** Codec negotiation, bitrate/resolution changes, slow receivers, missing codecs and loss recover without unbounded buffers.
- [ ] **V07 — Implement screen/application streaming.** Capture consent, selected surface, resize, cursor/input mapping, privacy and capture-stop behave correctly.
- [ ] **V08 — Implement independent render views.** One authoritative application/simulation supplies multiple authorized displays without creating duplicate engines or leaking private view state.
- [ ] **V09 — Implement output sharing policies.** Audio mix/duck/exclusive, camera observers and app layers/regions are explicit policies with conflict and transfer tests.
- [ ] **V10 — Implement synchronization and uncertainty handling.** Audio/video/display clocks declare skew budgets; excessive drift/uncertainty degrades visibly instead of inventing synchronization.
- [ ] **V11 — Implement bounded recording/playback when enabled.** Consent, retention, seek, export, storage quotas and deletion are tested; live routing does not automatically record streams.
- [ ] **V12 — Qualify media topologies and hardware.** Direct, relay and selected gateway/SFU paths record actual encryption trust, private-recipient isolation, quality, recovery and thermal behavior.

### A — Wired, IoT, appliance, legacy and robotics gateways

Each connector row closes only after its first working profile, protocol fixtures and representative physical receipt pass Q requirements. Additional supported profiles create their own qualification rows.

- [ ] **A01 — Define connector/device-profile manifests.** Identity filters, framing/decoder, resources, units, permissions, calibration, commands, safe-state and feedback levels are versioned and reviewed.
- [ ] **A02 — Implement selected HID/USB profiles.** Reuse existing framing where valid; selected keyboard/controller/sensor reports and output writes expose general resources with attach/denial/unplug tests.
- [ ] **A03 — Implement selected BLE/vendor profiles.** Services/characteristics, notification/write behavior, permissions, packet validation and reconnection preserve resource semantics.
- [ ] **A04 — Implement serial/Modbus gateway profiles.** Framing, register meaning, scaling, CRC/errors, bounded retries and serial/TCP identity are explicit rather than guessed from raw bytes.
- [ ] **A05 — Implement MQTT telemetry/command connector.** Topic authorization, retained-message handling, QoS, expiry, duplicate commands and feedback semantics pass a local broker harness and device test.
- [ ] **A06 — Implement selected smart-home bridges.** Qualify Matter/Thread and a commissioned Zigbee gateway path with attribute/action/event mappings, enrollment and offline behavior.
- [ ] **A07 — Implement IR appliance gateway.** Versioned carrier/timing profiles and a nearby emitter receive remote scoped commands; emission remains distinct from target response or observed state.
- [ ] **A08 — Implement IR receive/learn where hardware permits.** Captured patterns are bounded and reviewed before use; unknown codes, noise and unsupported receiver hardware have truthful results.
- [ ] **A09 — Implement mechanical switch/relay gateway.** An actuator plus independent state/limit sensor demonstrates set-state, ambiguity, watchdog, local release and observed feedback.
- [ ] **A10 — Implement motor/servo/valve interface.** Qualified local limits, slew/deadman/interlock policy govern remote supervisory commands; reconnect cannot replay stale motion.
- [ ] **A11 — Implement selected industrial telemetry.** CAN/CANopen and OPC UA profiles preserve typed quantities, timestamps, quality and authorization in a representative gateway/target environment.
- [ ] **A12 — Implement ROS 2/robot connector.** Typed topics/services, QoS, command authority, local safety policy, source loss and feedback are tested with a representative robot or qualified simulator plus hardware receipt.
- [ ] **A13 — Implement printer/job gateway.** A selected IPP or legacy print-server profile provides bounded jobs, formats, status, ownership and cancellation without exposing unrelated printer resources.
- [ ] **A14 — Implement camera/DVR/NVR gateway.** Selected ONVIF/vendor/legacy capture profiles expose actual media, playback and supported controls with authorization and firmware-specific evidence.
- [ ] **A15 — Qualify further gateway candidates.** Research and record permitted first profiles for GPIO/I²C/SPI, NFC/RFID, legacy RF, HDMI-CEC, building automation, low-power radio and analog capture before implementation/support claims.
- [ ] **A16 — Demonstrate heterogeneous sensor semantics.** Representative motion, position/range, temperature/light/moisture, mass/force/flow, electrical and equipment telemetry retain units, calibration and fault quality through a real gateway.

### W — Watches, rings, bands and hearables

- [ ] **W01 — Generalize watch companion resource providers.** Existing Apple Watch/Wear OS paths bind selected capabilities to the new SDK without treating every watch as a generic socket.
- [ ] **W02 — Qualify physical Apple Watch → iPhone → host.** Install the signed companion; wrist/crown/button samples, paired identity, locality, release and reconnect have physical receipts.
- [ ] **W03 — Qualify physical Wear OS → Android → host.** Installed matching packages, sensor/input relay, identity, loss and reconnect have physical receipts.
- [ ] **W04 — Test wearable lifecycle and energy.** Wrist-off/background, companion departure, radio changes, stale samples and long sessions follow platform rules and measured battery/thermal bounds.
- [ ] **W05 — Implement a selected ring/band profile.** Document available vendor/standard resources and permissions; prove meaningful samples and feedback rather than inferring sensors from the form factor.
- [ ] **W06 — Implement a selected hearable/headset profile.** Audio, controls and any permitted sensors are independently qualified; unavailable vendor resources remain absent.
- [ ] **W07 — Implement wearable calibration and fusion inputs.** Orientation, mounting, handedness and calibration changes update provenance and reject stale profile generations.
- [ ] **W08 — Protect sensitive wearable data.** Separate consent, purpose, destinations and retention apply to any supported physiological resources; they are not automatically exported as game telemetry.
- [ ] **W09 — Publish exact wearable support outcomes.** Record model/firmware/runtime/profile versions, available resources and lifecycle limits; researched and physical-verified support remain distinct.

### P — Reusable algorithms and processor library

- [x] **P01 — Define processor manifests/registry.** Input/output schemas, units/frames, version, configuration, state/reset, asset/license and compute/privacy budgets resolve to pinned trusted code. [Contract](SDK.md#processor-manifests-and-trusted-registry) and [packed consumer receipt](receipts/2026-10-05-p01-processor-manifest.json).
- [x] **P02 — Implement graph validation.** Match typed ports and permissions; reject undeclared conversion, invalid cycles and unbounded feedback; explicit delayed feedback gets its own bounded tests. [Contract](SDK.md#processor-graph-validation) and [packed consumer receipt](receipts/2026-10-05-p02-processor-graph.json).
- [x] **P03 — Implement calibration/conversion/filter processors.** Selected transforms preserve units, time and uncertainty; fixtures cover saturation, invalid values, stale input and state reset. [Contract](SDK.md#scalar-measurement-processors) and [packed consumer receipt](receipts/2026-10-05-p03-measurement-processors.json).
- [x] **P04 — Extract pose/hand/gesture processors.** Existing camera algorithms become independent typed consumers with faithful producer fixtures, assets, calibration and quality behavior. [Contract](SDK.md#independent-landmark-processors) and [packed consumer receipt](receipts/2026-10-05-p04-landmark-processors.json).
- [x] **P05 — Extract motion/orientation processors.** Native/browser/watch measurements preserve physical values; calibration, filtering and game mapping remain explicit separate steps. [Contract](SDK.md#physical-motion-processors) and [packed consumer receipt](receipts/2026-10-05-p05-motion-processors.json).
- [ ] **P06 — Implement selected sensor-fusion/table-tap processor.** Declare actual required microphone/motion resources; evaluate labeled inputs, false activations, latency, privacy and unsupported hardware.
- [x] **P07 — Implement generic mapping/threshold/resampling processors.** Hysteresis, deadzones, event edges and sample rates are configured and tested without adding device/game special cases. [Contract](SDK.md#generic-mapping-and-sample-rate-processors) and [packed consumer receipt](receipts/2026-10-05-p07-generic-processors.json).
- [x] **P08 — Implement processor failure/restart propagation.** Loss, exception, timeout and revoked inputs invalidate derived outputs, clear dependent commands and reset state deterministically. [Runtime behavior](SDK.md#processor-failure-and-restart-propagation) and [packed consumer receipt](receipts/2026-10-05-p08-processor-failure.json).
- [ ] **P09 — Qualify processor performance and accuracy.** Record input conditions, quality thresholds, precision, CPU/memory/thermal and model/asset versions on supported targets.
- [x] **P10 — Add independent third-party processor example.** A separate consumer installs a pinned processor using declared permissions; incompatible schemas and privilege escalation fail. [External package contract](SDK.md#independent-processor-package-example) and [offline consumer receipt](receipts/2026-10-05-p10-external-processor.json).

### R — Route groups, compute placement and handoff

- [x] **R01 — Define route-group contracts.** Required/optional members, startup order, consent, compensation, safe-state and partial failure are explicit. [Contract](SDK.md#route-group-contracts), [original receipt](receipts/2026-10-05-r01-route-group.json) and [current requalification](receipts/2026-10-05-r03-route-group-recovery.json).
- [x] **R02 — Implement group preparation/activation.** Prepare grants/leases before activating required outputs; a failed member releases preparation without claiming to undo physical effects. [Runtime API](SDK.md#route-group-contracts), [original receipt](receipts/2026-10-05-r02-route-group-activation.json) and [current requalification](receipts/2026-10-05-r03-route-group-recovery.json).
- [x] **R03 — Implement group recovery/cancellation.** Lost optional/required members degrade, pause or stop by policy; no orphan subscriptions, leases or queued commands remain. [Runtime behavior](SDK.md#route-group-contracts) and [packed consumer receipt](receipts/2026-10-05-r03-route-group-recovery.json).
- [x] **R04 — Declare workload requirements.** Application/processor runtime, assets, resources, privacy, compute budget and restart/snapshot compatibility are validated before placement. [Contract](SDK.md#workload-requirements) and [packed consumer receipt](receipts/2026-10-05-r04-workload-requirements.json).
- [x] **R05 — Implement an authorized placement scheduler.** Select an eligible host, respect quotas and resource ownership, and reject an incompatible or unauthorized runtime. [Contract](SDK.md#authorized-placement-reservation) and [packed consumer receipt](receipts/2026-10-05-r05-placement.json).
- [x] **R06 — Implement versioned application snapshots.** A reference application serializes tested state; incompatible snapshots and absent assets fail with explicit restart alternatives. [Contract](SDK.md#versioned-application-snapshots) and [packed consumer receipt](receipts/2026-10-05-r06-application-snapshot.json).
- [x] **R07 — Implement pause/transfer/resume handoff.** New route epochs and ownership leave one authoritative host; interrupted transfer recovers without dual simulation or stale commands. [Runtime behavior](SDK.md#workload-handoff) and [packed consumer receipt](receipts/2026-10-05-r07-workload-handoff.json).
- [ ] **R08 — Implement hosted/streamed application integration.** Launch, input targets and media views authenticate to a real provider; metadata alone does not count as remote execution.
- [ ] **R09 — Qualify cross-host workloads.** Shared input/output groups and a supported live handoff pass permissions, disconnect, loss, snapshot version and measured recovery checks.

### B — Opted-in history, persistent state and jobs

- [x] **B01 — Define data retention and storage contracts.** Decide what is persisted for identity, grants, profiles, configuration and telemetry; default live routes create no recorded history. [Storage contract](RELEASE-CONTRACT.md#data-retention-and-storage-contract).
- [ ] **B02 — Implement bounded telemetry/history.** Opted-in batching, expiry, backpressure, quotas and offline upload preserve source time/quality without starving live controls.
- [ ] **B03 — Implement settings/profile storage migration.** Fresh install, upgrades, corruption, rollback and removed devices recover without restoring revoked authority.
- [ ] **B04 — Implement durable job evidence where required.** Print/recording/long-running tasks have ownership, idempotency, cancellation and restart state appropriate to their profile.
- [ ] **B05 — Implement export/deletion and secret separation.** Authorized export omits credentials; deletion/expiry removes opted-in data and leaves policy-required redacted audit evidence only.
- [ ] **B06 — Verify persistent-state isolation/recovery.** Local/remote storage boundaries, backup/restore and migration fixtures retain integrity, owner scope and accurate historical outcomes.

### E — Developer syntax, recipes, tools and extension ecosystem

- [ ] **E01 — Stabilize the public TypeScript API.** Document exact lifecycle/results, errors, evidence and async semantics; consumers do not import runtime internals.
- [x] **E02 — Define declarative recipe/schema syntax.** Resources, processors, routes, surfaces, styles and permissions use versioned readable descriptions with executable complete examples. [Recipe v1 and examples](SDK.md#declarative-recipe-v1).
- [x] **E03 — Implement recipe validation/resolution.** Resolve selected compatible resources and pinned processors; unknown/missing resources produce useful alternatives without automatic code execution. [Recipe resolution](SDK.md#declarative-recipe-v1).
- [x] **E04 — Implement recipe consent/execution lifecycle.** Preview requested access, grant required legs, start/stop groups and recover after denied, expired, missing or failed members. [Recipe session lifecycle](SDK.md#declarative-recipe-v1).
- [ ] **E05 — Implement UI/control description library.** Reusable boxes, text, controls, layout, styles and animation adapt to measured screens and input modes while retaining focus and accessibility.
- [x] **E06 — Build project/connector/processor scaffolding.** Generated projects include schemas, permissions, lifecycle, tests and a running caller; clean generated consumers compile and execute. [Generator and packed consumer evidence](SDK.md#scaffold-a-local-sdk-project).
- [x] **E07 — Provide simulator and fault-injection tools.** Developers replay bounded typed samples, simulate devices, revoke permissions and inject disconnect/loss without physical hardware. [Contract](SDK.md#local-device-simulator) and [packed consumer receipt](receipts/2026-10-05-e07-simulator.json).
- [ ] **E08 — Provide developer inspection tools.** Studio explains graph, readiness, grants, queues, traces and version errors; personal payloads/secrets are redacted.
- [ ] **E09 — Provide third-party conformance SDK.** Connector/processor tests validate manifest, schemas, lifecycle, permissions, limits, feedback and test evidence independently of 101.
- [ ] **E10 — Implement verified extension installation.** Publisher/version/integrity, requested privileges, compatibility, update, rollback, revocation and removal are enforced before activation.
- [ ] **E11 — Implement package catalog/publication workflow.** Authors submit tested manifests/docs and provenance; review/status/version/conflict handling works without granting package code implicit access.
- [ ] **E12 — Produce language/runtime bindings.** Qualified JS/browser/Node and selected Swift/Kotlin/C consumers share schema/protocol fixtures and lifecycle behavior.
- [ ] **E13 — Complete independent reference apps.** Pointer, sensor dashboard, appliance remote, media sharing and collaborative controls run outside the monorepo with readable docs and no hidden game dependency.
- [ ] **E14 — Provide machine-readable developer guidance.** Schemas, complete example recipes, package manifests and contextual instructions let developers/AI tools generate validated projects; explanatory text cannot grant privileges or execute code.

### U — Finished product UI and accessibility

- [x] **U01 — Finalize information architecture.** Devices, Connections, Sharing, Details, application surfaces, Settings and Studio have defined jobs, entities, permissions, navigation and recovery. [Product architecture contract](RELEASE-CONTRACT.md#product-information-architecture).
- [ ] **U02 — Build complete device add/inspect flow.** Discovery, no results, unknown/partial device, unsupported resource, denied access and offline states expose understandable next actions.
- [ ] **U03 — Build complete connection task flow.** Source/output selection, compatible options, consent, connecting, active use, interruption and stop are coherent across nearby and remote paths.
- [ ] **U04 — Build sharing/ownership flow.** Owners see recipients, scope and duration; request transfer, decline, partition and revoke behave correctly for simultaneous users.
- [ ] **U05 — Replace diagnostic product chrome.** Use device/task language and deliberate monochrome chrome; protocol, local labels, raw errors and constant status dots belong only where they help details/Studio.
- [ ] **U06 — Complete native/browser/desktop consistency.** Supported capabilities drive the same meaningful actions; platform conventions, permission recovery and navigation remain appropriate to each OS.
- [ ] **U07 — Complete responsive transformations.** Phones, tablets, watches, TV, desktop and external screens adapt to available area, orientation, safe insets, text scaling and offered inputs.
- [ ] **U08 — Complete touch/control experience.** Real gestures, pinch zoom, automatic focus/exposure where supported, handed layouts, thumb reach and release behavior feel usable on qualified hardware.
- [ ] **U09 — Complete accessible interaction.** Keyboard, visible focus, screen reader, contrast, reduced motion, readable status and equivalent controls pass actual journeys without technology detection.
- [ ] **U10 — Complete all asynchronous/error states.** Loading, empty, partial, stale, busy, denied, expired, interrupted, rate-limited and unavailable states have clear cancel/retry/alternative paths.
- [ ] **U11 — Complete privacy-sensitive interaction.** Capture and remote control preview the recipient/scope; visible stop, re-entry and revoked access match actual route state.
- [ ] **U12 — Complete settings/provider management.** Identity, permissions, privacy, installed connectors, trusted publishers, device removal and update/restore have tested flows.
- [ ] **U13 — Audit the full supported surface matrix.** Record responsive, keyboard/screen-reader, touch, motion, both themes and failure-state receipts on the final UI candidate.

### F — Performance, latency, workload limits and reliability

- [x] **F01 — Define measured workload/SLO profiles.** Set supported route/device/session counts, sample/event/media rates and latency/loss/skew budgets before making performance claims. [Workload contract](RELEASE-CONTRACT.md#workload-and-performance-profiles).
- [ ] **F02 — Instrument capture-to-output timing.** Capture, processing, encoding, transit, decoding and sink/render yield P50/P95/P99 with clock uncertainty; displayed ping is not finger-to-pixel evidence.
- [x] **F03 — Measure full payload cost.** Record encoded bytes, transport overhead, packets/rate, quantization error and resource negotiations for each fast profile. [Pointer profile measurement](receipts/2026-10-05-f03-pointer-cost.json).
- [ ] **F04 — Optimize demonstrated bottlenecks.** Compare cadence, coalescing, compact codecs, copy/allocation and processing placement against reproducible workloads; preserve transitions and security checks.
- [ ] **F05 — Implement fair scheduling/quotas.** One resource, session or slow recipient cannot monopolize controls; per-scope CPU/bytes/work limits remain bounded under contention.
- [ ] **F06 — Verify clock/drift and synchronization limits.** Simulated offset/drift and real devices validate age/skew decisions; uncertain clocks degrade honestly.
- [ ] **F07 — Verify memory/queue/fan-out limits.** Burst, hostile, hanging-provider, overload and cancellation workloads remain within declared bounds and release resources.
- [ ] **F08 — Run large graph/session load tests.** Scale by subscribed edges rather than unrestricted mesh; test published capacity tiers, tenant isolation and graceful overload.
- [ ] **F09 — Run loss/reconnect/slow-sink tests.** Network interruptions, congestion and stalled media/commands leave no stuck output or stale replay and recover through documented behavior.
- [ ] **F10 — Measure battery, CPU and thermal behavior.** Supported mobile, watch, desktop and gateway workloads sustain declared rates through realistic long sessions.
- [ ] **F11 — Investigate camera timing outliers.** Reproduce recorded startup/inference stalls and distinguish warmup, throttling and sustained latency; acceptance uses distributions and a completed walkthrough.
- [ ] **F12 — Publish reproducible benchmarks.** Scripts, exact builds/devices, impairment profiles, complete distributions and limitations accompany every latency/capacity claim.

### Q — Conformance, support matrix and regression qualification

- [x] **Q01 — Create the per-profile qualification template.** Require the evidence envelope below for every claimed connector/profile/runtime combination. [Contract evidence](CONTRACT-QA-2026-10-02.md).
- [ ] **Q02 — Build portable model/codec contract tests.** Shared golden and negative fixtures cover all language bindings, supported schema versions and incompatible revisions.
- [ ] **Q03 — Build faithful producer/decoder fixtures.** Use actual documented device/backend output, including malformed, short, nonfinite, missing and unexpected-profile data.
- [ ] **Q04 — Build permission/identity adversarial suites.** Copied IDs, unauthorized peers, cross-session operations, revoked grants and plugin escalation fail at real execution boundaries.
- [ ] **Q05 — Build lifecycle/ownership suites.** Stop, disconnect, revoke, expiry, removal, rotation, background and transfer cover exclusive/partition/observer behavior and async races.
- [ ] **Q06 — Build transport/media conformance suites.** Every implemented path covers negotiation, loss, reordering, overload, slow recipients and private-output isolation.
- [ ] **Q07 — Qualify browser/runtime combinations.** Chrome/Chromium, Firefox and Safari/WebKit plus supported Node/native versions have route, keyboard, resource and failure receipts.
- [ ] **Q08 — Qualify physical supported devices.** Each declared phone/tablet/desktop/watch/TV/gateway/peripheral profile passes its real input/output, permissions, lifecycle and feedback cases.
- [ ] **Q09 — Qualify real assistive-technology journeys.** Named screen reader/browser and any supported assistive hardware complete consent, control, stop and recovery flows.
- [ ] **Q10 — Qualify clean install/upgrade/offline scenarios.** SDK consumers and shipped apps work without monorepo links, dev servers or stale caches; rollback retains valid state.
- [x] **Q11 — Automate local/CI gates and target selection.** Required targets fail on missing preconditions/errors; only explicitly optional targets may produce a reported skip. [Gate evidence](task-evidence.json).
- [x] **Q12 — Reconcile support status from receipts.** Source, contract, emulator/runtime and physical evidence stay separate; outdated or failed rows cannot advertise current release support. [Catalog audit evidence](task-evidence.json).
- [ ] **Q13 — Freeze and requalify the final candidate.** All applicable suites use one exact revision/build/profile matrix; changes reopen affected rows and repeated flakes are resolved.

### J — Existing 101 supporting receipts already present

These J rows refer to [1 October QA](../QA-2026-10-01.md). They are historical supporting evidence, not final-candidate approval or new-SDK qualification.

- [x] **J01 — Physical iPhone development installation.** Valid local signing, strict app verification, installation and launch are recorded.
- [x] **J02 — Physical iPhone native pairing/reconnect.** Same-LAN WebRTC role assignment plus background/process-restart reconnect are recorded; full touch/network-loss acceptance remains in G.
- [x] **J03 — Physical Android pairing/game response.** OnePlus injected swipe gestures changed Slashstorm, including the corrected 298-point free-stroke run.
- [x] **J04 — Physical Android control layout smoke.** Portrait/short-landscape pad and active marker receipts exist; human ergonomics remain open.
- [x] **J05 — Physical Android scanner gesture smoke.** Scanner layout, torch and pinch zoom 0→54→0 are recorded; optical decoding remains open.
- [x] **J06 — Laptop live inference distributions.** Recorded 120-frame runs exist, including throttled inference/outliers; completed person-led throttled setup and phone distributions remain open.
- [x] **J07 — Native watch target/build/simulator work.** Apple watch target/embedding/signing and simulator paths plus Wear target evidence exist; physical watches remain open.
- [x] **J08 — Desktop browser/offline supporting checks.** Engine/keyboard/layout checks, Safari smoke and real desktop two-build offline behavior exist; complete Safari and physical installed-PWA acceptance remain open.

### G — Finish the 101 reference application's release acceptance

Use [release acceptance](../RELEASE-ACCEPTANCE.md) and [physical runbook](../PHYSICAL-ACCEPTANCE-RUNBOOK.md). All G rows remain open for the final accepted candidate despite earlier supporting receipts.

- [ ] **G01 — Complete desktop Safari acceptance.** Resolve intermittent opening/hidden-page behavior and run all game/keyboard/navigation/camera-required paths in a real active Safari session.
- [ ] **G02 — Complete physical iPhone gameplay.** Phone touch visibly drives games in portrait/landscape with reachable controls, restart and clean release; pairing alone is insufficient.
- [ ] **G03 — Complete physical Android controller acceptance.** Human play, background/process/network recovery, orientations, long session and held-input release pass on the final native/web paths.
- [ ] **G04 — Complete ergonomics and feedback.** Both phones pass simultaneous touches, handed layouts, rotation, thumb reach, haptic distinction, motion calibration and private audio.
- [ ] **G05 — Complete optical QR scanning.** Both phones decode real host tickets at varied distance, screen glare/brightness, darkness and pinch zoom; denial/retry, expired/unrelated codes and duplicates recover.
- [ ] **G06 — Complete every game's conventional controls.** All ten games start, accept declared controls, end, announce/focus results and restart on claimed desktop/phone paths.
- [ ] **G07 — Complete same-screen phone controls.** All ten games work in portrait and short landscape without control obstruction or stuck actions; record BeatForge timing and continuous Slashstorm feel.
- [ ] **G08 — Complete real camera walkthroughs.** Camera selection, placement, raised-arms confirmation, saved choice, start, restart and conventional fallback pass with a person.
- [ ] **G09 — Complete camera failure/recovery cases.** Denial/retry, unplug, missing saved camera, covered lens, darkness, backlight and genuine/false busy state recover through visible controls.
- [ ] **G10 — Complete the eight-second alternative.** A real person completes the side-step path with valid framing; leaving the frame or invalid placement cannot confirm success.
- [ ] **G11 — Complete two-person camera games.** BodyDodge and Shadow Arena preserve identities during crossing, departure/return, third arrival, occlusion and poor light.
- [ ] **G12 — Complete declared camera choices in every game.** Each supported body/hand path and its ordinary fallback produces real game response and clean result/restart.
- [ ] **G13 — Complete keyboard/screen-reader camera journeys.** Actual assistive software plus keyboard-only real-camera Confirm/alternative, skip, cancel and retry are usable and retain focus.
- [ ] **G14 — Complete camera performance acceptance.** Physical-phone body/hand 120-frame distributions and full laptop placement/gesture at 4× CPU slowdown meet recorded budgets.
- [ ] **G15 — Complete installed-PWA update/offline acceptance.** Physical phones update between two genuinely different accepted builds, retain old active assets and reopen another room offline.
- [ ] **G16 — Complete physical watch/specialist-profile acceptance.** Both claimed watch-to-phone paths and any selected sensor/suit profile have real control/calibration/lifecycle receipts.
- [ ] **G17 — Finalize 101 acceptance evidence.** Rerun applicable web/native/watch/desktop gates and production Lighthouse on the candidate; reconcile actual scores and close every required runbook case.

### K — Distributable SDK and application release artifacts

- [x] **K01 — Build installable SDK distributions.** Emit versioned JavaScript, types and schemas with defined exports/module support; workspace TypeScript links are not the public distribution. [Original packed consumer evidence](receipts/2026-10-03-sdk-consumer.json) and [current six-package requalification](receipts/2026-10-05-p04-landmark-processors.json). [Keyboard/text consumer requalification](receipts/2026-10-05-i05-keyboard-text.json).
- [x] **K02 — Verify a clean external SDK consumer.** Install packed artifacts outside the repository without workspace links; compile and run examples on supported toolchains. [Node 22.13 consumer](receipts/2026-10-03-sdk-consumer-node22.json) and [Node 24.14 consumer](receipts/2026-10-03-sdk-consumer.json) used the same [source-bound package set](receipts/2026-10-03-sdk-distribution-manifest.json). [Current six-package Node22/24 requalification](receipts/2026-10-05-p04-landmark-processors.json). [Keyboard/text consumer requalification](receipts/2026-10-05-i05-keyboard-text.json).
- [ ] **K03 — Verify native-language distributions.** Swift/Kotlin/C artifacts and their clean consumers share conformance fixtures and include required assets/metadata.
- [ ] **K04 — Produce standalone Android Release artifacts.** Intended signing and install/update/cold launch/deep link/permissions work without Metro or another development server.
- [ ] **K05 — Produce standalone iOS/iPadOS/watchOS artifacts.** Intended release identities/profiles and embedded companions verify; install/update/relaunch behavior passes the selected distribution route.
- [ ] **K06 — Produce desktop installers.** macOS, Windows and Linux packages have required platform signing/notarization where applicable plus target-OS install/update/uninstall receipts.
- [x] **K07 — Produce browser/PWA release assets.** Offline/update/cache/security and runtime asset availability pass production builds with no hidden development origin requirement. [Packaged browser and two-build evidence](receipts/2026-10-04-browser-pwa-release.json); physical installed-PWA acceptance remains G15.
- [x] **K08 — Repair required-target packaging semantics.** `tools/package-release.mjs` gets a release mode that fails missing required targets; debug/skipped artifacts cannot report an accepted release. [Required-target packaging evidence](REQUIRED-TARGET-PACKAGING-QA-2026-10-02.md).
- [ ] **K09 — Complete redistribution licenses.** Synchronize notices/inventories with the lockfile and include licenses/assets/model attribution and supported third-party distribution terms. [Partial JavaScript inventory lockfile check](receipts/2026-10-05-k09-js-inventory.json); complete third-party terms/texts remain open.
- [ ] **K10 — Create artifact provenance/manifests.** Exact revision, build/profile versions, hashes, sizes, toolchains, licenses and provenance identify every package/binary. [Partial immutable SDK package manifest](receipts/2026-10-05-k10-sdk-manifest.json); other release targets and platform binaries remain open.
- [ ] **K11 — Verify reproducible build/upgrade rollback.** Clean build inputs and installation migrations are repeatable; corrupt/partial updates fail safely and retain a recoverable accepted version.
- [ ] **K12 — Audit release artifact contents.** Packed files contain required runtime assets/docs and no development secrets, local credentials, private receipts or unintended files. [Partial web and SDK audit](receipts/2026-10-05-k12-web-sdk-contents.json).

### O — Self-hosted/global operator readiness

- [ ] **O01 — Define operator configuration and startup validation.** Identity, origins, storage, relay and quota requirements fail closed with readable recovery when missing or invalid.
- [ ] **O02 — Provide a disposable local deployment harness.** Coordinator/directory/relay dependencies can be started, exercised and removed without touching user or live data.
- [ ] **O03 — Implement redacted observability.** Health, traffic, route/queue load and faults are visible; credentials and private payloads are excluded from operator logs.
- [ ] **O04 — Validate overload and degraded behavior.** Capacity exhaustion, relay failure, processor failure and unavailable regions recover or reject admission within published bounds.
- [ ] **O05 — Validate operational key/credential lifecycle.** Rotation, expiry, revocation and recovery work without exposing another tenant or retaining stale access.
- [ ] **O06 — Validate state backup/restore where required.** Restoring identity/configuration/history preserves ownership, revocation, retention and migration integrity.
- [ ] **O07 — Provide upgrade/rollback and incident runbooks.** Execute representative failure, security revocation and rollback drills with redacted receipts.
- [ ] **O08 — Establish service limits and responsibilities.** Document supported load, relay/traffic budgets, operator trust/privacy boundaries and maintenance obligations before a live service claim.

### L — Publication readiness and actual publication

- [ ] **L01 — Complete developer/onboarding documentation.** A fresh developer can install, create, connect, test, extend and recover using complete examples and the supported matrix.
- [ ] **L02 — Complete public API/reference/support documentation.** Exact schemas, protocols, permissions, limitations, version policy, troubleshooting and security-reporting paths match released artifacts.
- [ ] **L03 — Prepare local publication dry runs.** SDK tarballs, app bundles/installers, release notes, provenance and required license metadata validate without external writes.
- [ ] **L04 — Resolve distribution/service prerequisites.** Identify actual registry/store/signing/domain/hosting requirements, owned accounts and credentials for the selected channels; do not invent live readiness.
- [ ] **L05 — Obtain concrete publication authorization.** Present the exact accepted release artifacts, destinations and live actions; existing local-only repository policy remains in force until explicitly changed.
- [ ] **L06 — Execute authorized publication/remote CI/deployment.** Only after L05, push/run remote checks/publish selected artifacts or host services and retain actual verified results.
- [ ] **L07 — Verify post-publication consumption and recovery.** Clean users install the published SDK/apps, connect through the supported topology and receive updates; rollback/revocation and public docs work.

### Z — Full completion gates

- [ ] **Z01 — Required implementation is complete.** Every required implementation workstream has accepted code and working callers; research, descriptions and placeholders do not count as implementation.
- [ ] **Z02 — Supported matrix is qualified.** Q records cover every release claim; required physical/accessibility cases are not skipped and unsupported boundaries are explicit.
- [ ] **Z03 — Security/reliability/performance is accepted.** S/F tasks and relevant operator tests meet declared budgets with no unresolved release-blocking finding.
- [ ] **Z04 — 101 and independent applications are accepted.** G tasks and independent SDK consumers pass on the frozen candidate while existing contracts remain compatible.
- [ ] **Z05 — Publication-ready candidate is accepted.** K/O and L01–L05 have complete artifacts, provenance, licenses, docs, receipts and release decision; publishability is recorded independently from live status.
- [ ] **Z06 — Published system is verified.** Authorized L06–L07 results identify the actual distributed revision and live topology; the full requested scope is complete only when its required implementation and evidence rows close.

## Qualification evidence envelope: required per support row

| Field | Required record |
| --- | --- |
| Source/artifact | Commit, package/binary/build ID, hashes and toolchain |
| Environment | OS/runtime/browser versions, device model/firmware, connector/profile/schema/codec versions |
| Resources | Specific input/output capabilities, units/frames/ranges, sample/format limits, unavailable/unknown features |
| Discovery/identity | Discovery scope/expiry, enrollment and actual identity proof or documented gateway limitation |
| Authority | Source/sink owners, consent, operations, OS/vendor permission and denial/revocation results |
| Lifecycle | Attach, loss, reconnect, background/lock, teardown, stale generations and release/safe-state results |
| Concurrency | Exclusive conflict/transfer, observer fan-out or partition behavior and lease expiry |
| Semantics | Faithful producer fixtures, calibration/quality, invalid/wrong-profile data and measured conversion error |
| Command evidence | Admission, dispatch, target reply, observed effect or unverified outcome; duplicate/deadline handling |
| Performance | End-to-end P50/P95/P99, loss/queue age, full bytes/rates, CPU/memory and battery/thermal profile |
| Result | Pass/fail/pending, reproduction, redacted receipt link and qualification level |

## Capability coverage map

This map ensures the support catalog considers the requested families. Each actual supported combination requires Q qualification; a category name alone is not implementation evidence.

| Family | Required capabilities or representative path | Owning tasks |
| --- | --- | --- |
| Computers/phones/tablets | Browser/native app resources; system input where permitted; camera/audio/display and lifecycle | N, I, V, T |
| Watches/rings/bands/earbuds | Companion or selected BLE/vendor resources, controls, permitted sensors and audio | W, A03, V04 |
| TV/external screen/console | Qualified application receiver, render surface or permitted gateway; explicit inaccessible capabilities | N09–N11, V |
| Mouse/keyboard/gamepad/pen/assistive devices | Ordinary input versus raw HID profiles, transitions/text/contacts and output feedback | I, A02, N |
| Wired headphones/microphones/speakers | Independently routed capture/playback, hotplug and timing | V03–V04 |
| Printers/cameras/DVR/NVR/older equipment | Jobs/media/control through a selected standard/vendor/legacy gateway | A13–A15, V |
| Smart-home/IR/mechanical appliances | Commissioned bridge or nearby emitter/actuator plus explicit feedback limitations | A06–A10 |
| Motion/spatial/material/environment/electrical sensors | Typed values, units, calibration, quality, clock/provenance and gateway profiles | M, A16, P |
| Engines/industrial equipment/robots | Selected authorized telemetry/supervisory profiles; qualified local control limits | A10–A12, S, R |
| Terminal/SSH/filesystem/clipboard/app operations | Dedicated scoped native connector with host identity, credentials, allowed operations and audit | S12, N14, E, Q04 |
| Unlisted future devices/algorithms | Add a reviewed profile/processor with conformance and a real caller without central product-ID branches | A01, P01/P10, E09–E11 |

## Links and maintenance

- Architecture and stage sequence: [platform design](../superpowers/specs/2026-10-01-universal-device-platform-design.md).
- Research and ecosystem sources: [device/protocol research](RESEARCH-2026-10-01.md).
- Implemented foundation: [SDK guide](SDK.md), [foundation QA](FOUNDATION-QA-2026-10-01.md), [foundation execution record](../superpowers/plans/2026-10-01-device-foundation.md).
- Existing 101 acceptance: [release definition](../RELEASE-ACCEPTANCE.md), [physical runbook](../PHYSICAL-ACCEPTANCE-RUNBOOK.md), [chronological latest device QA](../QA-2026-10-01.md).
- When a task closes, update its evidence link and the support catalog together. This ledger is the current checklist; design documents explain decisions and dated QA files preserve receipts.
