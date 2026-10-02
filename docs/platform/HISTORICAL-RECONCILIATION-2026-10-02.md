# Historical acceptance evidence reconciliation — 2 October 2026

This note reconciles the dated receipts in [QA-2026-10-01.md](../QA-2026-10-01.md)
with the standing [release criteria](../RELEASE-ACCEPTANCE.md) and
[physical runbook](../PHYSICAL-ACCEPTANCE-RUNBOOK.md). It preserves failures and
scope limits; it does not grant release approval. The [J rows](MASTER-CHECKLIST.md#j-existing-101-supporting-receipts-already-present)
remain historical supporting receipts. Every [G row](MASTER-CHECKLIST.md#g-finish-the-101-reference-applications-release-acceptance)
remains open for a complete pass on the final accepted candidate.

## Chronology and disposition

Read sections of the QA receipt in their written order. Each later follow-up is
additional evidence and may supersede an earlier availability snapshot, but it
does not silently erase an observed failure:

| QA anchor | Evidence and historical disposition |
| --- | --- |
| [Android Pixel Fold API 36](../QA-2026-10-01.md#android-pixel-fold-api-36) | Emulator browser rendering, native launch, and signaling progress were observed. Connectivity did not complete through emulator NAT; this remains a failed/uncompleted emulator attempt and is not physical-phone acceptance. |
| [Desktop Safari](../QA-2026-10-01.md#desktop-safari) | One launcher/Slashstorm route reached a run result; a later pass rendered chooser/game navigation. Safari remained hidden to Web Inspector and its game clock did not advance, so the latter is visual/navigation smoke, not live gameplay or camera evidence. The earlier opening hang and automation timeout remain recorded. |
| [iOS Simulator native Link](../QA-2026-10-01.md#ios-simulator-native-link) | Simulator role assignment, UI rotation, and handedness were observed. This did not qualify physical thumb reach, touch response, haptics, or network recovery. The Xcode stat-cache stall was later worked around; it is not an acceptance pass. |
| [Live laptop camera inference](../QA-2026-10-01.md#live-laptop-camera-inference) | Completed built-in-camera timing samples are measurements on the Mac. Incomplete sample attempts remain failures/incomplete runs; no person completed the placement and gesture walkthrough under 4× throttle. |
| [Empty-frame and physical iPhone access](../QA-2026-10-01.md#follow-up-empty-frame-inference-and-physical-iphone-access) | A focused regression fixed inference counting with no detected person. The 120-frame 4× run still executed on the Mac, even though the iPhone supplied Continuity Camera frames. It is neither phone-side inference nor the required person-led throttled walkthrough. The attempted physical Safari controller connection had no completed pairing/game response. |
| [Signed physical iPhone build](../QA-2026-10-01.md#follow-up-signed-physical-iphone-build) | Signing, verification, and installation succeeded, but iOS denied launch as Untrusted Developer twice. This denial remains part of the history; the later profile-trust follow-up superseded it for launch status. |
| [Physical iPhone Link connection](../QA-2026-10-01.md#follow-up-physical-iphone-link-connection) | After profile trust, physical same-LAN pairing and background/process-restart reconnect succeeded. No verified touch changed the host game's score; Mirroring taps were rejected. There was no network-interruption test. Thus pairing/reconnect support is evidenced, while human gameplay, orientation, haptics, and network-loss acceptance remain open. |
| [Current local candidate verification](../QA-2026-10-01.md#current-local-candidate-verification-8ca7208) | The recorded web/native/watch/desktop checks passed on the stated local candidate. The note that no Android phone appeared in ADB describes that verification run; it is not a claim about later OnePlus work. Scripted browser checks and Safari smoke do not establish complete physical or Safari acceptance. |
| [Physical Android setup and watchOS target](../QA-2026-10-01.md#physical-android-setup-and-watchos-target-follow-up) | Initial OnePlus availability was limited and produced no phone interaction receipt. Emulator signaling still failed to reach an assigned role. Watch target/build/signing and simulator evidence exist, but no physical watch or sensor evidence exists. |
| [Physical OnePlus swipe follow-up](../QA-2026-10-01.md#physical-oneplus-swipe-controller-follow-up) | This later section supersedes the earlier OnePlus availability snapshot: the unlocked Android 13 phone paired over wireless ADB and ADB-injected swipes changed the Slashstorm score. It establishes injected transport-to-game response, not human gameplay, ergonomics, haptics, long-session behavior, or complete recovery. The prior emulator failure remains unchanged. |
| [Slashstorm free-stroke correction](../QA-2026-10-01.md#slashstorm-free-stroke-correction) | The rebuilt host and native controller were exercised with injected diagonal swipes, including a 298-point run. The receipt explicitly identifies automated input; subjective feel and measured finger-to-pixel latency remain unproven. |
| [QR scanner and screen glare](../QA-2026-10-01.md#qr-scanner-and-screen-glare) | Physical OnePlus layout, light, and injected pinch zoom receipts exist. The phone was not optically aimed at the laptop QR; decode reliability, screen glare, and scan speed remain unverified. |

The QA receipt's early statement that no Android phone was available is an
accurate snapshot at that point in the chronology. The later OnePlus follow-up
updates availability and establishes injected controller interaction. Neither
statement changes the fact that a human acceptance session is pending.

## Current checklist interpretation

J01–J08 are checked as the limited supporting evidence described by their rows.
Their checkmarks do not mean the full release criterion is closed. G01–G17
remain open as written. Specifically:

- Safari smoke does not close G01; active-page gameplay, full navigation and
  camera paths remain outstanding.
- iPhone pairing/reconnect and OnePlus injected swipes do not close G02–G04.
  Human play, reachable controls across orientations, recovery, comfort,
  simultaneous touch and feedback still need observation.
- Pinch/torch UI checks do not close G05; optical QR acceptance is outstanding.
- Neither device smokes nor the candidate's scripted checks close G06–G07's
  complete game/control matrix.
- Live laptop inference samples do not close G08–G14. A person-led camera flow,
  failure recovery, real two-person play, actual assistive-technology journey,
  phone-side distributions and the throttled human walkthrough remain required.
- Local/automated offline evidence does not close G15's physical two-build
  installed-PWA upgrade and offline-room procedure.
- Watch target/signing/simulator work does not close G16's physical watch and
  specialist-profile acceptance.
- Local gate and Lighthouse results are dated candidate evidence, not final
  sign-off; G17 requires applicable candidate gates, Lighthouse, and completed
  runbook receipts.

Update these dispositions only when a matching receipt names the exact candidate,
environment, performed actions, observed result, and pass/fail/pending status.
