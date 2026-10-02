# Pointer driver implementation lane

2 October 2026. Scope: `packages/device-web/src/pointer-driver.ts`, its adjacent unit tests, and this record. Root owns exports, profiles, callers, native integration, broad gates and evidence. No commits or other source edits made in this lane.

Observable outcome: browser/native callers can feed one pure relative pointer producer. The driver retains normalized absolute position across lift/recontact, rejected sends and resizing. A dimension change re-anchors the local pad without changing the target; subsequent deltas use the new dimensions. Contact edges publish immediately, and current position/contact repeat through caller-owned `tick()` scheduling. There are no timers, DOM/native dependencies or game imports.

Callbacks and options are captured at construction. Position values, publication metadata and returned state snapshots are cloned/frozen. Invalid events and competing touches do not read the clock, refresh output or change local state. Stop is terminal and marks local contact released before a callback. Publisher exceptions and invalid/backward clocks stop and attempt a false contact release. Reentrant stop queues release until the current callback returns. An exception during false release does not recurse.

## Boolean return contract

`begin`, `move`, `end`, `nudge` and `setContact` return false for invalid, stopped or reentrant input. For a valid operation, false also means at least one publication attempted during that operation was rejected, threw, or terminated the driver. A valid coalesced local update returns true if no publication is due. True therefore means local operation success plus admission of every attempted output; it never proves remote receipt or application effect. `state().lastAdmission` is the most recent individual publisher callback result, including a release callback. `release`, `tick` and `stop` return void.

## Cadence and capture timestamps

`sampleHz` accepts finite values within 1–60, and `heartbeatMs` within 20–50 ms. As directed by integration owner, incompatible combinations where `1000 / sampleHz > heartbeatMs` throw: heartbeat must not override the sample cap. Defaults are 60 Hz and 50 ms. All position attempts, including rejected attempts and heartbeat, obey the sample interval. Contact changes/releases bypass heartbeat waiting; unchanged contact repeats at the heartbeat interval. Caller scheduling delays remain caller-owned.

Each newer position change updates the retained absolute value and its actual capture time. Retry of an unchanged unadmitted value retains that original capture time, including heartbeat retries. After admission, idle heartbeat captures current state at its current clock time. Capture timestamps are producer clock values and require the existing publisher/receiver clock contract for latency interpretation.

## Verification

- Before source creation, the complete intended test module ran with `node --experimental-strip-types --test packages/device-web/src/pointer-driver.test.ts` and failed with `ERR_MODULE_NOT_FOUND` for `pointer-driver.ts`, the intended missing-module RED.
- Two additional terminal regressions subsequently failed against the initial implementation: stop after idle reused an old timestamp, and a reentrant clock stop allowed contact resurrection. Both were corrected and passed.
- Focused unit tests: 14 pass, zero failed/skipped. Covers diagonals, no anchor on begin/recontact, resize, clamping, coalescing/loss, capture-time retry, position attempt cap, true/false heartbeat, validation, immutable options/state, general capability IDs, terminal release, clock failures and reentrancy, and callback exceptions.
- Strict focused TypeScript check uses `npx tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --skipLibCheck --types node packages/device-web/src/pointer-driver.ts packages/device-web/src/pointer-driver.test.ts`.
- Focused ESLint uses `npx eslint packages/device-web/src/pointer-driver.ts packages/device-web/src/pointer-driver.test.ts`.

These are pure producer checks. They do not qualify a physical device, real transport, user consent/enrollment or capture-to-render latency. Root performs integration and exact-tree repository gates.
