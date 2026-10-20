# Device platform move status

Owner approval: 20 October 2026. BOUNDARY.md is the approved source inventory;
subsequent owner instructions authorize kit stand-ins, publication and post-move
work. The kit remains read-only.

## History and custody

- 101 baseline: `301b0d3f255eb90feb943c7886ec5c101886ca14`.
- Connect skeleton baseline: `b60a2e82f4062ec468c4a4361924ceaa6ab28efc`.
- Filtered history: `e2a25924566435a1fc1674be417fc1b4d481541a`.
- Single Connect import merge: `6a61fa4e257851ceac36a4e3cd5a508dab9e9b91`.
- Homebrew git-filter-repo 2.47.0 selected the explicit current and predecessor
  paths and mapped them directly to their final destination. No squash or source
  history rewrite occurred. All 1,202 imported current files matched their
  recorded SHA-256 before intentional separation changes.
- Verified full-ref bundles remain in 101 `outputs/migration/2026-10-20/recovery/`.
  Commit maps, file maps and recovery manifest are also in Connect
  `docs/migration/2026-10-20/`. The disposable extraction checkout was removed
  after its commit and maps were verified in the destination.

## Consumer cutover

26 platform package roots and four native agents now belong to Connect, together
with generic console routes, assets, supporting tests and tooling. 101 owns its
12 game packages, ten playable titles, Input Lab, launcher, browser controller and
console receiver. It links `@uynis-connect/connect` to
`file:../uynis-connect/sdk/connect`; the SDK builds its own compiled closure.

Game assignments, legacy game payload interpretation, presets, action mapping,
replay schema and game scaffolding remain in Games. Generic signal recognition,
acquisition and application channels live in Connect. Device route compatibility
pages redirect to the Connect console. `NEXT_PUBLIC_CONNECT_CONSOLE_URL` selects
its origin; the development default is http://localhost:3001.

Both products built independently before original source removal. The linked
application passed the actual keyboard/software-gamepad/remote browser journey,
synthetic inference through the public camera SDK into two real game simulations,
and console pointer journeys in Chromium and WebKit. The cross-origin Connect
pointer console also drove the 101 input surface through explicit consent.
These checks do not qualify physical devices or installed native targets.

Original tracked sources were removed by an explicit, hash-checked file list only
after these checks. Game wrappers and extracted game-only source remain. The
1,076 named original sources and two separately explained removals are recorded
in `receipts/2026-10-20-source-removal.json`.
Ignored historical native build caches were not transferred as source.
PROJECT-LOCATIONS.md now identifies the two separate homes.

## Verified local cutover

Connect cutover commit: `65c1aa59e1f5ee6cc7aa7c1857a69b11afb51134`.
Both products build independently. Connect passes 3,282 unit tests, 13 rendered
checks, root/agent typechecks, lint (zero errors, one warning), and the independent
offline SDK package consumer. Games passes 459 unit tests, 29 rendered checks,
typecheck, lint and its production dependency audit (zero advisory entries).
The browser journey passes ten keyboard/software-gamepad/remote checks; the
console receiver passes 16 checks in each of Chromium and WebKit. Cross-origin
pointer consent, effects, revocation and recovery also pass. Camera coverage uses
synthetic inference through the actual public SDK into real game simulations.

See `receipts/2026-10-20-cutover-gates.json` and
`receipts/2026-10-20-linked-journeys.json`. Both source cutover commits were pushed and remote main refs verified:
Connect `65c1aa59e1f5ee6cc7aa7c1857a69b11afb51134`,
Games `c58d20ffb284016ca96a8ae5d726ff332ad95dcc`.
See `receipts/2026-10-20-publication.json`. This publishes source only; it is
not a deployment or release acceptance.

Defects found during the cutover include inconsistent standalone game room IDs,
missing visible pointer-release confirmation, public low-level source/peer
exports, and consumer callbacks interrupting cleanup. Focused regressions and affected linked checks pass. The room correction
also exposed empty server-rendered game shells; the shell now remains visible
while acquisition waits for a real room ID. A final pointer QA race was corrected
by settling previous visual feedback before asserting that new unauthorized input
has no effect. Runtime input rejection was unchanged.

The combined historical acceptance ledger remains frozen. Its checker verifies
named moved files against original Git blobs and recorded SHA-256 values; unknown
missing files and changed ledger documents fail. This is historical custody, not
current product qualification. No support row is marked accepted.

The current GitHub workflow needs read access to the private Connect repository
through `CONNECT_READ_TOKEN`. That external integration is not configured or
claimed by local verification; missing access fails the workflow explicitly.
Native target jobs are no longer Games jobs. Real-device/target-OS qualification,
four external-account items and 15 release gates remain deferred.

## Follow-on ownership

The 57 platform-led and two Games-led acceptance IDs retain the ownership and
partial-evidence rules in BOUNDARY section 7. No ID is closed merely by moving its
source. The two Games IDs are N11 (console receiver) and G06 (conventional control,
results and restart journeys). The four newly approved platform additions follow
the move in the owner's order: scoped recorded/revocable permissions; terminal,
shell, files, processes and screen; device ownership through kit login; OTA.

The kit's actual inspected usage/audit/keys implementations and missing login/files
interfaces are recorded in Connect `docs/KIT-REQUESTS.md`. No kit edits, new
accounts, administrator capture, native qualification or release claims occurred.
