# Device Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate fresh device health and supported resource claims, and use them to govern the embedded temperature source's readiness.

**Architecture:** A focused model parser and assessment helper produce inert immutable health and readiness data. The existing simulated sensor caller applies only readiness to its runtime.

**Tech Stack:** TypeScript, Node tests, existing JSON snapshot and clock-stamp contract, embedded runtime, packed SDK QA.

**Spec:** `docs/superpowers/specs/2026-10-02-device-health.md`

## Global Constraints

- Work locally only; no publish, deploy, preview, push or third-party service.
- Keep descriptor schema 1 and existing wire format unchanged.
- Provider-reported health/limits are claims; no physical support or quota-enforcement claim.
- Run all four repository gates on the exact final tree; fresh build precedes rendered tests.

## Review Focus

- A stale report or mismatched clock must not produce an available result.
- A report for a different device or missing capability must not be reused.
- Critical thermal, offline connectivity and blocking fault must deny availability even when resource state says available.
- Zero battery alone must not invent an unavailable state; provider and system state govern readiness.
- A health loss after an admitted reading must close pending derived output.

---

### Task 1: Health parser and assessment

**Files:** Create `packages/device-model/src/health.ts`, `health.test.ts`; modify `packages/device-model/src/index.ts`.

**Interfaces:** `parseDeviceHealthReport(input: unknown): DeviceHealthReport` and `assessDeviceHealth(input: unknown, expectedDeviceId: string, capabilityId: string, now: ClockStamp): DeviceHealthAssessment`.

- [x] Write RED tests for exact valid/frozen snapshot, bounds/duplicates/getters, same-clock age, foreign clock, wrong device/resource, blocking global states and non-inference from battery/firmware.
- [x] Run focused test to observe missing module.
- [x] Implement bounded closed JSON parsing and conservative assessment; return limits only when available.
- [x] Rerun focused test and TypeScript.

### Task 2: Embedded readiness caller

**Files:** Modify `examples/device-pipelines/sensor-feedback.ts`, `tests/device-pipelines.test.ts`, `examples/device-pipelines/README.md`.

**Interfaces:** `publishHealth(input: unknown)` parses/assesses the report for `demo-thermometer` and `temperature`, then calls `runtime.setReadiness(sensor, readiness)` and retains diagnostic report.

- [x] Write a RED caller test for healthy limits, offline loss closing a pending derived command, stale report denial and rejected foreign device.
- [x] Run the pipeline test and observe failure.
- [x] Implement the narrow caller and document that reported limits are not dynamic runtime quota enforcement.
- [x] Rerun focused tests and `npm run example:devices`.
- [x] Review found an expiry-on-use gap; reproduce it RED, add runtime readiness expiry and prove pending work cancels.

### Task 3: Package and evidence

**Files:** Modify `tools/qa-sdk-consumer.mjs`, `docs/platform/SDK.md`; add health QA/receipts and update checklist/task evidence after verification.

- [x] Build an immutable SDK tree and run clean strict type, Node and three-browser consumers.
- [x] Obtain one independent read-only review and reproduce any concrete finding RED before repair.
- [x] Record exact hashes, local scope and limitations; close only M09 when verified.
- [x] Stage final candidate; run TypeScript, lint, unit, fresh build, rendered HTML and evidence audit; commit locally only on green gates.
