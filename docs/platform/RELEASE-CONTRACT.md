# Device SDK release contract

Contract revision 1, 2 October 2026. This defines C01–C08 for the [master checklist](MASTER-CHECKLIST.md). The owner authorized implementing the complete checklist in the current local checkout. This contract defines acceptance; no distributed or live release is approved.

## Scope and matrix

The [support catalog](support-catalog.json) is the machine-readable matrix. A row identifies OS/version, runtime/version, form factor, transport, connector/version, profile/schema/codec, resources and unavailable features. Its implementation, contract, runtime and physical evidence are independent arrays. Empty means unverified, never implied support. `unknown` combinations inherit nothing. `candidate` identifies work to qualify; `historical` preserves limited earlier receipts; `embedded` describes the implemented single-process scope. Only `qualified` plus `accepted: true` denotes a current release claim.

Current implemented scope is `@101/connect` 0.1.0 with descriptor schema 1, boolean/scalar/vector/enum values and in-process routing. Source and tests are at `32e0e37`; the actual current harness uses Node 24.14.0 on macOS 26.5.2 (25F84). The package engine floor is Node 22.13.0, but floor qualification is open under Q07/Q10. No browser, native, gateway or physical combination is yet qualified for the new SDK. The 101 v2 and input-q1 receipts remain historical, separately cataloged.

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

The table sets required qualification work and version targets, not broad compatibility promises. Later supported versions are added as new catalog combinations with their own receipts. A candidate version unavailable here remains open; a simulator is never promoted to a physical result. The full 252-task vision remains required even if a smaller intermediate candidate is useful.

Browser versions are frozen from actual runtime readback, rather than a mutable label such as “latest”. Browser API availability is probed through the relevant provider; labels do not imply WebHID/WebBLE/WebSerial support, system input, background execution or permission. WebRTC direct LAN is the first transport; HTTPS identity/coordinator, relay and bounded WSS are separately qualified. WebTransport/QUIC stay candidates until T13's caller and measurements justify them.

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

## Public names and compatibility

- `@101/device-model`, `@101/device-runtime`, `@101/connect` and the first peer package `@101/transport-webrtc` use the public working namespace, version 0.1.0. Public JS/type/schema distributions are K01 work; current TypeScript workspace exports are explicitly not an installable release.
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

## Evidence and final acceptance

[task-evidence.json](task-evidence.json) contains every stable checklist ID, its dependency IDs, equipment and receipt references. The checklist checkboxes remain authoritative. Each receipt records source/build identity, environment, reproduction, outcome, scope, preserved failure and equipment; relevant physical/performance detail follows the [qualification envelope](MASTER-CHECKLIST.md#qualification-evidence-envelope-required-per-support-row). Use immutable commit/build/hash references. `pending` or `unavailable` is explicit and never closes a task. One receipt can prove multiple tasks only if it states each exact scope. Runtime/emulator and physical levels remain independent.

Run `node tools/audit-platform-records.mjs` after each ledger change. It verifies task coverage, stable IDs, dependencies, links, tally and evidence levels, rejecting current acceptance from historical receipts. Current acceptance also binds each receipt to an exact immutable target snapshot; a changed OS/runtime/device/connector/profile/codec/resource combination invalidates it. Passing task evidence retains nonempty receipt links and declared evidence levels. A pass audits records; it does not perform or certify their claimed hardware tests. The [qualification template](QUALIFICATION-TEMPLATE.md) supplies the full physical/runtime evidence envelope.

The final candidate must satisfy all Z tasks and all required predecessor rows, with exact packaged artifacts, target/version matrix and passing source/contract/runtime/physical/security/performance/accessibility evidence. Freeze one revision; every commit passes TypeScript, lint, unit tests and rendered checks against a fresh build when source changes. A required missing target, failed permission/isolation/release/upgrade/security case, stale output, unbounded resource use, corrupted semantics or inaccessible required journey blocks release. Repeated flakes must be resolved, not averaged away.

Supported lifecycle includes attach, denial/cancel/retry, loss, reconnect, background/lock/process death within OS limits, ownership conflict/transfer/expiry and teardown. Required outputs stop safely on loss; interrupted/non-idempotent effects remain explicitly unverified. Performance claims include capture-to-output distributions with clock uncertainty and complete payload/load/energy conditions. No receipt substitutes ping for finger-to-pixel or a hardware label for capability probing.

Security maintenance uses versioned disclosures, reproduced negative tests, affected-version/catalog reopening, prompt unsafe-grant/key/package revocation and validated update/rollback. A stable release includes a real reporting contact and owned update channel under L02/L04; inventing a mailbox or live service is not permitted. Operator obligations and supported load are O08 gates. Current local-only policy persists through L04. L05 presents concrete accepted artifacts, owned destinations and exact external actions for explicit authorization; L06–L07 and Z06 stay open until actual authorized publication and consumption succeed.
