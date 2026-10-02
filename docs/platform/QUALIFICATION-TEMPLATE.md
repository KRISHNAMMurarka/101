# Profile qualification record

Copy this record for one connector/profile/runtime/device combination. A template is Q01 evidence, not a performed qualification. Use the [release contract](RELEASE-CONTRACT.md) and [master envelope](MASTER-CHECKLIST.md#qualification-evidence-envelope-required-per-support-row).

| Field | Record required before acceptance |
| --- | --- |
| Identity | Record ID/revision, catalog row, task IDs, author, date; superseded records preserved |
| Source/artifact | Immutable commit/tree, package/binary/build ID, hashes, sizes and toolchains |
| Environment | OS/runtime/browser exact builds; device/model/firmware; connector/profile/schema/codec revisions |
| Resources | Actual input/output capabilities, units/frames/ranges, sample/format/byte limits; absent/unknown capabilities |
| Discovery/identity | Scope/expiry, enrollment, peer proof and gateway identity limitation |
| Authority | Source/sink owners, principal/app/session, operations/rate/expiry, consent and OS/vendor permission; denial/revocation result |
| Lifecycle | Attach/loss/reconnect/background/lock/process death/teardown; stale generation and held-output release |
| Concurrency | Owner conflict/transfer/observer fan-out/partitions/lease expiry |
| Semantics | Faithful producer bytes/data, calibration/quality, invalid profile/value cases and conversion error |
| Commands | Admission/dispatch/target reply/observed or unverified effect; duplicates/deadlines/cancellation |
| Performance | Capture→processing→encode→transit→decode→sink/render P50/P95/P99; clock uncertainty; loss/queue/bytes/rates/load/CPU/memory/battery/thermal |
| Reproduction | Exact command/actions, fixture inputs, equipment and preconditions; redacted raw receipt path |
| Outcome | Pass/fail/pending/unavailable per case and evidence level; failures, repair regression, retest revision |
| Decision | Accepted exact scope or remaining tasks/equipment/authority; who owns the next action |

Never include pairing credentials, private keys, raw personal streams or stable personal identifiers in committed receipts. Capture only data necessary for the case with consent. A failed or skipped required case remains open. Runtime injection and a human physical journey get separate results. A changed boundary invalidates affected qualification until rechecked on the final candidate.
