# Conservative Remote Clock Implementation Plan

**Goal:** Translate a remote monotonic timestamp into a bounded local interval from a four-timestamp exchange.

**Architecture:** One dependency-free `RemoteClockMap` owns a single local/remote clock pair, an offset interval and monotonic watermarks. It provides no latency, capture freshness, clock authentication or global identity certification.

**Tech stack:** Plain TypeScript, Node's type-stripping test runner.

**Authorization and scope:** The integration owner supplied the exact first-caller API and authorized this bounded lane. Only `packages/device-model/src/remote-clock.ts`, `remote-clock.test.ts` and this plan belong to the lane. Exports, schemas, lockfiles, broad gates and commits belong to the integration owner.

## Frozen interface and arithmetic

```ts
new RemoteClockMap({ localClockId, remoteClockId, maxRttMs?, maxUncertaintyMs?, maxDriftPpm?, maxAgeMs? });
map.observe({ localSentAt, remoteReceivedAt, remoteSentAt, localReceivedAt }): boolean;
map.translate(remoteAt, localNow): undefined | Readonly<{
  earliest: number; latest: number; uncertaintyMs: number;
  localClockId: string; remoteClockId: string;
}>;
map.reset(): void;
```

- IDs are distinct, nonempty, trimmed strings of at most 128 UTF-16 code units without control characters. They label the clock pair; identity/authentication belongs to the caller.
- Options are finite numbers: `maxRttMs` defaults to 200 and lies in [0,60000]; `maxUncertaintyMs` defaults to 20 and lies in [0,60000]; `maxDriftPpm` defaults to 100 and lies in [0,10000]; `maxAgeMs` defaults to 5000 and lies in (0,60000]. Bad constructor arguments throw `RangeError`.
- All timestamps are finite, nonnegative milliseconds in their declared clock domain, bounded by `Number.MAX_SAFE_INTEGER`. Let `d = maxDriftPpm / 1000000`, the maximum relative offset change per local elapsed millisecond. The caller must supply an adequate combined oscillator bound.
- An exchange requires `localReceivedAt >= localSentAt`, `remoteSentAt >= remoteReceivedAt`, and remote processing duration no larger than local elapsed duration. The local total round trip, including processing, must not exceed `maxRttMs`. Rejecting a small remote-duration excess caused by drift is an intentional fail-closed limitation.
- The raw offset interval is `[localSentAt - remoteReceivedAt, localReceivedAt - remoteSentAt]`. Anchor it at local receipt and widen both ends by `d * (localReceivedAt - localSentAt)`.
- For an existing, unexpired interval `[low,high]` at receipt `anchor`, first widen it by `d * (newReceipt - anchor)`, then intersect with the new widened observation. Never average offset estimates or assume symmetric network delay.
- Incompatible, invalid or nonmonotonic observations return `false` and clear synchronization. Retain accepted-observation and valid-local-time watermarks, so reacquisition cannot conceal a backward clock. A valid observation can reacquire after those watermarks. `reset()` clears all state and allows an explicitly new clock era.
- Sequential exchanges require local send at/after previous local receipt and remote receive at/after previous remote send. Local receipt must also be at/after the most recent valid `localNow`. Equality is permitted for coarse clock resolution.
- An observation too broad to translate may still return `true`; uncertainty admission happens at translation so a compatible later exchange can narrow it. An expired prior interval is replaced, rather than intersected.
- For translation, `age = localNow - anchor`. Reject unsynchronized, invalid/backward local time or `age > maxAgeMs`. Before drift expansion set `a = remoteAt + low`, `b = remoteAt + high`, and `elapsed = max(age, abs(a - anchor)/(1-d), abs(b - anchor)/(1-d))`. Return `[a - d*elapsed, b + d*elapsed]`, provided its bounds are finite/nonnegative/safe and half its width does not exceed `maxUncertaintyMs`.
- `uncertaintyMs` is half the interval width, including drift. Results are frozen. Valid local time advances the watermark even when a translation fails uncertainty, expiry or remote timestamp admission; backward local time clears synchronization. Invalid remote input alone does not clear synchronization.
- A capture caller uses `earliest` for conservative timestamps/deadlines and requires `latest <= receipt`. Mapping alone certifies neither latency nor freshness.

## Implementation and evidence

- [x] Write real-module tests with independently calculated expected bounds: both offset signs, asymmetric delay, drift and historical timestamps, age/uncertainty boundaries, monotonicity/reset, incompatible exchanges, bounded configuration and clock identities.
- [x] Run `node --experimental-strip-types --test packages/device-model/src/remote-clock.test.ts` before source creation and preserve the missing-module failure as new-feature red evidence.
- [x] Implement the frozen API without timers, global state, browser dependencies or TS parameter properties.
- [x] Run the focused command; fix only demonstrated failures, then hand off exact command counts/results and limitations.
- [ ] Integration owner performs central exports, independent risk review and final exact-tree gates. Do not commit from this lane.

### Lane verification receipt

Focused test command ran six times: four red (one initial test syntax error, one missing new module before source, one independently diagnosed fixture intersection-width error, and one real null-option admission failure) and two green (15/15 tests). Null options now reject rather than using defaults; the fixture's later exchange now has exactly 10ms intersection width. Scoped ESLint ran twice: first red for the control-character regex, then green after replacing it with code-point checks. Scoped strict TypeScript ran twice, both green. Final source passes all three scoped checks. Repository-wide checks remain with integration; no commit, publication or physical-device certification occurred.
