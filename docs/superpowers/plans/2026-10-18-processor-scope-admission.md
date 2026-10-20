# Processor scope admission implementation plan

> **For agentic workers:** Use the executing-plans and test-driven-development workflows. Keep the inherited checkout and index intact; the repository's exact-candidate gates override intermediate commit steps.

**Goal:** Bound admitted signed interpreter work across host-approved application/session scopes while preserving responsive independent controls and actual-exit cleanup.

**Architecture:** Add a fixed host admission profile to the existing Node-only entry. The trusted host gives each approved scope an opaque object; release data cannot choose a scope, acquire another scope or enlarge limits. Each scope reserves one worker through verification, startup and actual exit, at most 1 MiB guest data and 256 KiB source, and a 100 ms compute token bucket replenished at 100 ms per second. Four live scopes bound aggregate admitted work. Charge each declared construction/process/reset budget before issuance, including failed work, without refund; refuse overload without queueing. Existing standalone executor remains an explicitly host-managed lower-level API.

**Tech Stack:** Existing TypeScript, Node Worker and closed-language interpreter; no dependency or service additions.

**Spec:** `docs/superpowers/specs/2026-10-01-universal-device-platform-design.md`, canonical S14/F05 clauses in `docs/platform/MASTER-CHECKLIST.md`.

## Constraints and limits

- Local only; no publication, deployment, SDK downloads or remote changes.
- Preserve 1,000 ms startup and declared computation deadlines, separate resource grants and current-output fences.
- Guest arena, source/AST limits and coarse Worker V8 limits are distinct. No total-RSS, OS sandbox, general-extension or trusted-factory preemption claim.
- S14/F05 stay open beyond the selected profile; no checkbox closure by narrowing the canonical requirement.
- Shared root/package/config/generated files and evidence ledger remain controller-owned.

## Review focus

- Repeated create attempts must reserve before asynchronous verification and retain reservations through actual Worker exit.
- Retiring an executor or scope must not refund already admitted compute work.
- One scope's exhaustion must leave a separate approved scope usable; requests cannot submit a caller-selected scope identifier.
- Scope/host close during startup must abort and join all owned work without reviving an old scope.
- Invalid signatures/configuration/source and guest memory/compute failures must release admission after actual cleanup.

## Task 1: Admission and lifecycle

Files: `packages/device-runtime/src/processor-node.ts`, `packages/device-runtime/src/processor-executor.test.ts`.

Interface: `createNodeProcessorHost()` returns `{createScope, status, close}`. An opaque scope returns `{create, status, close}`; `create(options)` uses the existing signed executor options and returns the existing asynchronous executor. `budget` is a distinct refused computation result; creation rejects `processor-capacity`, `processor-budget` or `processor-profile` as applicable.

- [x] Add real Worker tests for startup reservation, actual-exit retention, independent-scope work after compute exhaustion, scope count/memory/profile refusal, invalid creation recovery and host close during startup.
- [x] Run new selectors against unchanged source; retain missing-API failure.
- [x] Implement admission using closure-owned scope identity and monotonic token refill; no caller IDs or queues.
- [x] Run the changed executor suite once, inspect all output, retain source pins and raw results.

## Task 2: Independent client and integration

Files: `examples/processor-executor/consumer.mjs`, `tools/qa-processor-executor.mjs`, `docs/platform/SDK.md`, current remaining-work/receipts.

- [x] Route the existing signed public consumer through a host-owned scope and add a real independent-scope exhaustion/control case.
- [x] Preserve exact ordinary caller/dependency provenance and join owned scratch resources before cleanup.
- [x] Freeze the combined SSH/application/processor candidate, obtain independent boundary review, run unique full gates and the shared SDK check once.
- [x] Record implementation, selected validation and remaining target/total-memory limits separately; retain the native startup failure history and exact capture instructions.

Pre-flight: SSH and hosted application workers own disjoint sources. Only the processor public caller uses the new host interface; no shared schema or manifest change is needed. No ordinary commit until all candidate gates pass.

Execution outcome: scoped implementation and installed consumer pass. Full frozen candidate gates pass types/lint/build/37rendered; full units3519pass/2fail. Immutable SDK selector correction passes its exact packaging/rebuild case and type/lint follow-up while preserving ordinary index; zero-JS native startup failure remains unresolved. No ordinary commit. Current WebKit sharing case passes26checks; historical failure cause remains unknown. See canonical18October gate/implementation receipts.
