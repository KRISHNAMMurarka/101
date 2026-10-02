# Endpoint enrollment screens, 2 October 2026

Base `0de40c1`; implementation is the containing commit. This completes the
planned caller migration and supplies partial evidence for T04, S02, S03, S04,
T07, T09 and N01. No master checklist or support row is promoted.

Browser Pointer Lab, Studio's Input Lab receiver and native PointerLab now use
issued authenticated resource peers. Missing identity storage stays absent until
the owner chooses creation. The receiver creates a five-minute invitation with
its own application/session and fresh epoch. The source reviews that target and
separately chooses to connect. Offers and answers carry only the expected epoch;
they cannot select the receiver's authority. Both owners compare the entire
verified digest and independently confirm the connection. A separate receiver
action then allows Pointer/Contact or aim/trigger for one minute. The code proves
the endpoint connection, not a person or account. UI reconnects repeat enrollment.

Invitation expiry bounds admission. Final owner confirmation and the synchronous
remote-finish admission listener both recheck expiry, including between timer
ticks. Once admitted, the resource grant retains its independently bounded
lifetime. Identity removal, hide, stop, role change and unmount retire the owned
connection and input. Reload closes the old store; subsequent navigation closes
the current store and prevents stale async results from installing a key view.

## Evidence and limits

| Check | Result and scope |
| --- | --- |
| Invitation contract | Two Node tests; closed/bounded/frozen data, current wall clock, fresh entropy, malformed/expired/too-far-future rejection. Missing module observed RED before implementation |
| Browser Pointer Lab | Actual DOM creation, invitation review, offer/answer, bilateral confirmation and separate permission over real Chromium WebRTC; real pointer, arrows and Space reach driver, sinks and DOM marker |
| Studio receiver | Same actual enrollment flow; pointer/key events reach application-owned aim/trigger mapping and original canvas renderer |
| Rejection | Expired invitation, stale offer against replacement invitation, reviewed wrong application, expiry at final confirmation and expiry on actual received remote finish all close without resource admission |
| Recovery and lifecycle | Persisted keys survive reload; one-owner confirmation stays closed; held-key deletion releases output; explicit fresh-key creation reenrolls; hiding either receiver before selection retires proof; reload then actual SPA unmount closes all current stores |
| Narrow screens | 375px viewport/document widths match, reduced-motion browser contexts, wrapped fields; normal focus/scroll and center hit-testing reach direction, contact and remove controls |
| Visual inspection | Masked narrow source/receiver/Studio screenshots inspected; full-page fixed navigation position is a capture artifact, with actual viewport reachability separately verified |
| Native integration | Native TypeScript, scoped lint, 45 affected contract checks and iOS/Android Hermes exports pass on exact linked source hashes |
| Independent UI review | Three actual DOM regressions reproduced before fixes: expired final confirmation admitted input; reload leaked current store at SPA unmount; hidden Studio retained proof before resource selection. Final suites include all three GREEN regressions |
| Integration gates | TypeScript, lint, unit suite, fresh local build and rendered HTML gates required on the exact containing candidate |

Browser receipts use Chromium `149.0.7827.55`, Playwright `1.61.1`, Node
`24.14.0` on macOS `26.5.2`. The consumed repaired build stamp is
`0c218e20131fa391`, with `dist/server/index.js` SHA-256
`ded3e9039e3e6df74256295430ea8310b3f92c3b2c6659d1afd666b697cb8c23`.
Receipt `revision` identifies the base HEAD during the working candidate run;
every recorded consumed source hash was checked against the containing candidate.
Screenshots mask all hand-transfer codes and reviewed targets. Retained stdout
contains redacted structured checks; stderr is empty for both final suites.

The baseline RED receipt ran compiled `0de40c1` behavior and failed because the
actual DOM lacked explicit identity creation. Its working-file source map was
collected while caller files were being edited; the compiled server hash binds
that baseline observation. The three later review RED receipts bind the initial
UI implementation, before the final repaired build. They are not final results.
Expiry fixtures shift the wall clock only during an actual DOM confirmation or
received finish callback; the real packet passes unchanged. Hidden-page fixtures
exercise the actual `document.hidden` branch. Store probes observe real IndexedDB
open/close and same-document SPA navigation; they do not replace storage.

Native receipts establish source integration and export only. Actual native
screen interaction, Expo identity bridge invocation, iOS persisted Keychain
lifecycle, lock-state/hardware protection and physical input remain unverified.
The [core authentication record](ENDPOINT-AUTH-QA-2026-10-02.md) retains Firefox
raw-lane and WebKit ICE failures; browser UI qualification on those engines is
still open. Account identity, wider grants/topology and S16 security validation
remain separate. No support matrix acceptance or release claim follows here.

## Retained evidence and reproduction

- [Pointer browser receipt](receipts/2026-10-02-enrollment-pointer-chromium.json)
  and [Studio browser receipt](receipts/2026-10-02-enrollment-studio-chromium.json),
  with redacted stdout/stderr logs and masked PNGs alongside them.
- [Baseline RED](receipts/2026-10-02-enrollment-baseline-red.json),
  [expiry RED](receipts/2026-10-02-enrollment-expiry-red.json),
  [store cleanup RED](receipts/2026-10-02-enrollment-store-red.json) and
  [hidden receiver RED](receipts/2026-10-02-enrollment-hidden-red.json).
- [Native source/export receipt](receipts/2026-10-02-native-enrollment.json)
  includes source/log/export hashes and explicit unverified acceptance fields.
- [Implementation plan](../superpowers/plans/2026-10-02-endpoint-authentication.md)
  and `endpoint-enrollment-ui-2026-10-02` in [task evidence](task-evidence.json).

With a current local build running on an owned port:

```sh
node tools/qa-pointer-ui.mjs chromium http://127.0.0.1:3002/pointer-lab
node tools/qa-game-pointer-ui.mjs http://127.0.0.1:3002
node --experimental-strip-types --test packages/device-web/src/invitation.test.ts
npm run native:typecheck
npm run native:export
npx tsc --noEmit
npm run lint
npm run test:unit
npm run build
node --test tests/rendered-html.test.mjs
```

All work remains local. The pending owner request for an Xcode signing account
and attached Android phone is unchanged. No publication, deployment, external
preview or third-party service was used.
