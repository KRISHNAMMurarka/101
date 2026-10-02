# Application pointer compatibility lane

2 October 2026. Root-authorized bounded T09 application consumer lane; no commit. Actual Input Lab files are `app/components/InputLab.tsx` and new `app/components/RemotePointerPanel.tsx`, rendered under `/studio/input`. Root approved these ownership substitutions before editing; `app/input-lab/InputLabClient.tsx` does not exist.

## Application contract

Input Lab is a diagnostic and intentionally has no `input.manifest.json`. Its game implementation binds `move`, `aim`, `trigger`; its game manifest permits keyboard, mouse, touch, gamepad, custom. This lane declares a narrow application-owned `InputManifest` for its existing aim vector and trigger action in `examples/device-pipelines/game-pointer-bridge.ts`. Generic bridge configuration parses the manifest and requires both mapped controls to declare the explicit owner-selected InputSource in their recommended/fallback lists. There are no per-game branches in platform packages or changes to SDK/game exports.

Owner configuration supplies application/session/player/role/device/clock scope. The Input Lab caller selects player-1 / classic explicitly. An owner call to `approve` selects exactly one compatible `app:pointer-position/1` and `app:pointer-contact/1`, validated against the existing typed profile. Packets cannot select a player, role, action/control, permission or approval. Runtime authorization is scoped to the selected descriptor/capabilities, fixed application/session and the application-owned sinks.

Position intentionally maps from surface-normalized 0–1 into signed aim coordinates with `x = 2x - 1`, `y = 2y - 1`, matching the existing PointerAdapter and Input Lab drawing contract. Contact maps to trigger. The InputFrame source is an explicit owner mapping, validated against supported sources and both mapped controls. The diagnostic selects custom because pointer resources may originate from touch, mouse, keyboard or software buttons; resource/platform/packet metadata does not prove physical touch. Touch remains available only when the owner explicitly selects it and the mapped controls declare it. Application-local channel device IDs are `<owner device>:position` and `<owner device>:contact`, so producer position/contact sequence numbers remain intact and independent; translated receiver timestamps are retained. Replay, wrong source/capability/clock, stale delivery contexts, malformed typed values and undeclared components are rejected before bus publication.

Stop/loss marks the bridge terminal, publishes a visible neutral aim and false trigger at the next sequence for each used channel, and removes only those device contributions from the bus. Existing local/legacy game controller frames remain available. The diagnostic trigger edge reads the aggregate bus action rather than the individual incoming frame so position-only frames do not fake a release/repress of a held trigger.

## First caller and lifecycle

The new small Remote pointer resources panel uses `PeerDataTransport` and the typed receiver APIs through `@101/connect`. It accepts an offer from the native pointer lab or browser Pointer lab in Send pointer mode, returns a hand-transfer answer, then requires the explicit “Allow aim and trigger for one minute” button. It does not use the old 101 transport for the general resource path. The existing legacy controller host in Input Lab is unchanged.

The application wrapper owns its typed sinks/runtime/receiver and fixed grant. The panel owns one interval, peer listener and connection generation; stop/unmount/pagehide dispose them. Approved input stops/releases on blur, hidden document or connection loss. Pre-consent pairing may remain across focus changes to permit copying codes; it grants no game input. Reconnection uses a fresh connection and a fresh consent operation. UI status reports neutral/released stop or failure, with a fresh-offer recovery path.

The panel identifies manual hand transfer as diagnostic possession, not authenticated endpoint identity. This lane provides no physical-device, endpoint-enrollment, photon/display or clock-bound qualification evidence. T04/S04 and hardware qualification remain root-owned/open.

## Evidence

- TDD RED: before bridge source creation, `node --experimental-strip-types --test tests/game-pointer-bridge.test.ts` failed with intended `ERR_MODULE_NOT_FOUND` for the bridge module.
- Additional observed RED: a direct position observation with undeclared z passed before the boundary was changed to use `parseSignalValue`; it now rejects that value.
- Focused tests: 11 pass, zero failed/skipped. Covers owner consent and actual coordinate/control mapping, invalid manifest/mapping/scope/source support, semantic lookalikes, source/context/clock/replay rejection, explicit custom producer meaning and unsupported-source rejection for both controls, packet scope/control injection, neutral/release/removal, immutable configuration, typed value components, real PointerResourceProvider→RemoteResourceReceiver→InputBus negotiation over an in-process peer, loss release and preservation of local controller frames.
- Source-meaning refinement RED: before adding owner-selected source mapping, custom-output assertion failed and unsupported-source regression observed a missing expected exception. Both pass after validating the mapping source and emitting it directly.
- `npx tsc --noEmit --incremental false`: exit 0 on the current working tree, including the new UI and application source.
- `npx eslint examples/device-pipelines/game-pointer-bridge.ts tests/game-pointer-bridge.test.ts app/components/RemotePointerPanel.tsx app/components/InputLab.tsx`: exit 0.

Root remains sole integration/evidence owner and performs browser/built-HTML checks, unchanged-game regressions, native/browser final types and exact-candidate commit gates. No build, publication, deployment, remote mutation, third-party service, SDK export, lockfile or ledger changes were made in this lane.
