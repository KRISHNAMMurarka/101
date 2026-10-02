# M07 measurement calibration and quality contract

## Outcome

A numeric sensor producer can submit a bounded measurement report whose valid
reading carries the producer's calibration revision and declared absolute error
bound in the exact capability unit. Stale and unavailable reports carry fault
codes but no value. Parsing cannot execute getters or turn a loss report into a
valid sample. The existing temperature processor consumes the valid report and
preserves its metadata as provenance; a loss report closes the route and
clears pending output. This does not verify physical calibration accuracy.

## Contract

`parseMeasurementReport(input, scalarSchema)` accepts only a scalar capability
schema. A valid report is `{status:'valid', value, calibration:{revision},
uncertainty:{absoluteErrorBound,unit}, faults:[]}`. The value must satisfy the
capability's scalar range. Revision is a positive safe integer at most
2147483647. The bound is finite, nonnegative and at most the declared scalar
span; its unit must equal the capability unit exactly. These are producer
assertions, not verified physical accuracy.

A loss report is `{status:'stale'|'unavailable',faults:[{code}]}` with no value,
calibration or uncertainty. Fault codes are distinct bounded namespaced tokens;
the list is capped at eight. An empty list permits age or permission loss
without inventing a hardware fault. All fields are closed and the parsed value
is immutable. The parser snapshots JSON first and rejects ordinary own
accessors, non-plain prototypes, cycles and oversized data. JavaScript Proxy
traps may execute during object inspection; a hostile in-process producer
must cross a serialized JSON boundary before calling this parser.

## Integration and limits

`createSensorFeedbackPipeline().publishReport()` parses the report with the
thermometer's scalar schema. A valid report publishes the exact value with
calibration and uncertainty in observation provenance. A loss report calls the
runtime's existing stale/unavailable quality path, so it cannot deliver a new
value. The pipeline retains the last parsed report as diagnostic state and
does not synthesize a valid measurement. Existing `publishTemperature()` stays
for compatibility. The embedded run example uses the new path.

The first slice supports numeric scalar measurements only. Vector/spatial
uncertainty propagation, remote clock interpretation, physical accuracy and
cross-device calibration remain separate work.
