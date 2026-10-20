# Local checklist follow-through implementation plan

> **For agentic workers:** Use the existing local checkout with disjoint ownership. The controller executes the Settings lane and integrates the two bounded workers.

**Goal:** Add evidence for uncovered codec revisions, Spellcaster aim/restart controls, and Settings recovery states; repair only reproduced defects.

**Architecture:** Exercise existing public producers and actual browser consumers. Reuse the preserved production build only after its relevant source and artifact hashes match. Keep failed observations and narrow claims.

**Tech stack:** TypeScript/Node 24.14.0, native Swift/Kotlin codec checks, Playwright Chromium/WebKit.

**Spec:** `docs/platform/MASTER-CHECKLIST.md` Q02/Q03, G06, U12 and their refreshed residuals in `docs/platform/REMAINING-WORK-2026-10-16.md`.

## Constraints and review focus

- Local only; preserve the inherited working tree and real index. No ordinary commit while the full gate remains red.
- Native startup capture is deferred. No startup retry, longer deadline, clock substitution or unrelated native gate run.
- Newer or foreign saved records must remain untouched. Corrupt private choices require explicit reset review.
- Browser evidence must observe the real page/game, not a synthetic replacement consumer.
- Version labels describe separate layers; profile `/1` does not mean wire version 1.
- Result/restart controls must reach the fresh game consumer, and aim must visibly affect its canvas.
- Stop and teardown must join owned native work and close exact owned resources.

## Tasks

1. **Codec worker:** Map actual structured telemetry supported/rejected revisions across JS/Swift/Kotlin/C. Add only uncovered fixture assertions and run their smallest selectors. Retain parser-specific verdicts and native cleanup.
2. **Game worker:** Reuse the existing six-action receipt; add a dedicated actual-canvas aim and natural-result/fresh-run control check. Own Spellcaster source/tests only for a reproduced defect.
3. **Controller:** Add `tools/qa-settings-recovery.mjs`. Seed from actual Settings-produced IndexedDB data, then change one documented field per corrupt/future/foreign fault. Check inert arrival, readable state, disabled unsafe mutations, reviewed reset/cancel, byte preservation, keyboard focus and re-entry. Record the actual Settings/provider action inventory without inventing services.
4. **Controller:** For a confirmed defect, retain the failing selector, apply the smallest shared fix and rerun that selector plus direct dependents. Review exact deltas, run affected types/lint and record the unresolved full gate honestly. Update central evidence once and preserve the wave in a local evidence ref.

Each task is accepted only at its recorded scope. No whole checklist row is assumed complete from a passing subset.
