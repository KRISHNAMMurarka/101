# Embedded foundation verification — 1 October 2026

Candidate: the commit containing this report, based on `a5ab3df`.
Scope: `@101/device-model`, `@101/device-runtime`, `@101/connect`, generated schema,
workspace integration and two standalone simulated consumers. No transport, native device,
player UI or game behavior changed in this stage.

## Verified results

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | Pass |
| `npm run lint` | Pass |
| `npm run test:unit` | 503 passed, zero failed |
| `npm run build` | Pass; fresh server/client output |
| `node --test tests/rendered-html.test.mjs` | 31 passed, zero failed |
| `npm run example:devices` | Pointer, ownership transfer, observed and unverified sensor outcomes pass |
| `git diff --check` | Pass |

The 46 added tests cover 12 model/schema cases, six lease/queue cases, 17 runtime
cases, nine consumer cases and two public-package/schema boundaries. Existing 457 tests
remain green. Independent read-only review found no remaining actionable issue after
three reproduced runtime findings were fixed.

The build reports existing large-chunk and vinext route-classification notices. The rendered
compressed-bundle budget checks pass. Ajv 6.15.0 was already installed transitively; it is now
an explicit development dependency for schema fixtures. Offline workspace installation
added three local package links, with no third-party runtime addition. Regenerated dependency
license inventory also reconciles earlier lockfile changes.

## Regression evidence

| Boundary | Red evidence before repair | Final behavior |
| --- | --- | --- |
| Model/runtime/consumer API | Missing-module failures before their implementations | Public facade and both consumers run |
| Descriptor traversal | Aggregate budget test inspected a later nested object after overflow | Traversal stops at byte/node limits |
| Processor turns | Downstream output applied in the same flush | Derived work waits for a later flush |
| Async workload | Replacing a cancelled route started another provider beyond capacity | Unresolved work retains the global budget slot |
| Partition output | Apply context had undefined partition | Apply/release identify the owned partition |
| Reliable cadence | Two commands applied at time zero with a 1 Hz grant | Effective grant rate limits dispatch |
| Loss sequencing | Sequence 1 loss closed a route after sequence 10 | Clock/time/sequence checks precede invalidation |
| Late evidence | Unresolved expired command history disappeared | Record remains pinned through completion, then bounded retention |
| Processor recovery | Rejected output suppressed later authorized set-state | Hysteresis resets on rejected admission |
| Derived freshness | Derived deadline extended beyond measurement lifetime | Deadline is capped by original reading expiry |
| Generated schema | Standalone schema missing | Checked-in schema equals model export byte for byte |

## Observable examples

- `{ x: 0.2, y: 0.8 }` maps to `{ x: 200, y: 400 }` on a 1000×500 application surface.
- A second exclusive owner receives `busy`; after release its authorized route starts.
- `31.25 Cel` reaches an app-owned threshold, retaining upstream identity/time/quality and
  calibration provenance. Both processor route legs need independent grants.
- Simulated relay dispatch remains `unverified` without feedback. A separate simulated read
  supplies `observed` evidence. Upstream loss resets the processor and cancels pending output.

## Scope still to implement

This report verifies providers in one process. It does not establish physical phone pairing,
OS cursor control, internet/relay connectivity, arbitrary LAN inventory, Bluetooth/IR/IoT
connectors, media streaming, privileged agents, or publication/distribution. Those remain
the later [platform stages](../superpowers/specs/2026-10-01-universal-device-platform-design.md).
The earlier [101 release acceptance](../RELEASE-ACCEPTANCE.md) retains its independent device
and human testing status.
