# Explicit-unit implementation

Spec: [explicit units](../specs/2026-10-02-explicit-units.md). Base `bba4e7e`.
Inline execution is already authorized. The integration owner retains shared
schema, generated assets, evidence and package tooling. No worktree or branch
is needed because this is the sole writer of the current checkout.

1. Add focused REDs in `packages/device-model/src/units.test.ts` for known
   `Cel`/`K`, `m`/`cm`, `By`/`KiBy` and vector conversions, immutable result,
   unknown exact identity, and fail-closed unit/frame/range/budget/precision
   cases. Add a RED for converter-token rejection while preserving descriptor/1
   acceptance. Run
   `node --experimental-strip-types --test packages/device-model/src/units.test.ts`
   and the narrow parser test to record expected failures.
2. Implement only `packages/device-model/src/units.ts` and narrow
   `index.ts` exports. Preserve descriptor/1 syntax and exact
   `schemasCompatible` behavior. Use real schema/value parsers for each
   conversion, never relaxed local copies. Run focused GREEN and generate the
   canonical schema with `npm run schemas:devices`; check its source agreement.
3. Add the opt-in `publishResidentKiBy` entry in
   `examples/device-pipelines/telemetry-batch.ts` and an actual route test in
   `tests/telemetry-batch.test.ts`. Watch that test fail first. Conversion is
   applied before `runtime.publish`; provenance records the immutable map and
   budget. Run focused GREEN and the existing examples.
4. Review the exact diff and meaningful negative cases. Qualify a compiled SDK
   artifact in a clean external consumer if the new export is included. Update
   `SDK.md`, the example README, the M06 checklist row and task evidence with
   exact local scope only.
5. Freeze one candidate and run `npx tsc --noEmit`, `npm run lint`,
   `npm run test:unit`, a fresh `npm run build`, then
   `node --test tests/rendered-html.test.mjs`. Commit only a green exact tree.

Review focus: unit spelling that looks convertible but has no known dimension;
negative affine offset at a range boundary; very large finite magnitudes;
decimal rounding near half steps; target resolutions finer than the source.
