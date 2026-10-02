# M08 clock and observation provenance contract

## Outcome

An observation can retain its capture clock and timestamp, receiving clock and
timestamp, a bounded remote-to-local capture interval with the map's drift
assumption, and a finite processor chain. A caller can calculate only an age
interval supported by that mapping. Direct comparisons between different
clock identities are rejected. The record is data, not proof that a producer's
reported capture time or clock rate is truthful.

## Timing record

`ObservationTiming` has `{capture,receipt,mapping,processors}`. A stamp is
`{clockId,at}` with a bounded, trimmed non-control clock ID and finite,
nonnegative, safe millisecond timestamp. `mapping` is `null` for the same clock;
then capture cannot be later than receipt. For different clocks, it is a
remote-clock translation `{earliest,latest,uncertaintyMs,maxDriftPpm}` in the
receipt clock. Bounds are ordered and finite; uncertainty equals half the
unclipped interval width and is at most 60000 ms; drift is finite in [0,10000]
ppm. The earliest
possible capture cannot be later than receipt. The latest bound may pass
receipt because the clock map is uncertain; causality clips it only when
calculating age. A mapping is not accepted for identical clock IDs.

`processors` contains at most eight steps, each with a namespaced processor
ID, bounded version, positive configuration revision, and a processed stamp in
the receipt clock. Step timestamps are nondecreasing from receipt onward. The
record's fields are closed, bounded JSON, copied and frozen before use. The
parser cannot authenticate the producer or prove that a claimed interval came
from a real exchange; the receiver supplies map results that it owns.

`observationAgeBounds(timing)` returns `{earliestMs,latestMs}`: exact elapsed
time for a common clock, or [max(0, receipt-at - mapping.latest),
receipt-at - mapping.earliest] for a remote capture. It rejects unsupported or
malformed mappings rather than subtracting raw cross-clock timestamps.
`compareClockStamps(a,b)` orders only validated stamps with the same clock ID;
cross-clock comparisons throw a validation error.

## First callers and limits

`RemoteClockMap` exposes its configured drift ceiling without changing its
existing translation shape. `RemoteResourceReceiver` adds `timing` to its
existing provenance, using its own clock map result and local receipt. Its
existing raw provenance fields remain for compatibility and the 4 KiB runtime
payload cap remains. The embedded temperature processor appends a local
processor step based on runtime-owned capture/receipt fields; source-provided
provenance cannot replace that timing. Existing value and wire formats remain
unchanged.

The map assumes a trusted clock pair and an adequate drift ceiling. This
slice does not certify remote capture truth, physical end-to-end latency,
global clock identity, cryptographic provenance or cross-network timing.
