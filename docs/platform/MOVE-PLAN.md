# Device platform move

Approved specification: [BOUNDARY.md](BOUNDARY.md), with the owner's subsequent
authorization to install the extraction tool, use temporary kit stand-ins, push
both repositories after verified cutover, and implement the four additions after
the move. The kit remains read-only. Temporary stand-ins must use its exact
interfaces and record missing integration requirements in Connect's KIT-REQUESTS.

## Execution and evidence

One integration owner controls history import, root manifests, lockfiles, deletion
and publication. Independent audits prepare the historical path map and the
game/device coupling changes. Evidence and recovery live under
`outputs/migration/2026-10-20/` in 101.

- [x] Preserve and verify complete Git bundles of both repository baselines,
  including local source evidence refs; preserve the approved boundary document.
- [x] Install git-filter-repo through Homebrew.
- [x] Freeze an explicit path map, including historical names, mixed files,
  supporting tests, tools and legal sources. Exclude non-permissive source.
- [x] Filter a disposable clone directly into final destination paths. Preserve
  commit/ref maps and original bundle hashes.
- [x] Import once without squashing into the existing Connect skeleton.
- [x] Verify every imported source blob against its recorded source hash.
- [x] Extract game aliases, input manifests, assignments and replay metadata into
  101's mapping layer. Generic adapters and sessions cannot import game modules.
- [x] Provide public device acquisition/subscription/output/lifecycle SDK
  composition. Do not hide direct adapter/transport access behind re-exports.
- [x] Build Connect and link 101 to `../uynis-connect/sdk/connect`; preserve the
  current playable application until the linked path is proved.
- [x] Verify keyboard, gamepad, camera and remote-control journeys including
  denial, revoke, disconnect, neutral release and fresh recovery. Browser/software
  evidence does not qualify physical targets.
- [x] Run both build closures and the applicable exact-candidate gates. Native
  reliability remains an open release gate under the owner's exception.
- [x] Only after custody and linked behavior pass, delete explicitly named moved
  paths from 101. Record paired cutover commits and recovery instructions.
- [x] Push Connect and 101 to their existing authorized GitHub destinations;
  update PROJECT-LOCATIONS after the actual cutover.
- [x] Report what moved, verified checks and regressions before further work.

## Post-move sequence

Carry forward the 57 platform-led and two Games-led IDs without erasing partial
evidence or closing cross-product acceptance slices prematurely. Build the
approved additions in this order: device/capability permissions and recorded,
revocable actions; terminal/shell/files/processes/screen; device ownership through
kit login; over-the-air updates.

Real-device/target-OS qualification, external accounts and release acceptance stay
deferred. No administrator capture, unrelated process termination, stash, blanket
staging or force-cleaning. No kit edits.

## Review focus

1. A physical input must not silently become a different action after extraction.
2. Revocation/disconnection must release held game controls across the SDK link.
3. Local imports must not conceal a dependency on source left behind in 101.
4. Filtering must retain predecessor paths and unique evidence, not merely HEAD.
5. Temporary connector stand-ins must not claim production identity or silently
   authorize on missing kit availability.
