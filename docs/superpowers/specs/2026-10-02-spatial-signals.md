# Spatial signal contract

## Intended outcome

M02 lets a provider declare orientation, pose, articulated joints and a
coordinate transform without turning them into anonymous arrays. A processor
can explicitly convert a pose between metric frames, including a handedness
change, before publication. Existing scalar/vector/record consumers and 101
game input stay unchanged. This is a local software contract, not a claim that
an unverified sensor knows its physical origin or calibration.

## Declared reference frame

A `SpatialFrame` has an exact namespaced `id`, namespaced `origin`, `unit`
(`m`, `cm` or `mm`), signed orthogonal `axes` (one direction from each
right/left, up/down and forward/backward pair in any order) and `handedness`.
The sign and axis permutation must agree with the declared handedness relative
to the canonical right/up/forward basis. The frame is immutable descriptor
data. IDs alone do not establish frame equivalence; every field participates
in schema compatibility. Different origins never convert automatically.

## Value schemas and values

New `ValueSchema` alternatives are `quaternion`, `pose`, `joints` and
`transform`. They require capability `schemaVersion >= 2`; existing version 1
capabilities retain their meaning. These types use the existing descriptor
64 KiB JSON and schema node-depth/node budgets. Spatial frame declarations
require a separate schema JSON container depth of 10 so a node-depth-four
schema is valid; ordinary values and metadata keep their depth-eight bound.
Parsed schemas and signal values
are independent immutable snapshots. Nested use inside bounded records/arrays
also requires capability version 2.

- `quaternion` declares one frame. Value is exactly `{x,y,z,w}` in that order
  independent of input key order, each finite in `[-1,1]`, with squared norm
  within `0.002` of 1. It denotes an active rotation inside the frame.
  Accepted values are not silently normalized or changed in storage; `q` and
  `-q` remain distinct serialized values of the same physical rotation.
  Rotation arithmetic uses `2 / squaredNorm` so admitted near-unit values
  cannot scale a position or invalidate a projected extent.
- `pose` declares one frame and a positive finite `extent` bounding each
  position coordinate symmetrically. Value is exactly
  `{position:{x,y,z},orientation:{x,y,z,w}}`.
- `joints` declares one frame, extent and 1–32 unique safe joint
  names with an acyclic parent map. Value is a record of exactly the declared
  joint poses; an explicit optional list may omit declared joints. A missing
  parent value does not turn a child into a new root; consumers use the
  declared hierarchy, and all positions remain in the common frame.
- `transform` declares `from` and `to` frames and a positive finite
  `maxTranslation` for each target-space translation coordinate. Value is
  exactly `{translation,rotation,mirrored}`. Rotation is a
  near-unit quaternion in target coordinates. `mirrored` is required and must equal
  whether the frames have opposite handedness. It confirms the parity of the
  signed axis map; it is not a second reflection. It maps source coordinates to
  target coordinates; translation uses the target unit. Nothing derives a
  different physical origin or authorizes control from a transform value.

For `pose`, `joints` and `transform`, embedded position/translation values
have exact x/y/z fields and are finite/in range. Bad norms, unknown/missing
fields, malformed frame axes, duplicate/cyclic joints, size excess and
non-JSON executable values fail before effect. Spatial values use negotiated
`json/2` sample/event lanes; `json/1` and compact pointer codecs cannot carry
them. Wire and runtime 4 KiB limits remain independent.

## Explicit conversion

`createSpatialPoseConverter(sourcePoseSchema, targetPoseSchema, options)`
takes an explicit `{decimalPlaces,maxAbsoluteError}` position unit budget and
an optional validated transform schema/value. If the frames have the same
origin, it derives the signed axis permutation and metric scale. A supplied
transform is then rejected as ambiguous. If origins differ, a transform whose
declared `from`/`to` exactly match is required. For both cases, `B =
targetAxes^T * sourceAxes` is an orthogonal signed permutation. Position maps
as `pTarget = Rtransform * (B * unitScale * pSource) + translation` when a
transform is present, or without the last two operations for a shared origin.
Orientation first maps its vector part by `det(B) * B`, retaining its scalar
part, then the target-space transform rotation composes on the left. This
axial-vector rule agrees with `B * R(q) * B^T` for all signed permutations.
Composition/rotation arithmetic is norm-aware; accepted serialized input is
never silently rewritten. Full source position bounds are projected through
the signed permutation and rotation matrix row sums before accepting the
target extent. The converter validates
input and output poses, returns an immutable result and exposes provenance
metadata with the source/target frames, map and position error bound. The
application supplies the physical transform; the SDK verifies structure,
frames and numeric result, not real-world calibration.

## First caller and evidence

An embedded spatial example routes a watch-style orientation and joint/pose
fixture through a concrete authorized source and sink. It uses the explicit
converter before publishing across a changed metric frame, and records source
frame/transform provenance. Fixtures are labeled simulated; existing native
watch payloads and game input retain their current contracts until separately
qualified. Model, wire, runtime and external packed SDK tests cover right/left
reflection, 90-degree rotation, metric scaling, wrong origin/handedness,
quaternion norm, hierarchy and old version rejection. Independent review and
the exact repository commit gates precede M02 acceptance.
