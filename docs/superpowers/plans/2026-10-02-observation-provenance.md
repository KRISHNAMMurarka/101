# Observation Provenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve validated capture, receipt, clock-mapping and processor lineage while rejecting unsupported clock comparisons.

**Architecture:** A focused model parser validates inert timing records and computes conservative age bounds. Existing remote and embedded callers attach records from their own clock evidence.

**Tech Stack:** TypeScript, Node tests, existing `RemoteClockMap`, embedded runtime, packed SDK QA.

**Spec:** `docs/superpowers/specs/2026-10-02-observation-provenance.md`

## Global Constraints

- Work locally; do not publish, deploy, create previews, push, or add services.
- Keep descriptor schema 1, wire formats and the 4 KiB runtime envelope unchanged.
- A timing record is inert evidence, not certification of producer truth or physical latency.
- Run all four repository gates on the exact final tree; build before rendered tests.

## Review Focus

- Different clock IDs without a receiver-owned mapping must never be subtracted.
- A translated latest bound after receipt must produce age minimum zero, not a negative age.
- A future earliest capture must reject, even when uncertainty is broad.
- Processor steps must not jump to a new clock or run backward.
- Getter/prototype/unknown-field inputs must fail before producer data is read.

---

### Task 1: Validated timing model

**Files:** Create `packages/device-model/src/observation-timing.ts`, `observation-timing.test.ts`; modify `packages/device-model/src/index.ts`.

**Interfaces:** `parseObservationTiming(input: unknown): ObservationTiming`, `observationAgeBounds(input: unknown): {earliestMs:number;latestMs:number}`, and `compareClockStamps(a: unknown,b: unknown): -1|0|1`.

- [ ] Write focused tests for same-clock exact age, remote uncertainty, causal clipping, future capture, missing/wrong mapping, cross-clock comparison, processor order/identity and inert snapshots.
- [ ] Run the focused test and observe the missing module failure.
- [ ] Implement closed bounded parsing with `snapshotJson`, ordered steps and conservative age/comparison helpers.
- [ ] Rerun focused tests and TypeScript.

### Task 2: Map and caller lineage

**Files:** Modify `packages/device-model/src/remote-clock.ts`, `remote-clock.test.ts`, `packages/device-web/src/binding.ts`, `binding.test.ts`, `examples/device-pipelines/sensor-feedback.ts`, `tests/device-pipelines.test.ts`.

**Interfaces:** `RemoteClockMap.driftPpm(): number` returns its configured ceiling. Receiver provenance gains `timing`. Processor provenance gains timing with one appended step.

- [ ] Add failing tests for map drift readback, receiver timing fields/age bounds, and processor lineage retaining original capture/receipt.
- [ ] Run the focused tests and observe failures.
- [ ] Add the readback and connect both callers to the parser using host-owned timestamps and map results. Retain old provenance keys and payload limits.
- [ ] Rerun focused tests, TypeScript and embedded examples.

### Task 3: Package and close evidence

**Files:** Update `tools/qa-sdk-consumer.mjs`, `docs/platform/SDK.md`, add M08 QA and receipts, then update checklist and task ledger after verification.

- [ ] Build an immutable SDK tree and run clean strict NodeNext/Bundler, Node and three-browser consumers.
- [ ] Obtain one independent read-only review; reproduce any concrete defect RED before a narrow fix.
- [ ] Record exact producer/tool hashes and honest scope; close only M08 if its evidence passes.
- [ ] Stage the candidate, run TypeScript, lint, unit, fresh build, rendered HTML and the evidence audit; commit locally only on green gates.
