# Rich input event contract

## Intended outcome

M03 gives a provider closed, versioned values for contacts, pen changes, key
transitions, text/IME composition, wheel deltas and relative motion. The six
values retain distinct semantics; no consumer must infer a key edge from a
boolean sample, text from a key label, or relative movement from an absolute
pointer position. This is a local software event contract, not a claim that
every browser/native input surface is available or physically qualified.

## Schema and delivery

The six new `ValueSchema` alternatives are `contact`, `pen`, `key`, `text`,
`wheel` and `relative-motion`. They require capability `schemaVersion >= 2`,
`kind: 'event'` and `delivery.mode: 'reliable'`, even if nested inside a
bounded record or array. Existing descriptor schema 1, capability version 1,
primitive/structured values and pointer provider contracts remain valid. A
new type is never carried as a replaceable latest sample. It uses the
negotiated `json/2` event lane, and the existing separate 4 KiB wire/runtime
envelopes and bounded reliable queues still apply. Sender handoff or queue
admission does not assert receiver effect. These event values carry no
permission; host authorization stays per concrete route.

`contact` and `pen` declare a bounded frame identifier for a normalized
surface. A value has stable bounded contact `id`, `phase` in
`down/move/up/cancel`, `{x,y}` position in `[0,1]`, and `primary` boolean.
Pen adds pressure `[0,1]`, tilt X/Y `[-90,90]` degrees and twist `[0,359]`
degrees. No phase silently clamps or synthesizes a release; disconnect or
provider stop remains an explicit lifecycle concern.

`key` values have bounded physical `code` and logical `key` strings,
`phase` `down/up`, `repeat` boolean, location `0..3`, `composing` boolean and
closed modifier flags `shift/control/alt/meta`. A repeated key is a down
event; key labels are not inserted as text. `text` declares maximum Unicode
code points `1..2048`; its value has a bounded `compositionId`, `phase`
`start/update/end/commit` and `text`. An IME `end` is distinct from a
committed insertion; no implicit commit is generated. Empty text is valid for
start/update/end or deletion commits.

`wheel` declares a finite positive `maxDelta` and carries `{x,y,z}` deltas
within that bound, an explicit `mode` `pixel/line/page`, and the same modifier
flags. Delta mode is never silently converted. `relative-motion` declares a
bounded frame and finite positive `maxDelta`; its value carries `{x,y}`
signed deltas, constant unit `css-px` and `locked` boolean. Deltas are
individually delivered rather than added to a replaceable absolute sample.

All six schemas and values use the existing JSON byte, container, schema
node and depth budgets. Parsed declarations and events are independent deep
frozen snapshots; executable or malformed JSON, unknown/missing fields,
nonfinite/out-of-range numbers, invalid phase/units/modes and unsafe strings
fail before publication. Exact schemas, including frame and bounds, are
required on both ends of a route.

## First caller and evidence

An embedded input event pipeline declares six concrete sources and sinks,
authorizes each route separately, publishes deterministic DOM-shaped
fixtures through the public facade, records the received ordered event log
and clears owned state on stop. It proves separate down/up, composition
end/commit and consecutive wheel/relative deltas without latest-value
coalescing. Public model, runtime, wire, binding and packed SDK tests include
wrong kind/delivery/version, malformed fields, queue bounds and teardown.
Native/browser physical input adapters and game mappings remain separate
qualifications. Independent review and the exact repository commit gates
precede M03 acceptance.
