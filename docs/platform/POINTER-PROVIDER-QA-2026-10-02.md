# Pointer source and 101 bridge verification — 2 October 2026

Base `9bf6ec4`; implementation is the containing commit and the source SHA256 maps in the linked receipts. This checkpoint closes T06 scheduling and T09 explicit 101 application mapping. T07 has implemented browser/native binding and a running native simulator caller, but remains open for unresolved native touch movement qualification. T08/T14 require physical iPhone and Android acceptance. T04/S02/S04 authenticated endpoint enrollment, wider native resource inventories and final support acceptance remain open.

The shared `PointerSourceDriver` accumulates relative pad movement into recoverable normalized absolute targets. Begin and recontact establish a local anchor without moving the target; resize reanchors. One active pointer owns contact. Latest samples retain original capture time while admission is blocked; reliable contact edges and heartbeat use the existing bounded publisher. Neither local update success nor native sent counters imply receiver effect. Actual capability-specific binding gates driver creation.

The browser `/pointer-lab` provides independent source/receiver roles, measured geometry, explicit one-minute owner consent, keyboard/directional/contact controls, readable recovery and lifecycle release. Manual offer/answer transfer is bounded and epoch-bound; it does not authenticate endpoint keys. The native app opens a separate source screen that initiates its own actual native RTC channels. The existing game controller remains isolated from that screen.

The 101 Input Lab at `/studio/input` now consumes approved general resources through an application-owned mapping. It explicitly selects the `custom` input source, maps position to signed aim and reliable contact to trigger, validates manifest controls and captures principal/application/session/role scope. Independent position/contact channel IDs preserve their separate sequences. Stop neutralizes and removes only these owned channels. Trigger detection reads aggregate InputBus state, so a position heartbeat cannot retrigger held contact. General platform packages import no game code.

| Candidate check | Result |
| --- | --- |
| TypeScript / lint | Pass |
| Repository unit tests | 628 passed, zero failed |
| Fresh build | Pass; `292576be770640c6`, 34 controller assets |
| Built rendered HTML | 32 passed, zero failed |
| Native TypeScript / existing native unit suite | Pass; 27 native unit tests |
| Android/iOS Hermes export | Pass; exact artifact hashes in native receipt |
| Android native Debug assembly | Pass; 485 Gradle tasks; Debug device build and separate JS export do not prove runtime input |
| iOS device Debug native compilation | Pass with signing disabled; Debug skips embedded JS |
| iOS Simulator Release | Pass with embedded Hermes JS; app launched and native RTC input reached Chromium |
| Chromium actual pointer UI | Pass; [receipt](receipts/2026-10-02-pointer-ui-chromium.json) |
| Chromium actual 101 consumer | Pass; [receipt](receipts/2026-10-02-game-pointer-chromium.json) |
| WebKit two-page pointer UI | Fail; ICE does not establish; [receipt](receipts/2026-10-02-pointer-ui-webkit-failed.json) |
| Native simulator partial observations | Direction buttons, touch/contact transitions, accessible contact toggle and stop pass; virtual drag movement unqualified; [receipt](receipts/2026-10-02-pointer-native.json) |
| Physical iPhone / Android | Unavailable for this candidate; signing account/profiles absent and no Android phone attached |

Browser checks use macOS 26.5.2 (25F84), Node 24.14.0 and Playwright 1.61.1. Chromium 149.0.7827.55 runs two actual UI pages against the fresh local production build. Real DOM pointer/key events reach React handlers, the shared driver, real WebRTC, scoped owner-approved sinks and DOM commits. Both diagonal directions, first anchor/recontact, contact press/release, keyboard equivalents, blur release, receiver resize, bounded responsive layout, stop and fresh reconnect approval pass with no page errors. Eighty mapped JS-capture-to-DOM-commit samples have a conservative upper p50 of 5.73 ms, p95 of 10.54 ms, p99 of 18.75 ms and maximum 19.34 ms. These are local automation measurements, not physical finger-to-display or scanout latency.

The 101 test instruments actual canvas arc arguments while preserving the original renderer. Real source input moves aim from center to approximately (0.7, 0.3), keyboard moves it to (0.68, 0.3), contact triggers, held position heartbeats do not retrigger, a fresh Space edge triggers and Stop restores neutral center. No InputFrame or publisher value is injected. This diagnostic consumer demonstrates the explicit bridge; it does not qualify every game or physical controller.

