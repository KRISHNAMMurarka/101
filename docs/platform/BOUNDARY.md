# Boundary: 101 Games and Uynis Connect

Date: 20 October 2026. Status: **owner-directed product boundary; movement and implementation await approval**.

The existing local wave is committed at **301b0d3f255eb90feb943c7886ec5c101886ca14**. Its exact verification and native-gate exception are recorded in [the integration receipt](receipts/2026-10-20-local-wave-integration.json). This document changes ownership and describes a future cutover; it does not move code, admit a service, publish anything, or close an acceptance row.

## 1. Two products

- **DEVICE PLATFORM — Uynis Connect:** /Users/km/Dev/uynis-connect, existing repository edilec-global/uynis-connect. A general device service for phones, watches, computers, servers, gamepads, cameras, sensors and robots. Its vocabulary is devices, capabilities, signals, connections, sessions and permissions. It has no knowledge of game rules, titles, players or game actions.
- **101 GAMES:** /Users/km/Dev/101, existing repository KRISHNAMMurarka/101. The games, game SDK and engine, launcher, game controller and console receiver. Its mapping layer converts approved platform signals into game actions such as move, jump and slash.

Dependency direction:

```text
101 Games app
  -> Uynis Connect public SDK / versioned API
  -> shared infra and Uynis Kit
  -> Uynis core through the kit connectors
```

Within 101: platform SDK -> game mapping layer -> game-host / game SDK -> games. This arrow describes input delivery; the dependency on the platform is confined to the integration layer. Games receive game actions and game-space values, not raw device handles, transports, credentials or grants.

The owner has selected the destination and the separation. **Approval to move includes the necessary boundary refactoring described here, but does not approve the four additional capability projects in section 8.** No intermediate device-platform home will be created inside 101 or another product.

## 2. Complete package and application inventory

