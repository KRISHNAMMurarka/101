# Backlog disposition — 9 September 2026

Read with [NEXT-101.md](NEXT-101.md). This records implemented work and remaining acceptance work; it does not mark all 101 tasks complete. Everything was done locally. No deployment, external preview, or push was made.

| Items | Disposition and evidence |
| --- | --- |
| 1–4 | Implemented luma sampling, camera enumeration/names/constraints, and explicit camera selection. Setup samples at 4 Hz. Adapter/luma/camera tests; built-in capture and two-camera chooser observed in browser. |
| 5–7 | Adapter-owned unexpected track-end reporting, asynchronous enumeration, and honest availability. The actual InputAdapter contract is an `available` property, not the method described in the backlog. No face capability is advertised. |
| 8 | Saving a plan already existed; the missing-write premise was stale. Reworked completion so skipping never saves success; selected camera/model/person count persist only after gesture confirmation. |
| 9–13 | Remembered-device fallback, target frame, actual classifier gestures, eight-second step alternative, focus per beat, keyboard cancellation, and restored chooser focus implemented. Physical final gesture/alternate-step tests remain pending. |
| 14 | Placement figures were already static; reduced-motion rules cover their transitions. No animation was invented to remove. |
| 15–18 | Multiple backend poses feed stable identities, separate frames and visible numbered players. BodyDodge and Shadow Arena support two camera players sharing team resources. Chooser offers shared camera after enumeration. Crossing, disappearance, return, and a third arrival covered with producer-shaped fixtures. Physical two-person play remains pending. |
| 19–22 | Metric x mirrors with image x; tagged pose arrays preserve world coordinates; legacy arrays still decode. Removed unsupported presence because installed MediaPipe JS drops it. Aspect-correct hand distances have portrait/landscape regression coverage. See VISION-VALIDATION.md. |
| 23 | BeatForge uses a 150 ms punch cooldown, below its tightest chart interval of about 189.87 ms. |
| 24 | Deleted unused MediaPipeFaceBackend; no model/game integration is shipped. Pure face geometry utilities remain tested. |
| 25–26 | Device hints select among available pose profiles; committed lite is the default. Optional full/heavy profiles remain because the explicit model-fetch tool supports them. Startup rejects once; repeated runtime failures report once until recovery. |
| 27–30 | VisionLab uses resize observation, clears recovered errors, clears/replaces simulator timers, and removes the dead start guard. |
| 31–36 | Controller icons, unified active states, differentiated vibration patterns, phase-owned folding, keyboard slider/trigger control, and dense/center/two-pad layout coverage implemented. Physical haptic feel is unverified. |
| 37 | Implemented the bottom dock using the phone deck/planner and the existing host InputBus. Role changes/blur/hide/unmount release inputs. Run completion collapses it. Browser checked portrait, landscape, and fullscreen; physical touch acceptance remains pending. |
| 38–39 | Design completed before dock code: DEVICE-ROUTING.md documents separate simulation/view ownership and independent input/display/audio routes. Same-device screen+controls works through the dock. Remote second views and selective output routing are not implemented. |
| 40–41 | Vision error state now differs by fill/border/weight. Label roles and duplicate declarations consolidated. |
| 42–45 | Runtime/launch/input descriptors and video renderer added to SDK, catalog, registry and schema. Display/audio output capabilities parse and survive the wire. Binary version mismatch errors identify the older side. Remote runtime execution remains outside the local host. |
| 46 | Format negotiation already existed in the session/control path; retained it and documented its revision-scoped q1/JSON behavior. |
| 47 | HardwareDecodedState forwards poses, including metric coordinates, through HID and the real InputBus. Disconnect releases them. Fake HID report exercised; no physical suit claim. |
| 48 | Pending a real reviewed device profile. No shipped game declares HID, BLE or serial, and a skeleton alone is not a game's semantic controls. The required profile/decoder/calibration contract is documented in VISION-VALIDATION.md. No inert Connect suit button was added. |
| 49–52 | Pairing ticket/SDP schema versions separated from gameplay version. PROTOCOL.md consolidated from the existing protocol document and code; upgrade policy and streamed-input descriptor recorded. Live engine/process migration and remote connectors are not implemented. |
| 53–54 | Player copy swept, raw connection errors replaced, misleading network-online Connected label corrected, and studio explanation simplified. Existing copy-table guards plus targeted rendered assertions retained; broad identifier regex rejected because diagnostic callback names are not rendered copy. |
| 55–58 | Multiplayer chooser actions work, dead needs-device class removed, shared result panel focuses Play again, and accessible loading/empty/error states verified. |
| 59–60 | Search, input filter, paging/windowing and a 1000-entry benchmark already existed. Added the requested 50-entry case and fixed narrow intrinsic grid overflow. |
| 61–64 | Studio purpose/entry link and back styles checked. Fullscreen stays inside each game frame, including its dock. |
| 65–68 | Orphan tokens and dead diagram removed; native canonical spacing names match web (deprecated aliases preserve current native geometry). CSS contract now covers duplicate contexts, conditional palette defaults, contrast and viewport hazards. |
| 69–71 | 31 routes checked at 320×740, 740×320 and 2560×1440 in both themes (186 DOM/keyboard-entry smoke checks). Corrected dark canvas overlays in light theme and VisionLab narrow overflow. Representative screenshots inspected; this is not full physical-device gameplay acceptance. |
| 72–74 | Reduced motion retained. Explicit no-print decision in RELEASE-ACCEPTANCE.md. Manifest icons exist; favicon added. Production font paths were found broken, moved to managed assets, and guarded by emitted-file checks. |
| 75–76 | Fake MediaStream/stub backend → BrowserCameraAdapter → InputBus → actual games, plus real KeyboardAdapter → bus → five camera-game mechanics. |
| 77–80 | Rendered chooser counts derive from real manifest/role exports. Deck coverage checks all shipped roles plus stress shapes. Guard forbids per-game camera adapters. Unit tests now auto-discover under bounded source roots. |
| 81–82 | Gzip budgets added to rendered gate. CI configuration runs build then the exact four gate commands; no remote CI run was triggered. |
| 83 | Runtime VM tests cover atomic update/install failure, old-client waiting, matching offline HTML/assets, current-cache lookup, and secret exclusion. Stamper discovers the actual built controller dependency graph, including shared chunks/fonts. The hydrated controller waits for the current URL before connecting, so cached room props cannot select the wrong session. Real installed-PWA upgrade still pending. |
| 84–86 | Native BroadcastChannel through MultiplexLinkTransport exercises version mismatch/recovery. All camera/vision fixture files reviewed against installed producer shapes, uncovering/fixing invisible hips creating identities. TSX/type-stripping constraint documented. |
| 87–88 | Partial: real built-in laptop inference observed at 10.9 ms and 16.4 ms with CPU throttled 4×; these are snapshots, not distributions or a completed placement/gesture run. Phone measurement and full throttled walkthrough remain pending. |
| 89 | Added an eight-second Still opening message with immediate alternative controls. No software percentage/model name is shown. |
| 90–91 | All app animation loops have cancellation; input flash timer now clears. Per-frame layout reads removed from every game, InputLab, MotionLab, CameraSetup and VisionLab. |
| 92 | Pending: Lighthouse is not installed/callable in this environment. No score was substituted or invented. Production bundle/asset verification is available separately. |
| 93–97 | Keyboard entry checked on every route; camera beats/cancel, controller controls, result focus and dock tested in browser. Focus styles/contrast contracts strengthened; muted previews explicitly labelled by body/hands and hidden from accessibility when off. Actual screen-reader, complete keyboard journey on every route, and physical touch passes remain pending. Camera options are not hidden based on attempted screen-reader detection. |
| 98–99 | Repository AGENTS.md and cold-start README written with current commands, package boundaries, local-only rule and verification limits. |
| 100 | Partial: route/theme/viewport smoke matrix and representative interactions recorded in QA-2026-09-09.md. Full phone+desktop gameplay with/without camera is still required. |
| 101 | First-release scope, evidence requirements, blockers and completion rule defined in RELEASE-ACCEPTANCE.md. This is not a release approval. |

The concrete remaining work is hardware/profile integration and physical/device/assistive-technology/performance acceptance, plus remote-screen implementation if selected after the routing design. Keep these open instead of treating a passing unit gate as proof of them.

Final local gate: production build, typecheck and lint pass; **430 unit tests and 27 rendered/build checks pass**. See QA-2026-09-09.md for measured bundle sizes.
