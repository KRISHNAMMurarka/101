# Structured-signal implementation

Approved scope: [bounded spec](../specs/2026-10-02-structured-signals.md), base
`eadbeb8`. Owner authorized inline execution; no repeated approval. One shared
integration owner retains ledgers, generated schema asset, package builder,
public examples and all final gates.

1. Model lane owns only `packages/device-model/src/{descriptor,sample,
   descriptor-schema,index}.ts` and a new `structured.test.ts`. Implement the
   exact bounded recursive schema/value contract, editor schema and compatibility.
   Observe the focused RED before implementation, retain failure and GREEN.
   Do not touch existing test fixtures or global JSON budgets to force a pass.
2. Root implements new versioned `json/2` values and actual capability-derived
   negotiation in `packages/device-web/src/{wire,binding}.ts`; adds meaningful
   wire/binding regressions, fixes the affected vector-value TypeScript narrowing.
3. Root implements the authorized telemetry-batch example, explicit migration,
   actual Node producer command and external SDK consumer case. No player UI.
4. Generate the canonical descriptor JSON once after model source settles.
   Integrate worker's exact files, run the changed model/runtime/wire/caller checks,
   then immutable packing and external strict/Node/browser tests. Wider hardware
   and native bridge acceptance remain open.
5. Independent read-only review of the frozen parser/version boundary if warranted;
   fix reproduced findings before final freeze. Record M01's exact scope/evidence.
6. Stage one candidate; types/lint/unit/fresh build/rendered; integrate locally.

Each delegated lane sends a compact completion/blocker/decision signal proactively.
No root ledgers, lockfiles, generated JSON or package manifests are delegated.