Inventory: **38 packages, five apps under apps/, and eleven packages under games/**. Twenty-six existing package roots belong primarily to DEVICE PLATFORM; twelve belong to 101 GAMES. Mixed source inside a primarily platform-owned package is explicitly divided in section 3.

Destinations below are relative to /Users/km/Dev/uynis-connect. Portable device libraries live under sdk/; generated HTTP clients will live under sdk/api/<service>/. The authored runtime libraries are not falsely described as generated OpenAPI clients.

### DEVICE PLATFORM packages — 26

| Current source | Final destination | Responsibility |
| --- | --- | --- |
| packages/device-model | sdk/device-model/ | Device/capability descriptors, values, schemas and generic signal contracts. |
| packages/device-runtime | sdk/device-runtime/ | Routing, grants, ownership, resources, execution and lifecycle. |
| packages/device-web | sdk/device-web/ | Browser device integration, lifecycle and authenticated connection composition. |
| packages/connect | sdk/connect/ | Public SDK entry point for consumers, including 101's integration layer. |
| packages/adapter-bluetooth | sdk/adapters/bluetooth/ | Bluetooth device acquisition and signals. |
| packages/adapter-camera | sdk/adapters/camera/ | Camera acquisition, permission recovery and lifecycle. |
| packages/adapter-gamepad | sdk/adapters/gamepad/ | Gamepad buttons/axes and connection lifecycle, without game-action aliases. |
| packages/adapter-hid | sdk/adapters/hid/ | HID device reports and approved outputs. |
| packages/adapter-keyboard | sdk/adapters/keyboard/ | Keyboard signals and release lifecycle. |
| packages/adapter-motion | sdk/adapters/motion/ | Motion acquisition and device signals. |
| packages/adapter-pointer | sdk/adapters/pointer/ | Pointer/contact signals and release lifecycle. |
| packages/adapter-serial | sdk/adapters/serial/ | Serial reports and approved outputs. |
| packages/adapter-watch | sdk/adapters/watch/ | Watch reports, controls and lifecycle. |
| packages/transport-webrtc | sdk/transports/webrtc/ | Generic peer transport. |
| packages/transport-websocket | sdk/transports/websocket/ | Generic socket transport. |
| packages/pairing | sdk/pairing/ | Invitations, comparison, discovery intake and pairing. |
| packages/protocol | sdk/protocol/ | Device/session envelopes, negotiation and generic control descriptions; game envelopes stay in 101. |
| packages/session | sdk/session/ | Device membership, connection state and lifecycle; game role assignment stays in 101. |
| packages/hub-server | services/control/src/hub-server/ | Existing host, gateways, native operation providers and local coordination. |
| packages/hardware | sdk/hardware/ | Byte framing, report decoding and device-level mappings. |
| packages/diagnostics | sdk/diagnostics/ | Generic signal/connection measurement and redacted diagnostics. |
| packages/devkit | sdk/devkit/ | Device scaffolding and platform developer tooling; game scaffolding stays in 101. |
| packages/motion | sdk/processors/motion/ | Generic calibration, filtering and motion recognition. |
| packages/vision | sdk/processors/vision/ | Generic tracking, landmarks, calibration and gesture recognition. |
| packages/audio | sdk/processors/audio/ | Reusable sound, tone and audio scheduling primitives. |
| packages/replay | sdk/replay/ | Generic signal/event recording and replay machinery; game replay schema stays in 101. |

The existing hub-server lands once as one host implementation under control. That does not declare eight new network services operational. The skeleton's registry, discovery, transport, control, tasks, sync, sessions and automation folders remain the logical service map; new service admission and any later decomposition require their own contracts and evidence. Services and native agents consume shared SDK contracts or public APIs, never another service's internal source or tables.

### 101 GAMES packages — 12

| Current source, retained in 101 | Responsibility |
| --- | --- |
| packages/core | Engine101, game lifecycle and seeded game randomness. This is not a general device core. |
| packages/input | Game input bus, manifests, readiness and the devices-to-actions mapping layer. Generic adapter types must be disentangled. |
| packages/sdk | Game SDK, definitions, manifests and game-facing input contract. |
| packages/game-host | Game execution, player/role assignments and action delivery through the platform SDK. |
| packages/game-registry | Game catalog and registration. |
| packages/render-2d | Game rendering. |
| packages/render-3d | Game rendering. |
| packages/physics | Game physics. |
| packages/link-controller | Game controller layouts, presets and action interpretation; connection mechanics use the platform SDK. |
| packages/maze | Maze generation and game rules. |
| packages/rhythm | Beat timing and scoring. |
| packages/swarm | Game formations and simulation; this is not a robot fleet service. |

### Apps — all five

| Current source | Owner | Final home |
| --- | --- | --- |
| apps/controller-native | DEVICE PLATFORM | agents/controller-native/ — generic phone agent; game-specific presets/assignments are separated as described below. |
| apps/watch-ios | DEVICE PLATFORM | agents/watch-ios/ |
| apps/watch-wear | DEVICE PLATFORM | agents/watch-wear/ |
| apps/desktop-hub | DEVICE PLATFORM | agents/desktop-hub/ — generic desktop agent; game replay labels/policies stay in 101. |
| apps/console-receiver | 101 GAMES | Stays at apps/console-receiver/; receives game actions through the SDK and mapping layer. Its present pointer surface and UWP host are not proof of Windows/Xbox qualification. |

### Games and game tools — all eleven remain in 101

| Current source | Owner |
| --- | --- |
| games/beatforge | 101 GAMES |
| games/bodydodge | 101 GAMES |
| games/echomaze | 101 GAMES |
| games/gravitystack | 101 GAMES |
| games/input-lab | 101 GAMES — game-input developer tool, not a playable title. |
| games/orbitalcrew | 101 GAMES |
| games/shadowarena | 101 GAMES |
| games/slashstorm | 101 GAMES |
| games/spellcaster | 101 GAMES |
| games/swarmcommander | 101 GAMES |
| games/tiltdrift | 101 GAMES |

### The root web app and its routes

app/ is currently a mixed application, not an additional unassigned product.

| Current surface | Owner and cutover destination |
| --- | --- |
| app/page.tsx, app/games/**, game catalog, game components and game launch/recovery | 101 GAMES; retain the launcher and every game/play route. |
| app/controller/** and game controller overlays | 101 GAMES; retain game-facing control UI and use the public platform SDK. |
| app/devices/** | DEVICE PLATFORM -> apps/console/app/devices/ |
| app/connections/**, including audio, camera, feedback, gamepad, microphone, readings, resources and screen | DEVICE PLATFORM -> apps/console/app/connections/ |
| app/sharing/**, including watch | DEVICE PLATFORM -> apps/console/app/sharing/ |
| app/settings/history/**, app/settings/processors/** | DEVICE PLATFORM -> apps/console/app/settings/{history,processors}/ |
| app/settings/page.tsx and Appearance UI | 101 GAMES appearance stays; device/provider management belongs to the platform console. No device-management engine is duplicated. |
| app/pointer-lab/** | DEVICE PLATFORM -> apps/console/app/pointer-lab/ |
| app/studio/{hardware,inspector,motion,network,ownership,vision}/** | DEVICE PLATFORM -> apps/console/app/studio/ with their generic diagnostics. |
| app/studio/{input,controller,catalog-bench}/** | 101 GAMES; game input/layout/catalog tools. |
| app/studio index, rail and layout | 101 retains its shell with only game tools; platform tool entries compose the console's shell. |
| app/layout.tsx, globals.css, error/not-found, AppShell, Icon and general launcher chrome | 101 GAMES shell; extract only the concrete styles/components needed by moved console screens, with provenance. |
| app/lib/** and remaining shared app/components/** | Split by the mechanisms below; no whole-directory move that takes game integration into Connect. |
| worker/index.ts, launcher PWA/service worker and Link manifests/icons | 101 GAMES web packaging; no deployment authorized. Vision runtime assets under public/mediapipe follow the platform processor with their exact legal sources. |

## 3. Existing coupling to cut during the single move

Moving directories alone would leave the platform dependent on games. The source currently demonstrates these obligations:

| Source seam | DEVICE PLATFORM retains | 101 GAMES retains or receives |
| --- | --- | --- |
| packages/input and every adapter | Device signal/adapter contracts moved into device-model/runtime; acquisition, connection, sampling, cleanup. | InputManifest, InputBus, player routing and game actions. Current adapter aliases such as jump, boost, spell.cast.*, combat.* and maze.* become game mapping profiles. |
| packages/hardware, diagnostics and replay imports of @101/input | Generic decoder outputs, measurement and signal/event history. | Semantic action conversion and action-history consumer. |
| packages/protocol | Generic negotiation, pairing/session and device messages. | Game assignment, player IDs, title-specific controller policy and game wire compatibility wrapper. Opaque application/control IDs may cross the platform; game semantics do not. |
| packages/session/src/index.ts | Device membership, expiry, connection state and generic session transport. | LocalSession's configureGame, GameControllerRole, role compatibility, game/player assignment and game readiness logic, under game-host/input. |
| packages/replay/src/index.ts | Generic recorder/replay mechanics. | Replay101's gameId, gameVersion, seed and semantic InputFrame schema, under the game SDK/host. Platform replay never reauthorizes a revoked live capability. |
| packages/devkit/src/device-scaffold.ts and src/index.ts | Device scaffold and its tests -> sdk/devkit/. | createGameScaffold and its tests -> game SDK tooling; tools/create-101-game.mjs stays. |
| packages/vision and motion | Generic pose/hand/motion recognition and calibration. A recognized physical gesture may be a signal. | Combat/spell/maze behavior, game thresholds and mappings from gestures to actions. A physical jump signal is not permission to execute a game's jump. |
| packages/audio | Generic playback/tone/timeline utilities. | Sound assets, score timing and game sound policies; game-facing helpers call the platform through the integration boundary if device output is involved. |
| native controller and desktop source | Generic device controls, supplied layouts, bridge and native lifecycle. | Embedded gameplay presets, role/game assignments and game replay presentation. Native agents consume app-supplied generic control descriptions. |
| app/lib/use-camera-input.ts, camera setup/capability helpers and CameraSetup | Acquisition, permission state, shared camera lifecycle and generic capture recovery move with device-web/adapters. | Game camera requirements, placement copy and action mapping remain. There is still one camera lifecycle owner, never one per game. |
| app/lib/browser-link.ts, connection ownership/review, endpoint identity and RemotePointerPanel | Pairing/identity/connection mechanisms and generic control UI move to device-web/pairing and the platform console. | Game invitation presentation, player assignment and launcher integration remain SDK clients. |
| app/lib/use-game-host.ts, input readiness/catalog helpers and game-controller-input.ts | No game policy. | Remain game integration; replace direct adapter/protocol/session construction with the public SDK and game mapping. |

The current app game components import adapters directly; game-host accepts a transport and adapters; connect publicly exports transport constructors. **A package rename alone will not satisfy this boundary.** After cutover, 101 must not instantiate a transport or adapter even through a public re-export. Its approved public entry points are client discovery, capability inspection, consent, subscription, application registration, authorized output, lifecycle and status.

Supporting schemas, bindings, examples, tests and tools follow their contract owner. In particular:

- Device descriptor and generic wire schemas, all bindings/, device examples, device scaffolding, SDK packaging, native builders and generic operator diagnostics move with the platform, under sdk/schema/, sdk/bindings/, sdk/examples/, cli/ or the owning service/agent's tests and tools.
- Game/input manifests, game controller policies, examples/external-game, game scaffolding, game browser journeys and launcher rendered checks stay in 101. Split controller-layout schema into a generic control description and game-supplied layout policy where necessary.
- Combined acceptance ledgers and receipts are frozen as original evidence, with original IDs, source hashes and failures. Each product gets an owner index pointing to the original evidence and its own new results; no wholesale copying of completed claims.
- Root manifests, lockfiles, compiler aliases, unit discovery, bundlers, license inventories and release tools must be adjusted for the two dependency closures. Keep bounded unit-test discovery and fresh-build-before-rendered verification.

Before extraction, the approved cutover must turn this inventory into an explicit file/symbol ownership manifest, including mixed tests, styles, legal files and historical paths. That is a refinement of the named boundary, not permission to leave sources with two runtime owners.

## 4. API: devices -> approved signals -> game actions

This is the required contract shape, not a claim that all of these public entry points already exist.

1. The SDK discovers devices and returns capability descriptors: stable identity, supported signal/value schemas, direction, availability and permission state. Neither hardware presence nor pairing alone claims that a usable input exists.
2. The app requests a scoped connection and capability grant through the SDK. Device owner, destination, purpose, limits, original expiry and current session/epoch are explicit. Platform code validates and enforces them.
3. An approved subscription delivers typed device signals, sequence/freshness metadata and lifecycle events. Transport selection, reconnect, backpressure, authentication and adapter cleanup remain inside Connect.
4. 101's mapping layer chooses profiles from game manifests and actual granted capabilities. For example: gamepad button 0 -> jump; approved stick vector -> move in game coordinates; wrist impulse -> slash. Only this layer knows those action names, player roles or game-specific thresholds.
5. game-host delivers a semantic action frame to the game SDK. Boolean actions, edges and normalized game-space scalar/vector values are allowed. Raw camera frames/landmarks, native resource handles, device grants and transport packets are not game inputs.
6. Stop, unmount, permission denial/revocation, expiry, disconnect and source loss neutralize held actions and cancel queued effects. Reconnection requires the appropriate fresh authority; stale/replayed input cannot revive a held action.
7. Game feedback goes back as an application intent through the integration layer. Connect enforces an independent output capability grant; receiving input never grants output or control of another resource.

Permission/recovery UI may show SDK status in the launcher, but games never call an adapter or transport. Equivalent keyboard controls, readable status, skip/retry and visible focus remain mandatory. Support and launch readiness are derived from manifests and measured capabilities; no per-game ID branches in shared platform code.

Boundary acceptance after approval includes import/dependency checks in both directions, an independently installed SDK consumer, and representative keyboard/gamepad/camera/remote-control game journeys with refusal, revoke, disconnect, neutral release and fresh recovery. No Connect runtime package may import the 101 game SDK, input bus, game-host, registry, game packages or app source.

### Development and later distribution

The proposed public entry point is @uynis-connect/connect. During development 101 links to **../uynis-connect/sdk/connect** (for example a local file dependency), with the platform workspace building and resolving its own SDK dependency closure. Consumers use declared package exports; no aliases into ../uynis-connect/services/** or adapter/transport source, and no copied platform package implementation inside 101.

The local link is the development form of the same API. Later, replace it with a versioned package dependency and lockfile, supported API/schema versions and exact package provenance. No registry publication, remote dependency swap or new service is authorized now. Any compatibility aliases required for current @101/* consumers live in the platform's public SDK migration surface, not duplicate implementations.

## 5. Uynis Kit contracts and connectors

Read against the local kit on 20 October: README.md, contracts/README.md, connectors/README.md and each of the five connector READMEs, service-template/README.md and files/{README.md,service.json,openapi.yaml}. The destination README and service skeletons were also inspected.

**The kit currently contains documents/interfaces and template files, not working connectors.** Its local fallbacks are planned to reuse existing code; its uynis/ sides intentionally stay empty until the owner connects Uynis. A move must not claim that importing a skeleton supplies login, metering, audit storage, vault or files.

| Kit connector | Required use in Connect | Local fallback defined by the kit |
| --- | --- | --- |
| login | Verify tenant/principal and device ownership; no new login, MFA, SSO or passkey stack. | Existing login/session implementation supplied through the kit, not invented in Connect. |
| usage | Billable events and quota/meter keys. | Durable usage outbox and quota counters. |
| audit | Mutations/control decisions and declared reason codes. | Append-only tenant-scoped local audit through the kit connector. |
| keys | Secret references, signing, wrapping and rotation. | Environment/file references and standard crypto through the connector. |
| files | Object/recording/update artifact storage. | Content-addressed local files with checksums. |

Select a local connector explicitly while disconnected from Uynis. An unreachable configured Uynis connector must fail closed; it must not silently become a permissive local identity. Existing local device identity/grants are preserved as device evidence, not relabeled as account ownership. Missing kit implementations are a service-admission dependency; do not build private substitutes during the source move.

Every admitted service follows the template:

- Versioned OpenAPI as the HTTP contract; generated SDK clients; Idempotency-Key and dryRun on mutations, keyset cursors and RFC 9457 errors.
- Tenant on every persisted row and connector call, checked from verified identity on the server; PostgreSQL row-level security when used. No cross-service table reads, joins or foreign keys.
- Events with JSON Schemas. Usage events go to a durable outbox in the caller transaction; mutations emit audit events in the transaction with declared reason codes.
- Exact Uynis webhook format: X-Uynis-Signature: v1=<64 lowercase hex>, HMAC-SHA256 over timestamp + "." + rawBody; X-Uynis-Timestamp in RFC 3339 UTC, previous signature during rotation, body id matching delivery id, deduplication by stable idempotencyKey.
- Login, usage, audit, keys and files only through the shared kit; other external dependencies behind swappable service-specific connectors. Preserve browser/native platform crypto at their existing boundaries; Node service crypto uses built-in crypto, not handwritten primitives.
- Honest service.json admission fields: leave null plus deferredAdmission reasons until owner, entrypoint, health/readiness, SDK, CLI, required documents and test lane actually exist. Supply placement, archive/export, coordinator-unreachable and global-plane disclosure contracts before admission.

No Uynis core edits, new accounts or live integration happen in this work. The kit's Ecoss-specific staged migration sequence is not the 101 move plan; the owner's one-move instruction governs here.

## 6. One history-preserving move, after approval

Preferred mechanism: **git filter-repo with an explicit multi-path selection and direct final-path renames**. git subtree split is a history-preserving alternative for a single coherent prefix; these sources span packages/, apps/, app/, bindings/ and supporting paths, so first gathering them into a temporary platform directory in 101 is rejected.

1. Freeze approved source and destination commits. Preserve all current work by named commits; record 101's existing remote and the destination's existing origin. Keep a verified local Git recovery bundle of the source refs and the destination baseline. Inventory relevant local evidence refs and unique ignored evidence before cleanup.
2. Finalize the exact path/symbol map from sections 2–3, including tests, schemas, legal sources and predecessor paths. Audit historical renames explicitly: filtering does not automatically follow every old path. Check licences before selecting source for import.
3. Filter a disposable local history-processing clone, never the live 101 checkout. Select all relevant history and map each chosen platform path **directly to its final services/, agents/, sdk/, apps/console/, cli/ or docs/ path**. Do not squash. Preserve author/committer metadata, messages and relevant ancestry; keep the filter's old-to-new commit map. Rewritten commits necessarily have new IDs; the original bundle retains the exact original objects.
4. Import that filtered history **once** into the existing uynis-connect skeleton using a local repository path and a non-squashed merge. Preserve the skeleton's history and resolve only documented path collisions. Do not add uynis-connect as a remote to 101, rewrite 101 history, or create an intermediate product repository.
5. Complete the approved separation of mixed source at the cutover. Game fragments stay in 101 with traceable source history; generic fragments have one implementation in Connect. Wire 101's local SDK dependency and remove direct adapter/transport usage. Preserve old protocol fixtures and compatibility evidence; do not claim that moving bytes fixed historic failures.
6. Verify source-to-destination file hashes before intentional boundary edits; record each edited counterpart, commit mapping and provenance afterward. Check imports, both builds, package contents, licences, SDK consumers and game action/recovery behavior. Retain native failures as open release evidence under the owner's exception; do not resume deferred target or administrator capture.
7. Remove only the exact migrated source paths from 101 once destination custody and linked consumer behavior are proved. Record the paired cutover commits and recovery steps. Update /Users/km/Desktop/PROJECT-LOCATIONS.md at that actual move, then remove only owned temporary history-processing files after their processes finish. Keep compact evidence and the recovery manifest.

There is one product source relocation into the final repository. The disposable clone processes history; it is not another maintained home. Once switched, 101 has SDK consumers and game mappings, not a second device platform.

git-filter-repo is not installed on this machine as inspected today. Provisioning the extraction tool, generating the path manifest, running extraction and changing either repository's code are future approved cutover work. Nothing was installed or extracted for this document.

Source migration does not migrate private keys, browser stores, grants, user data, installed apps or native build caches. Any required data transfer needs its own explicit store/tenant mapping, preserved ownership and counts/checksums; it must not activate old authority under a new origin or account.

## 7. The 59 remaining local-group IDs, by owner

Source: [active residual queue](REMAINING-WORK-2026-10-16.md#former-local-grouping-59-ids-action-types-reconciled) and [18 October reconciliation](RECONCILIATION-2026-10-18.md). These are **59 open acceptance IDs, not 59 wholly unimplemented features**. Later partial passes are credited. The historical 32/5/10/7/1/4 action-type classification predates the latest implementation wave and is not a current code-gap estimate.

Each ID has one lead below: **57 platform-led, two Games-led**. Rows spanning both products retain a required Games slice; this lead assignment does not transfer game behavior to the platform or close either slice. No IDs are duplicated in the totals.

### DEVICE PLATFORM — 57 primary IDs

| ID | Remaining work at the existing admitted scope |
| --- | --- |
| T13 | Reconcile optional transport rejection/deferral; benchmark only a justified missing workload. |
| D02 | Reconcile QR/link/manual/enrolled-discovery intake against actual reviewed pairing receipts. |
| D04 | Reconcile the two declared native discovery profiles and uncovered duplicate/quota clauses. |
| D09 | Map every offered ingress to spoof/key/currentness/rate negatives; credit the actual wrong-key/recovery proof. |
| S02 | Complete copied-identity and actual-store coverage without claiming inaccessible clone detection. |
| S03 | Join scoped grants to every admitted caller/operation; retain the completed rate-mismatch/refusal proof. |
| S04 | Complete trust-topology and certificate/peer-binding negatives; retain unexplained browser failures. |
| S06 | Reconcile membership, identity loss and recovery; reuse completed software client-loss proof. |
| S09 | Fill actual receiver replay/epoch/window/deadline/revocation/stale-schema gaps. |
| S10 | Join isolation/resource matrix and missing actual-client cases. |
| S11 | Map abuse categories to bounds and add only missing limits/saturation cells. |
| S12 | Verify caller allowlists and refused native descriptor/recipe dispatch. |
| S13 | Bind every activation caller to exact verified signed bytes and factory policy. |
| S14 | Join installed execution callers to enforced isolation profiles; credit host admission and failure cleanup. |
| S15 | Complete enabled-store/route privacy and visibility coverage; preserve bounded privacy/deletion proof. |
| N14 | Qualify installed native IPC/update/crash lifecycle with held authority; target work remains deferred. |
| N15 | Reconcile finite terminal/SSH operations and the implemented document-summary caller; no universal shell claim. |
| N16 | Join clipboard/filesystem/application operation profiles and current client matrices; native gate remains open. |
| V01 | Join media endpoint/format/grant matrix and uncovered capture/output routes. |
| V02 | Reconcile control/media scheduler separation against every offered media caller. |
| V06 | Reconcile adaptive VP8 acceptance using existing source, installed and refusal evidence. |
| V10 | Preserve synchronization uncertainty/drift evidence and unexplained Firefox prerequisite failure. |
| V11 | Reconcile admitted recording/replay profiles; credit complete selected RGBA clauses. |
| W01 | Qualify actual watch framework bridges on named targets after the move. |
| W08 | Reconcile wearable capability/privacy scope; unavailable physiological resources remain absent. |
| B05 | Complete authorized export/deletion/expiry/secret-separation across retained stores. |
| B06 | Target uncovered persistent store/profile fault and recovery cases; reuse existing quota/close evidence. |
| E10 | Reconcile extension installer callers with integrity, compatibility, privilege and lifecycle evidence. |
| E12 | Qualify named JS/browser/Node and selected native consumers; reconcile fixtures and lifecycle. |
| U02 | Complete device add/inspect states across offered providers. |
| U03 | Complete connection-task source/output/consent/use/interruption/recovery matrix. |
| U04 | Reconcile sharing/ownership states and retain the old unexplained transfer failure alongside newer passes. |
| U05 | Audit plain task language and monochrome product chrome; includes a Games-owned player-surface slice. |
| U06 | Reconcile meaningful capability actions and OS-appropriate navigation/permission recovery in both products. |
| U07 | Complete responsive/state/form-factor coverage; Games owns launcher/controller/game layouts. |
| U10 | Complete loading/empty/stale/busy/denied/expired/interrupted/retry/cancel states in both products. |
| U11 | Complete privacy/recipient/scope/re-entry/revocation UI; physical positive capture remains deferred. |
| U12 | Qualify device/provider/settings/store management; credit Appearance/History focus and store proofs. |
| F04 | Measure a demonstrated bottleneck and retain before/after correctness and security evidence. |
| F05 | Join execution/service scopes to enforced fairness and bounds; qualify uncovered contention. |
| F07 | Qualify declared queue/memory/fan-out bounds with hanging/hostile/cancel workloads. |
| F09 | Fill admitted network/media loss, congestion, no-stuck/no-replay and fresh-recovery cases. |
| F12 | Assemble reproducible latency/capacity claims and full distributions. |
| Q02 | Complete supported schema/profile/revision codec matrix; retain shared future-wire negatives. |
| Q03 | Fill genuine producer/decoder malformed/short/nonfinite/missing/wrong-profile cases. |
| Q04 | Complete actual-boundary identity/permission adversarial cases with incumbent and fresh positives. |
| Q05 | Join lifecycle/ownership/async-race evidence; Games supplies action-release regressions. |
| Q06 | Complete implemented transport/media conformance paths with exact reused receipts. |
| Q07 | Qualify supported browser/runtime/provider rows; Games supplies its UI/action consumer coverage. |
| Q10 | Qualify shipped install/update/offline/rollback families; Games supplies launcher/receiver packages. |
| K03 | Reconcile native distributions, shared fixtures, inventories and clean consumers before adding artifacts. |
| K09 | Complete exact distribution licences/provenance in each product; no inferred redistribution rights. |
| K11 | Verify clean reproducibility and safe corrupt/partial update/migration rollback per product. |
| O04 | Complete enabled operator overload/degraded-mode cases using existing drills. |
| O05 | Join intended credential/key stores to rotation/expiry/revoke/recovery-isolation evidence. |
| O06 | Reconcile required restore stores, exclusions, ownership, revocation, retention and migration. |
| L03 | Assemble each product's local package/bundle/release-note/provenance/licence dry run; no external write. |

### 101 GAMES — two primary IDs

| ID | Remaining work |
| --- | --- |
| N11 | Retain and finish the authored console-receiver integration through the platform SDK; defer Windows/Xbox installation and physical qualification. Console-wide control remains unclaimed. |
| G06 | Complete remaining per-game/mode conventional-control effects, results and restart behavior; reuse completed Spellcaster evidence and defer physical-phone qualification. |

**Games-owned slices of platform-led IDs:** U05/U06/U07/U10/U11/U12 cover its player UI, controller, appearance and recovery; W08 covers any explicitly enabled wearable-to-game path; Q05/Q07 cover action release and supported consumer behavior; Q10/K09/K11/L03 cover its own distributed artifacts. Game action replay/recording presentation remains Games-owned under V11. These are parts of the same IDs, not extra queue entries. Each product must accept its own slice before a cross-product row closes.

The separately grouped **68 real-device/target-OS items, four external-account/authority items and 15 release gates remain deferred until after the move**. This also defers target portions inside the historical local group. Native capture is deferred; no administrator command is requested. Historical native/browser failures remain visible, and no supported-device row or release claim is promoted by this plan.

## 8. Platform additions: proposed only, do not build

These additions belong to DEVICE PLATFORM and are separate from the 59 inherited IDs. Existing narrow features are credited without claiming the expanded capability.

| Addition awaiting approval | Planned responsibility and scope |
| --- | --- |
| Terminal/shell, files, processes and screen capability classes | services/control/ plus generic SDK contracts and native agents. Allow one device to operate another at a low level over multiple concurrent connections, with distinct source/destination, operation, resource, limits and connection ownership. Existing fixed terminal jobs, app surfaces and file profiles are partial foundations, not full low-level control. |
| Permission per device and capability, recorded and revocable control | registry/control policy through the existing grant machinery and kit audit. Record actor, tenant, target device/capability, action, authorization decision, result and safe digest. Revoke future authority, cancel owned in-flight work where supported and release held controls; do not promise to undo effects already completed. A new connection does not inherit another connection's authority. |
| Device ownership through Uynis login, with local fallback | services/registry/ using the kit login connector and verified tenant/principal. Explicit configured local fallback while Uynis is disconnected; no private login/account system and no silent fallback on authentication failure. |
| Over-the-air updates | services/sync/ and agents, using kit keys/files/audit/usage. Versioned signed artifacts, compatibility and staged install, verified results and recoverable rollback; updates cannot silently expand grants. Existing build/update checks do not constitute an OTA service. |

## 9. What belongs to neither product

No existing package or app is left without an owner. The following are not runtime product modules to transfer indiscriminately:

- **Shared Uynis responsibilities:** login/MFA/SSO, metering, audit authority, key custody and object storage belong to the kit/core. Connect calls their connectors; 101 calls Connect for device operations.
- **Repository administration and common evidence:** root policies, the combined historical checklist, original licences and mixed release/build tooling need per-product ownership/indexes and preserved history. They are not a third runtime product.
- **Generated/development data:** node_modules, native build trees, caches, dist, scratch directories and generated release bundles are not source packages. Preserve needed compact evidence/artifacts before removing anything; do not move installed SDK copies or caches.
- **fleet and other families:** the destination mentions fleet as a future machine-side source. No fleet code is part of this 101 move, and no other family is changed here.

For any approved port, permissive upstream code retains vendor/<upstream>/LICENSE, provenance and an entry in THIRD_PARTY_NOTICES.md. Copyleft code is never copied in. Licences and provenance are checked for the exact selected files and artifacts.

Operational rules remain: no git stash, git clean -fdx or git add -A; stage named files; no attribution names added to commits/files; no stopping processes not started by this work. No publishing, deployment, preview URLs, remote writes, new services, code movement or additional capability implementation before the owner's next approval.

