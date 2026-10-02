# M02 spatial signals implementation plan

1. Add failing model tests for four spatial schemas, strict frames, bounded
   quaternion/pose/joint/transform values, nested version gate and structural
   compatibility. Confirm RED on the previous runtime. Implement parser and
   value checks, then update the editor JSON schema and generated artifact.
2. Add failing converter tests for same-origin metric/axis conversion,
   opposite handedness, different-origin transform, 90-degree rotation,
   accepted near-unit quaternion, full-box bounds, rejected budget and
   mismatched origin/frame. Implement explicit immutable converter with a
   position error bound, and confirm GREEN.
3. Add failing negotiated `json/2` binding/wire tests for spatial sample
   values. Extend only the structured codec classification; preserve `json/1`
   and compact pointer contracts.
4. Add a simulated watch-style spatial source and authorized embedded sink
   example. Exercise real route publication, provenance and teardown, then
   consume the packed SDK externally under strict NodeNext and browser tests.
5. Obtain independent read-only review, fix concrete findings, run exact
   candidate TypeScript/lint/unit/fresh-build/rendered gates, audit evidence,
   commit and record immutable artifact/receipt hashes. Mark M02 complete only
   for the bounded local contract and example; physical calibration and watch
   qualification remain open elsewhere in the checklist.

The controller is the sole writer. Each failing regression precedes the
corresponding implementation. Generated files and ledgers are updated only
after source behavior settles. No remote publication is part of this plan.
