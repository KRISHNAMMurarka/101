# Contract and evidence verification — 2 October 2026

Scope: C01–C08 and Q01. Base `26f4eaf`; source is the commit containing this record, with exact source hashes below. This proves contract/evidence tooling and reconciliation, not new remote transport or hardware support.

Environment: macOS 26.5.2 (25F84), Node 24.14.0, npm 11.9.0, TypeScript 5.9.3. Device inventory readback found one paired/available iPhone 16 Pro, no Android endpoint in ADB, and installed but stopped iOS 26.5 simulators. Xcode 26.6 and Rust/Cargo 1.94.1 were observed. No device was interacted with or installed in this phase.

| Check | Result |
| --- | --- |
| `node --experimental-strip-types --test tests/platform-records.test.ts` | 8 passed; historical/current scope, independent levels, exact row binding, missing links, unknown/duplicate IDs, pending/failed tasks and tally drift |
| `node tools/audit-platform-records.mjs` | Pass; 272 stable task IDs, every task evidence entry, 18 support rows and independent levels |
| `npx tsc --noEmit` | Pass |
| `npm run lint` | Pass |
| `npm run test:unit` | 511 passed, zero failed |
| `npm run build` | Pass; fresh output; existing large-chunk/route-classification notices retained |
| `node --test tests/rendered-html.test.mjs` | 31 passed, zero failed |
| `git diff --check` and local document link audit | Pass |

New audit tests first failed with a missing module. The additional current-row acceptance test failed before required-level/row binding implementation: a software-only row incorrectly required physical evidence. The final behavior honors declared required levels without promoting runtime tests into physical verification, and demands row-bound evidence for accepted support.

The first broad unit run failed `a later controller offer failure is reported and backed off without an unhandled rejection`: 507/508 passed; concurrent load delayed the assertion past its 20 ms retry interval. Production records backoff before notifying error listeners. The test now freezes `Date.now` within its own test while retaining real polling timers, so it checks backoff behavior independently of event-loop scheduling. Its focused rerun and full suite pass. No production signaling behavior changed. Early fixture/type checks also identified and corrected missing failed-receipt text and `never[]` test-fixture inference.

The [release contract](RELEASE-CONTRACT.md) defines roles, version policy, supported/candidate/unknown semantics, package/ledger ownership and final release conditions. [Historical reconciliation](HISTORICAL-RECONCILIATION-2026-10-02.md) updates current acceptance/runbook interpretation while preserving original failures. [Qualification template](QUALIFICATION-TEMPLATE.md) requires the complete envelope for every actual support claim. [Catalog](support-catalog.json) and [task records](task-evidence.json) keep baseline/historical/contract evidence distinct. No current physical SDK support is accepted.

The master checkboxes and JSON records close these contract/template deliverables only. All remaining required implementation, qualification, physical, security, performance, distribution and live-publication rows remain open. Local passing gates do not supply release authorization.

## Source fingerprint

The source fingerprint identifies the frozen code below. Receipt files/checkbox status may refer to the containing commit; subsequent implementation records replace that reference with the immutable commit SHA. No hardware receipt is assigned to this source.

| File | SHA-256 |
| --- | --- |
| `tools/audit-platform-records.mjs` | `a20299d29623d546b46d27bb1e71dbd515484f40e05838726fc9171b2dede37b` |
| `tests/platform-records.test.ts` | `7d7600385cb33f175de09d55fc1cd5bfa95cd1b73cf6e3861f971dfcf5581048` |
| `packages/pairing/src/pairing.test.ts` | `558ff4fc7a99f9b41222c6236215d765b5807577e7a6bd7e87ea8209c55c891b` |
| `docs/platform/RELEASE-CONTRACT.md` | `9d687d4a07b68200cbd3413bec3f7a79676f802b1293b5a57cabb18f27045c4f` |
| `docs/platform/QUALIFICATION-TEMPLATE.md` | `b9848d74dd9f2f308deed89011918d622046a4b57c1ddbd7cd094918adbd2ba0` |

Independent read-only review reproduced two audit gaps: target edits retained old row-ID-only qualification, and passing task receipts could lose all paths/levels. Both regression tests failed before repair. Accepted receipts now include an exact target snapshot, and passing evidence requires nonempty receipt paths/levels. Eight focused tests and the real catalog audit pass after repair; no review finding remains deferred.
