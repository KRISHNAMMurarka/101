# Measurement Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate producer calibration, uncertainty, fault and loss meaning for numeric samples, then exercise the contract through the embedded temperature caller.

**Architecture:** A focused model parser returns immutable discriminated reports. The existing example maps valid reports to runtime observations with exact provenance and loss reports to runtime readiness invalidation.

**Tech Stack:** TypeScript, Node unit tests, existing `snapshotJson`, `parseSignalValue`, embedded runtime, packed SDK QA.

**Spec:** `docs/superpowers/specs/2026-10-02-measurement-quality.md`

## Global Constraints

- Work locally; no publish, deploy, preview URL or third-party service.
- Descriptor schema 1 and the 4 KiB signal wire remain unchanged.
- All reports are bounded, closed, immutable data; no physical accuracy claim.
- Run the four repository commit gates against the exact candidate tree, with a fresh build before rendered HTML tests.

## Review Focus

- A getter on the report or nested calibration must not execute.
- A fault/loss report must not contain a value or generate a relay command.
- A mismatched uncertainty unit must reject without conversion.
- A changed producer calibration revision must remain distinct in derived provenance.
- A valid reading above the declared scalar range must reject.

---

### Task 1: Measurement report parser

**Files:** Create `packages/device-model/src/quality.ts` and `quality.test.ts`; modify `packages/device-model/src/index.ts`.

**Interfaces:** Produce `parseMeasurementReport(input: unknown, schema: ValueSchema): MeasurementReport` and export `MeasurementReport`.

- [ ] Write `quality.test.ts` with a valid Celsius report and assertions for frozen output, wrong units, value range, nested getter, unknown fields, duplicate/oversized faults, loss carrying a value and calibration revision bounds.
- [ ] Run `node --experimental-strip-types --test packages/device-model/src/quality.test.ts`; observe the missing export failure.
- [ ] Implement a parser that calls `snapshotJson` before property access, validates an exact scalar schema via `parseValueSchema`, checks closed shapes and bounds, and returns frozen canonical objects.
- [ ] Rerun the focused test and `npx tsc --noEmit`.

### Task 2: Temperature producer integration

**Files:** Modify `examples/device-pipelines/sensor-feedback.ts`, `tests/device-pipelines.test.ts`, `examples/device-pipelines/README.md`, `docs/platform/SDK.md`.

**Interfaces:** `publishReport(input: unknown)` uses `parseMeasurementReport` and existing runtime `publish`; `state().lastReport` exposes the immutable parsed diagnostic.

- [ ] Add a failing pipeline test: valid report reaches the relay with exact calibration/uncertainty provenance; unavailable fault report closes the route and yields no further command; invalid report leaves prior state untouched.
- [ ] Run `node --experimental-strip-types --test tests/device-pipelines.test.ts` and observe the new test fail.
- [ ] Implement the narrow wrapper and switch the embedded run example to it, keeping `publishTemperature` unchanged.
- [ ] Rerun the pipeline test and `npm run example:devices`.

### Task 3: Package, review and close evidence

**Files:** Modify `tools/qa-sdk-consumer.mjs` only if needed for explicit parser/type coverage; add `docs/platform/MEASUREMENT-QUALITY-QA-2026-10-02.md` and receipts; update checklist and task evidence after QA.

- [ ] Build an immutable SDK tree and run the clean external Node, strict type and three-browser consumer.
- [ ] Obtain one independent read-only review of the frozen candidate; reproduce each valid finding RED before repair.
- [ ] Link exact receipts and scope; update M07 only when its local contract is verified.
- [ ] Stage the exact candidate; run `npx tsc --noEmit`, `npm run lint`, `npm run test:unit`, `npm run build`, then `node --test tests/rendered-html.test.mjs` and the platform audit.
- [ ] Commit locally only if all gates pass.
