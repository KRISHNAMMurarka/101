# Bounded structured signals

Base `eadbeb88f1c3388fdd5313db7080221dd967e55b`. M01's first real caller is an
authorized SDK telemetry-batch consumer. It uses actual Node process memory
readings in its runnable example; contract tests use clearly labeled fixtures.
This is structured model/runtime/wire evidence, not physical sensor qualification.
The existing owner approval for inline full-platform implementation applies.

## Model

Extend `ValueSchema` with `{type:'record', fields: Record<string,ValueSchema>,
optional?: readonly string[]}` and `{type:'array', items:ValueSchema, minItems:number,
maxItems:number}`. No undeclared fields, nulls, undefined, sparse arrays, getters,
custom prototypes or executable values. Fields use bounded plain names; unsafe
prototype-oriented names are rejected. A record has 1–32 declared fields; array
bounds are integers `0 <= minItems <= maxItems <= 128`. Schema nesting is at most
four schema nodes along a path, total at most 256 nodes. Existing 64 KiB JSON,
container-entry/depth limits continue to apply; do not raise global limits.

`SignalValue` adds recursive immutable records and arrays. `parseSignalValue`
copies once before recursive validation and returns deep frozen data. A timestamped
batch is an ordinary bounded array of records whose declared timestamp has unit
`ms` and a clock-domain interpretation supplied by its application. There is no
invented global timestamp or silent cross-clock conversion.

Schema compatibility remains exact semantic/capability-version compatibility:
recursive record field names, optionality and member schemas; arrays include
bounds and item schema. Field/optional-list ordering is inert. No silent widening,
dropped unknown member or conversion. Version migration is explicit code in the
example: validate v1, upgrade to v2, then publish under a v2 capability. An old
capability cannot receive a v2 publication without that explicit migration.

## Wire and existing callers

Keep existing `json/1` and normalized-pointer bytes/contracts unchanged.
Introduce `json/2` for structured sample/event values. Control/description
messages remain connect/1; negotiated `json/2` value envelopes use version 2.
`json/1` rejects structured values. The receiver accepts values only for its
negotiated codec and schema. Codecs are advertised from actual capabilities;
old primitive-only callers retain their existing list. Old peers reject new
schema/value versions; the example supplies explicit v1/v2 descriptors rather
than pretending an old peer supports new data.

The existing 4 KiB value-packet limit and separate 4 KiB runtime envelope limit
remain. The runtime counts the observation and copied publish options, including
provenance, so a wire-valid batch can still fail host admission. Publisher success
reports transport handoff, not runtime delivery or physical effect. Wire overflow
fails before queueing or consuming IDs. Runtime `payload-limit` drops the batch
and reports the reason while preserving the active grant; it advances neither
received sequence/operation nor freshness. A smaller batch can recover, while
repeated rejected batches cannot defeat the deadman. Compact normalized-pointer accepts exactly
x/y scalar components and cannot silently drop structured fields. Runtime grants,
readiness, epochs, sequence, source identity, deadline and teardown remain in the
existing implementation.

## First caller and qualification

The telemetry batch declares 1–16 records of `{timestamp, residentBytes}`; v2 adds
optional `quality` (`observed`/`unverified`). A sink computes count/latest memory
value in one embedded clock domain and releases its owned state on stop. A v1→v2
adapter is explicit and bounded; a wrong version fails before delivery. The
runnable Node example samples `process.memoryUsage().rss` and `performance.now()`.

Required tests cover nested positive records/arrays, optional omission/presence,
all malformed/oversized/budget/immutability cases, exact recursive compatibility,
schema editor consistency, runtime authorization and release, version migration,
json/1 rejection, json/2 negotiation/roundtrip, compact rejection and packet size.
Pack a staged immutable tree and compile/run the new example outside the repo;
retain actual source/tool/artifact/runtime identities. Requalify only affected
SDK consumers and existing pointer/core gates. Do not promote native, physical,
future structured profiles or overall release acceptance.
