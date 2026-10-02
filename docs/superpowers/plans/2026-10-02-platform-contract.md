# Platform contract and evidence implementation plan

> **For agentic workers:** Use superpowers:executing-plans. The owner authorized native inline execution and reversible local changes in the controller handoff.

**Goal:** Complete C01–C08 with a truthful release matrix, independent evidence levels and an executable audit used by release work.

**Architecture:** The Markdown master checklist remains the checkbox authority. JSON records describe support combinations and task evidence; a local audit rejects inconsistent or inflated claims. One integration owner maintains all three.

**Tech Stack:** JSON, Node ESM, existing Node unit runner.

**Spec:** [platform design](../specs/2026-10-01-universal-device-platform-design.md), [canonical checklist](../../platform/MASTER-CHECKLIST.md).

## Global constraints

- Work locally; no publication, deployment, external preview URLs or third-party services.
- Preserve the 20 historical/embedded checks at their recorded scope.
- All 252 initial open IDs remain owned; unavailable physical or release authority stays open.
- Shared schemas, lockfiles, generated artifacts and evidence have one integration owner.

## Review focus

- A historical physical receipt cannot become a current SDK qualification.
- A tested implementation cannot imply physical verification.
- Unknown combinations cannot inherit another device's evidence.
- A checked task needs a passing scoped receipt; pending/failed evidence remains visible.
- Catalog/checklist IDs, local links and tally cannot silently diverge.

### Task 1: Contract, roles, compatibility and ownership

**Files:** Create `docs/platform/RELEASE-CONTRACT.md`; reconcile `docs/RELEASE-ACCEPTANCE.md` and `docs/PHYSICAL-ACCEPTANCE-RUNBOOK.md`; create `docs/platform/HISTORICAL-RECONCILIATION-2026-10-02.md`.

**Interfaces:** Defines catalog target identities, evidence levels, owner roles, migration order and final release conditions. Existing `@101/sdk` and v2/input-q1 remain compatible.

- [x] Name current verified and proposed target versions, transports, resources and unavailable features; map each proposed support claim to Q tasks.
- [x] Record owner/participant/observer/developer/author/admin/operator actions and denial boundaries.
- [x] Freeze package/schema/profile compatibility and exact single-writer ownership.
- [x] Reconcile 1 October receipts chronologically while retaining failures and unmet physical cases.

### Task 2: Catalog and per-task evidence audit

**Files:** Create `docs/platform/support-catalog.json`, `docs/platform/task-evidence.json`, `tools/audit-platform-records.mjs`, `tests/platform-records.test.ts`.

**Interfaces:** `auditPlatformRecords({checklist, catalog, evidence, exists}) -> string[]`; `exists(path)` resolves repository-relative receipt links. The CLI reads the three canonical files and exits nonzero on errors.

- [x] Write tests before the audit exists. Assert empty errors for a closed embedded row with scoped passing evidence; errors for duplicate/unknown IDs, wrong evidence level, missing paths, failed/pending closed rows, stale current support and tally drift.

```ts
assert.deepEqual(auditPlatformRecords(validFixture), []);
assert.ok(auditPlatformRecords(failedClosedFixture).some(x => x.includes('passing evidence')));
assert.ok(auditPlatformRecords(historicalSupportFixture).some(x => x.includes('historical')));
```

- [x] Run `node --experimental-strip-types --test tests/platform-records.test.ts`; expect missing-module red before implementation.
- [x] Implement independent implementation/contract/runtime/physical reference validation, task coverage, historical/current support separation and tally/link checks.
- [x] Populate every canonical task with evidence references or an explicit pending record, reproduction and equipment dependencies. No placeholder completion or inferred support.
- [x] Run focused tests and the real CLI. Freeze the tree, run all repository commit gates (fresh build before rendered checks), and record exact source/environment/result.
- [x] Close only C deliverables actually achieved, update tally and catalog, audit again, commit the green candidate.

## Execution record

- Base `26f4eaf`, clean `main`, Node 24.14.0 on macOS 26.5.2 (25F84).
- Ruling: use the current checkout as authorized sole integration owner; historical docs lane has disjoint paths and no commit authority.
- Ruling: the owner explicitly waived routine plan confirmation. Cost if the contract needs adjustment: a versioned documented migration; no live release has occurred.

- Audit: initial missing-module RED, six tests GREEN; required levels and exact current row binding regression RED→GREEN.
- Broad gate exposed a wall-clock test flake; scoped Date freeze retains real polling and avoids an elapsed-window assertion. Focused regression and complete suite pass.
- Closure includes Q01 because its complete envelope template is delivered here. This creates no qualification claim.

- Independent review: fixed changed-target acceptance and empty receipt/level gaps; both regressions RED→GREEN. No deferred findings.
