# Explicit units and conversion

## Intended outcome

M06 gives a provider or processor an opt-in way to convert declared numeric
measurements before publishing to a different resource schema. The embedded and
remote route matchers still require exact units. No descriptor, wire packet or
untrusted value can authorize a conversion.

## Contract

- `parseUnitToken()` validates the new conversion contract's bounded ASCII
  spelling: `1`, or alphabetic atoms followed by alphanumeric atoms separated
  by `.`, `/` or `*`. Existing descriptor/1 accepts its original bounded unit
  strings, including ambiguous spelling, to preserve the frozen schema 1
  contract; routes still require exact match. Conversion requires the new
  token form. Structurally valid unknown tokens have identity conversion only.
- `createUnitConverter(source, target, { decimalPlaces, maxAbsoluteError })`
  accepts parsed scalar or vector value schemas. Shape, vector components and
  reference frame must match. Distinct units must be a pair in one reviewed
  dimension: temperature (`Cel`, `K`), length (`m`, `cm`, `mm`), angle (`rad`,
  `deg`), time (`s`, `ms`), mass (`kg`, `g`) or information (`By`, `KiBy`). Unit
  `1` is dimensionless. An unknown token has identity conversion only. Cross
  dimension, unknown-pair and cross-frame conversion fail at construction.
- Conversion uses an affine map `target = source * scale + offset`; all values,
  scale, offset, schema ranges and results must be finite. Input must match its
  declared source schema; output must match the target schema. Failed conversion
  returns no value for publication and does not mutate either input.
- `decimalPlaces` is an explicit integer from 0 through 12. Rounding is to that
  many decimal digits. The constructor computes a conservative worst-case
  absolute error from half the source resolution after scaling (if declared),
  half the output decimal step, and a floating-point margin over the source
  range. It rejects a nonfinite, negative or insufficient `maxAbsoluteError`.
  Runtime checks reject overflow and any observed arithmetic/rounding error
  beyond the declared budget. The immutable converter exposes its map, budget
  and precision for provenance; it does not claim physical sensor accuracy.
- Complete source range must fit the declared target range after conversion and
  rounding. Partial-range transforms require a separate narrower source
  schema. A target resolution, when declared, cannot claim finer detail than
  the transformed source resolution or output rounding step.
- The existing telemetry example uses an explicit `KiBy` to `By` converter for
  an opt-in memory publication method. Its ordinary `By` method remains exact.
  The consumer records conversion provenance and tests real runtime routing.

## Evidence and limits

Focused model tests cover legacy compatibility, conversion-token representation,
temperature offset, metric scaling,
vector frame and dimensions, rounding, budget, range, malformed and overflow
cases. A route test proves exact matching remains and the explicit telemetry
caller delivers converted values. Regenerate the editor JSON from its source;
qualify compiled SDK exports with the existing external consumer. This is a
software contract, not calibration or physical metrology evidence.
