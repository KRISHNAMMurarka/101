# Browser restart qualification

**Goal:** Prove that reviewed processor installations and publisher revocations survive three genuine native browser processes using one owned persistent profile, while management approval, routes and live use remain inactive on each arrival.

**Architecture:** Extend the existing literal durable processor QA caller with an opt-in persistent profile. Reuse its native Storage/Web Locks/WebCrypto observers, keyboard approval journey, framework retirement and served-byte guards. Observe actual native child processes through a passive Node spawn observer; never replace storage, return values, permissions, clocks or application behavior. Existing warm and cold-document modes retain their meaning.

**Tech Stack:** Node, installed Playwright Chromium/WebKit, existing locally built Vinext app, native persistent browser profiles, immutable local Git evidence refs.

**Spec:** Existing reviewed persistence contract in `app/settings/processors/processor-management.ts`, `packages/device-web/src/processor-installation-storage.ts`, `docs/platform/receipts/2026-10-07-durable-processor-management.json`, and U12/E10 in `docs/platform/MASTER-CHECKLIST.md`.

**Global Constraints:** Work in the already authorized main checkout with one integration owner. Local loopback only. No publication, remote changes, accounts or physical-device acceptance. Keep actual 30-second approvals and operation bounds. A test of existing behavior may pass without a production fix; do not invent a bug or manufacture a red result. If genuine behavior fails, retain the old failing execution before the narrowest production fix. Every candidate commit requires types, lint, the complete unit suite, a fresh build, rendered HTML and platform-record checks. Preserve and read back all evidence before deleting owned scratch/profile folders; join actual native children and callbacks first.

**Review Focus:** Ensure process restart cannot be confused with a new page, storage-state export/import, profile reseeding or JavaScript counter reset. Check failed setup/close paths, exact profile ownership, native child closure before reuse, actual served build binding, inactive restore, fresh independent input/output approvals and persistent revocation. Toolchain and physical/account/AT limitations must remain explicit. The historical sharing proof must remain pinned to its executed tree and only carry forward when selected runtime inputs match.

## Task 1: Author and execute the literal restart regression

**Files:** `tools/qa-durable-processor-management.mjs`; the matching new receipt and task evidence; selected sharing receipt/checklist evidence; this plan. No production file changes unless a genuine failure demonstrates a bug.

**Interfaces:** Existing served proof contains source, tool and build SHA-256 pins. The root owns the loopback app and the output/profile parent. The QA tool creates an empty uniquely named profile beneath that parent, reports actual process lifetimes, and never deletes it before all process returns settle. Root retains compact proof and removes the completed profile after review.

1. Add opt-in `--cold-browser ABS_PROFILE_PARENT` to the existing QA caller. It creates an owned profile with `mkdtemp`, launches a persistent native context and installs the unchanged local-only network routes and native observers for every process. Record actual child PID, executable hash, profile argument and native close outcome. Reject conflicting cold-document/feature-red options. Preserve the original modes.
   Expected: syntax check passes; no application behavior is changed.
2. Before either fresh arrival, retire the prior actual task/document and pending HTTP/body reads, close the persistent context/browser, and await the observed child close. Reopen the exact same profile in a different native process. Record two reopens and three joined process lifetimes. Continue the existing signed inactive save, independent live approvals, publisher revoke/removal and blocked restore journey.
   Expected: both engines prove inactive restore and revocation persistence with three distinct processes. A product failure remains a genuine failing receipt, not a rewritten expectation.
3. Verify the proof fails closed for a missing/mismatched input before browser dispatch. Run the real restart journey against the current application with a source/build binding; preserve full receipts, served modules, logs and close outcomes. Verify the unchanged cold-document behavior if the shared helper changed.
   Expected: negative binding refusal; real native results and cleanup fully joined, with no physical/account/profile-portability claim.
4. Refresh sharing and processor selected-software evidence honestly; keep whole task dispositions open. Preserve raw native receipts and independent review under immutable refs. Freeze the resulting candidate; run each required broad gate once against it and conduct one independent whole-batch risk/evidence review.
   Expected: all exact-candidate gates green and review clear, or a precise retained blocker with no commit.
5. Commit the coherent local batch after acceptance binds the final tree and evidence. Verify the clean checkout. Remove only owned completed scratch/profile/workspace folders after stored-blob readback and process joins. Continue to the next achievable backlog lane.
   Expected: local verified integration; no push, deployment, support-row acceptance or false whole-task closure.
