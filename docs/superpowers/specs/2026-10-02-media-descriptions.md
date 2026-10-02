# M05 media and render-surface description contract

## Outcome and boundary

A separate versioned media manifest describes track sources, track outputs,
render targets, codecs, capture/output ranges and geometry without changing
descriptor schema 1 or the existing signal wire. A declaration is inert data:
it cannot claim a live track, open a capture device, create a stream or start
a route. The host may calculate a binding proposal only after a concrete
provider probe reports both endpoints available; even a proposal is not an
observed working media route. Actual audio/video capture, transport and
rendering remain V/N qualification work.

## Manifest and validation

`MediaManifest` has `{schemaVersion:1,id,tracks,renderTargets}` with unique
bounded namespaced IDs and at most 32 resources in total. A track declares
`type:'track'`, `id`, `media:'audio'|'video'`,
`direction:'capture'|'output'`, a nonempty distinct codec list of at most
eight canonical lower-case MIME tokens, and one closed property range.
Audio ranges declare sample rate in hertz and channel count. Video ranges
declare pixel width/height and frames per second. All minima and maxima are
finite, positive and ordered, with explicit practical upper caps. A video
render target declares `type:'render-target'`, `id`, pixel width/height and
pixel ratio; audio outputs are tracks, not visual targets. Empty or unsupported
codec lists cannot pass as working capabilities. Unknown keys, non-plain data,
accessors, cycles, oversized input and contradictory properties reject.

The manifest has no `ready`, `working` or permission field; those cannot be
asserted by a remote or static description. Parsed output is deep frozen and
safe to inspect. A codec token is an exact negotiation name, not proof that a
browser, OS or device can encode/decode it.

## Binding proposal

`planMediaBinding(manifest,sourceId,targetId,hostProbe)` takes one capture
track and either a compatible output track or video render target. A trusted
host probe returns live registration IDs, explicit availability, exact codec
support and current output geometry for those concrete resources. It rejects
absent/unavailable/busy/permission-denied probes, unsupported codec
intersection, incompatible audio/video ranges and video geometry outside the
declared source and target bounds. No defaults, silent transcoding, rescaling
or channel mixing occur. A successful result is a frozen proposal with exact
selected codec, compatible capture properties and source/target registration
IDs. It does not start a route or report media frames rendered.

## First caller and evidence

A simulated embedded caller describes one video capture track and canvas
target, asks a trusted local probe for exact support, and obtains a binding
proposal. The same caller demonstrates that an unavailable microphone or
unsupported video codec cannot produce a proposal. Model and packed SDK
tests cover malformed geometry/ranges, duplicate IDs/codecs, static readiness
claims, and unavailable probes. No physical camera/microphone, browser chooser,
media encoder/decoder or remote media route is qualified by M05.
