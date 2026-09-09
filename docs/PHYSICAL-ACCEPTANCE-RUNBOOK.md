# Physical acceptance runbook

This runbook produces the physical evidence still required by [RELEASE-ACCEPTANCE.md](RELEASE-ACCEPTANCE.md). It does not approve a release, publish anything, or ask anyone to record camera, audio, or personal data.

Run it against a clean production build at one exact commit. Record the commit, build time, browser/version, operating system/version, device model, connection type, and any failure before changing the build or repeating a case. A pass means every stated observation occurred. A skipped case is still pending.

## People, equipment, and receipt

One tester needs a laptop with a camera and keyboard. The full camera case needs two people in view. The controller cases need one physical iPhone and one physical Android phone on the same local network as the laptop. The accessibility case needs an actual screen reader enabled by a tester. Do not use emulators, viewport emulation, fake camera streams, or screen-reader detection as substitutes.

Use this receipt for each case:

| Field | Record |
| --- | --- |
| Exact commit and build identifier | |
| Tester, date, browser/version, operating system/version, device model | |
| Case and game/route | |
| Inputs and orientation | |
| Steps completed and observed result | |
| Pass, fail, or pending; failure reproduction if applicable | |

## Phone controller and touch

For both the iPhone and Android phone, connect through the pairing action shown by the running local host. Assign a controller role, then perform the role's basic actions until the game visibly responds. Move through portrait and landscape while the controller is active. Check that every required control is reachable, the game field remains usable, and a press/release leaves no held action after switching away from the controller, hiding it, or completing the run.

While connected, background the controller or briefly interrupt its network connection, return it to the foreground/network, and confirm that it reconnects to the same active host or follows the product's visible recovery path. Trigger ordinary press, release, and warning/impact feedback where the selected game provides them, then record whether the tactile patterns are distinguishable on the physical device. A controller shown as connected without a game response, an unreachable landscape control, or a stuck action is a failure.

## Camera walkthrough and two-person games

On the laptop, run the complete body-camera walkthrough for BodyDodge and Shadow Arena. Record each outcome below separately:

1. Allow camera permission, choose each available camera, finish placement, confirm with raised arms, start the game, complete a run, and restart it.
2. Deny permission, choose retry, then allow it. Disconnect the selected camera during setup and during a game, then recover through the visible flow. Finish a walkthrough with a selected camera, disconnect it before the next run, and verify the remembered-camera fallback.
3. Wait at least eight seconds on the confirmation beat and use the side-step alternative. Confirm that it completes only while the framing remains valid.
4. With two people visible, verify each person gets a distinct numbered slot. Have them cross, let one leave briefly and return, and introduce a third person. Continue the game through these transitions and record whether controls remain with the intended people.
5. Complete each game once with camera input and once with its declared conventional fallback. Check game-end announcement and focus on **Play again**.

Do not retain images, recordings, or landmark data in the receipt. The observations and environment details are sufficient.

## Keyboard and screen reader

With a keyboard only, start at the player home and complete the chooser, a conventional game run, its result/restart action, and every camera walkthrough beat including cancel, skip, retry, and the eight-second alternative. Focus must always be visible and the current action must be apparent.

Repeat the chooser and one body-camera walkthrough with an actual screen reader. Confirm that headings, controls, selected input choice, camera-placement guidance, failure/retry, skip, and the alternate step are announced in a usable order. The camera option must remain available; the tester may choose a conventional control path. Record the screen reader and browser used.

## Inference and throttling

For a laptop and a physical phone, open **Studio → Vision Lab**, enable the body camera, wait until the **Samples** readout reaches 120, and record its mean, median, P95, and range. Repeat for any hand-camera path intended for release. The rolling readout resets when the camera mode or source changes, so each receipt describes one source and one run.

On the laptop, apply a fourfold CPU throttle in the browser's performance tools before starting the body-camera walkthrough. Complete placement and an actual gesture confirmation under that throttle, then restore normal throttling. Record the throttle profile and the Vision Lab distribution. Do not treat a single frame time, a simulated pose, or CPU throttling as phone evidence.

Run a production Lighthouse audit of the launcher from an installed local audit tool or the browser's built-in auditing facility. Record the Lighthouse version, browser, device/emulation profile, throttling profile, and the complete reported category scores. This repository intentionally makes no score claim until that receipt exists.

## Installed controller update and offline recovery

Use two genuinely different production builds from accepted commits, served at the same local origin. Do not clear browser storage between them.

1. Install or open the controller PWA from build A and keep one controller page active.
2. Replace the server contents with build B at the same origin. Open or reload a second controller page to allow the update to download while the first page remains active.
3. With the first page still active, disable networking and verify that its existing controller page and required assets remain usable. Record the old and candidate worker build identifiers if the browser shows them.
4. Close the old controller page so the update may activate. Open the controller at a deliberately different room URL, disable networking again, and confirm that build B opens that requested room with usable controls.

A missing asset on the old active page, an offline failure after activation, or a cached room replacing the requested room is a failure. A one-build offline reopen is useful supporting evidence, but it does not satisfy this upgrade case.

## Closing and recording

Attach completed receipts to [QA-2026-09-09.md](QA-2026-09-09.md), replacing only the matching pending item with a concise environment and outcome. Retain failed receipts and link the follow-up regression. Update [NEXT-101-STATUS.md](NEXT-101-STATUS.md) only after the source or physical receipt exists. Do not mark the release approved while any case above is pending or failed.
