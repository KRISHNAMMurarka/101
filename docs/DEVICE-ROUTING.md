# Device input and output routing

Design recorded before implementation, 9 September 2026. This is the contract for
work items 38–39 and 50, not a claim that remote screens are implemented.

## What prevents a second view today

`GameHost101.launch` creates one `Engine101` with one game context. Each call to
`useGameHost` creates a new host and engine. The React game component creates its
renderer, scene, audio, input adapters and draw loop in `onReady`; teardown owns all
of these. Mounting the component twice therefore starts two simulations, even with
the same session code. It does not add another view of the first simulation.

`Renderer3D101` itself is not a singleton. It owns a canvas, scene and camera and can
be instantiated twice. The missing boundary is a view factory taking a shared game
context and a canvas, with teardown that disposes only the view. The SDK presently
exports simulation definitions but no portable view factory, snapshot schema, or
remote display protocol. The host does not serialize arbitrary state (which can
contain class instances and runtime references).

A device can already contribute input and show a local game through keyboard,
touch or camera. A bottom-edge controller deck can share the same host's InputBus;
it must not call `launch` or create a second session. That is the first supported
combined screen/controller mode. A remote second screen needs the view boundary
and a versioned snapshot contract before UI can truthfully offer it.

## Routing model

A device's roles are independent, not an exclusive controller/screen enum:

- Input: zero or one session role assignment, validated against required capabilities.
- Display: zero or more subscriptions to declared views, requiring `display: true`.
- Audio: zero or more output subscriptions, requiring `audioOut: true` and an explicit
  playback unlock. Existing `speaker` plus `speakerAudio` remains the private-cue contract.

Each output route records device id, game id, view id, visibility scope (shared or
one assigned player's private view), and a session revision. Never broadcast a
private view to every display-capable device. Capabilities do not grant access.
The session host owns route changes; input cannot self-assign a role or private view.
Unknown/disconnected devices, unknown views, stale revisions and incompatible
capabilities fail without disturbing existing routes. Disconnect removes that
device's routes and releases held input. Losing a screen does not stop other devices.

A future `configureViews` capability must declare view factories and state schema
versions before `routeDisplay`/`routeAudio` UI ships. Do not add placeholder screen
buttons that cannot render a game. Keep output routes separate from `RoleAssignment`
so screen-only devices do not consume player seats and a phone can fill both roles.

## Upgrade during a session

Current wire support is v2 only. A v3 host may accept v2 JSON only after a v2 codec
is retained and tested; changing the version constant is not negotiation. Pairing
schema versions now evolve independently, so updating gameplay does not itself
expire an outstanding invitation.

For a supported rejoining controller, preserve its role, clear held inputs and
compact packet profiles, announce its supported versions/features again, then send
a fresh assignment and configuration revision. Resume input only after that
configuration. Never reinterpret v2 binary bytes as v3: fixed layouts need an exact
codec/version match. Use JSON when both peers support it but no compact format fits.

For incompatible peers, reject that peer with an update direction and retain the
running game and other devices. Offer conventional input; the owner chooses whether
to pause. No silent disconnect/restart of every peer, no downgrade of trust checks,
no changing an active channel's codec mid-packet. A page or host process upgrade
cannot currently preserve arbitrary in-memory simulation state; resuming the same
run across such a restart requires game-specific persisted snapshots. It is not
promised for the first release.

## Remote runtime manifests

`runtime` defaults to `local`; `hosted` and `streamed` may provide `launchUrl`.
A streamed view uses `renderer: "video"`. A missing remote destination is not a
local launch. The browser launcher follows a provided destination only on Play;
`GameHost101` rejects attempts to run remote manifests in its local update loop.

An optional `inputTarget` describes `{transport, endpoint, format}`. Transport is
`webrtc` (HTTP(S) signaling endpoint) or `websocket` (WS(S) input endpoint), and the
initial format is `101-json` carrying the normalized InputFrame schema. URLs reject
credentials and non-web schemes. Remote runtime providers own connection,
authentication, input acknowledgement, latency and stream recovery. No remote
provider, credentials or third-party service is added by these local changes.
`input-q1` is negotiated per role and configuration; it is not a universal streamed
input format and cannot carry poses. Future formats must declare a codec and
compatibility range instead of silently reusing that name.