WebKit 26.5's separate-page offer/answer becomes stable signaling while both ICE/connection states stay `new`, source channels stay `connecting` and no candidate-pair statistics appear. Both documents remain visible. Output remains absent and consent stays unavailable. IPv4 production-origin retry preserves the failure. No root cause or global Safari support conclusion is inferred. The earlier successful one-page synthetic resource receipt retains only its original scope; it cannot replace this failed UI check. Firefox remains unqualified under its prior failed raw peer receipt.

## Reproduced failures and review

- Driver, manual parser, provider and game bridge missing-module regressions failed before implementation. Driver tests cover original capture retention, relative state recovery, no anchor, resize, competing touches, rate/heartbeat, reliable contact and terminal release under failed/backward/reentrant clocks and callbacks.
- A surface grant created at construction expired during a 70-second manual transfer before owner consent. The smallest test failed before moving grant creation to explicit selection. Approval still lasts one minute and is not automatically extended.
- Counting two active bindings incorrectly allowed an unrelated capability to substitute for Contact. The regression failed before the capability-specific `isBound()` check; provider input requires both actual Position and Contact routes.
- Independent review reproduced same-turn native sends exceeding the raw byte limit because installed native JS posts sends without synchronously updating `bufferedAmount`. The adapter now reserves bytes before bridge submission and caps pending commands at 256, including empty payloads. Only exact owned cumulative native sent statistics credit reservations. A malformed bytes/count prefix reproduced a 257th admission before bounded per-message byte endpoints made credit coherent. Stats prove SCTP handoff, not remote receipt or effect.
- Actual iOS simulator offer creation failed. Installed iOS delivery getters are uint16 and expose unset as 65535, unlike Android's -1. A faithful producer fixture reproduced incompatible delivery. Explicit host sentinel selection now normalizes65535 only for locally initiated omitted options; explicit finite 65535 and incoming65535 remain unqualified. Focused 20/20 adapter tests and independent review pass, and actual native offer/data-channel operation succeeds. Android incoming-channel metadata still cannot qualify disposable delivery; native sources deliberately initiate both channels.
- Game bridge malformed extra vector fields and undeclared manifest input sources failed before strict schema/source validation. Eleven bridge tests and independent caller review pass. The owner supplies `mapping.source`; packet/platform labels cannot choose or imply physical input.
- Native virtual drags produced begin/end Contact but no Position movement. A temporary scroll/responder ownership experiment did not change that observation and was reverted. Source logic versus simulator automation has not been isolated; touch movement remains unqualified. Direction controls and accessible contact actions reach the browser, and Stop/background retirement releases output. No virtual gesture is recorded as physical touch acceptance.

Independent final adapter and game consumer reviews report no remaining actionable Important/Critical source findings in their bounded scope. The unresolved native gesture and failed WebKit UI are qualification failures preserved above.

## Physical dependencies and reproduction

The available physical iPhone 16Pro is on iOS 26.5. Local signing attempts found no configured Xcode account/profiles for the existing team; standard provisioning-update retry also failed. No team identifier, credential or device identifier is saved here. The owner has been asked to configure Xcode → Settings → Accounts and attach an Android phone with USB debugging. Simulator, unsigned native compilation and exported JS cannot close T08/T14.

Run the repository commit gates, `npm run native:typecheck`, `npm run native:test`, `npm run native:export`, then start the fresh local build with `PORT=3002 npm run start`. Run `node tools/qa-pointer-ui.mjs chromium http://127.0.0.1:3002/pointer-lab` and `node tools/qa-game-pointer-ui.mjs http://127.0.0.1:3002`; the WebKit variant preserves its failed case. Native source reproduction uses the app's Open pointer lab → Create connection, manual offer/answer exchange with the browser receiver and receiver consent. Direction/touch/contact/Stop observations must name their actual simulator or physical environment.

The [implementation plan](../superpowers/plans/2026-10-02-pointer-provider.md), lane records and [SDK guide](SDK.md) specify the interfaces. No support catalog row is promoted to accepted by this checkpoint. No push, deployment, external preview or third-party service was performed.
