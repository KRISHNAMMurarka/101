# M04 binary and document resource contract

## Outcome and boundary

Provide an installable local resource path for bounded bytes, UTF-8 text and
JSON documents. A typed asset reference is inert metadata, never a URL to
fetch. A caller supplies bytes and explicitly authorizes each read. Transfer
uses ordered chunks and verifies byte count, SHA-256 and declared content type
before bytes can reach the consumer. Cancellation interrupts a pending read and
does not expose a partial resource. The signal `json/1` and `json/2` packets
remain limited to their existing 4 KiB envelopes; resource bytes do not enter
those packets. Remote transport and physical provider qualification are
separate work.

## Public shapes

`AssetReference` has exactly `{id,kind,mediaType,byteLength,sha256}`. `id` is a
bounded namespaced identifier, not a locator. `sha256` is lowercase 64-character
hex. The accepted kind/mediaType pairs are `blob`/`application/octet-stream`,
`text`/`text/plain;charset=utf-8`, and
`json-document`/`application/json`. A document is a JSON object or array,
with no executable or prototype-bearing value. `blob` has no inferred format;
future image/model/media kinds require separate validation. The maximum
resource length is 8 MiB; text and JSON documents are limited to 64 KiB, the
model's bounded JSON envelope. Empty blob and text resources are valid; JSON
documents cannot be empty. The reference is a frozen validated snapshot.

`ResourceChunk` is `{index,offset,bytes}` with index starting at zero, exact
contiguous offsets, a copied `Uint8Array` of 1..16 KiB, and no empty middle
chunks. The producer snapshots input bytes before yielding chunks. The reader
accepts an `AsyncIterable<ResourceChunk>`, enforces the total bound, rejects
missing, duplicate, reordered, truncated or trailing chunks, and assembles at
most the declared size. Chunk count is bounded by the size and chunk limit.
Chunks are verified before any consumer effect; a caller may receive a fresh
copy only after the full resource hash and content-type checks pass. Text uses
fatal UTF-8 decoding, and JSON documents must parse as bounded inert object or
array data. No MIME sniffing or implicit conversion occurs.

`readVerifiedResource` requires a concrete scope
`{principalId,applicationId,sessionId}`, a reference, a source, an
`AbortSignal`, a clock and an explicit authorization callback. The callback
receives the frozen scope/reference and returns a grant with expiry and a
max-byte ceiling. Denial occurs before source iteration. Grant expiry and
abort are checked during reading and before returning verified bytes. An abort
must interrupt a pending `next()` without waiting for the producer. The reader
calls `return()` opportunistically and releases its partial buffer on all
failure paths. A rejected source, malformed chunk, authorization failure,
timeout or digest/content mismatch yields no bytes. The caller owns the grant
and the effect after return; success is verified transfer, not observed target
effect.

## First caller and evidence

The first embedded caller sends a local UTF-8 text document and a JSON
document through the public `@101/connect` facade. It grants only a named
resource to the named principal/app/session, reads chunked data, records
verified content and tests denial, corruption, truncation, trailing data and
abort of a stalled source. Packed Node and browser consumers exercise the
same API. This qualifies a bounded local software contract only, with no
filesystem, browser chooser, network, PDF, image decoder or native claim.
