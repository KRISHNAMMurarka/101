# Controller experience decisions

## Outcome

101 Link is a phone someone holds while looking at a game elsewhere. Its job is to connect quickly, then keep the assigned controls reachable and stable under both thumbs. The controller stays monochrome and accepts any game-defined layout; it does not carry game-specific placement rules.

## Evidence and decisions

| ID | Finding | Decision | Acceptance |
| --- | --- | --- | --- |
| CUX-01 | An unassigned controller showed a default D-pad and buttons that could not affect a game. On a short landscape screen they fell below the fold. | Show a short connection state until the host assigns a non-empty panel. | No inactive game control appears before assignment; the connection action and next step are visible at 844×390. |
| CUX-02 | A dense layout put the centred control in a separate row, reducing the height available to the thumb clusters and clipping lower controls at 740×320. | In short landscape, place left, centre, and right clusters in one row; compact bars share a row. | A seven-control stress layout has no vertical scroll at 740×320 and every shown control is fully visible. |
| CUX-03 | A player's handedness can change their safe thumb reach. | Retain a reversible handedness control and mirror only left/right controls; centre controls do not move. | Switching handedness swaps thumb clusters, retains the centre control, and leaves every control keyboard reachable. |
| CUX-04 | A pad or surface changes input geometry if it is stretched to leftover vertical space. | Keep pads square; size them from the deck and set a 48px coarse-pointer floor for each directional cell. | Portrait and landscape D-pads remain square and directional cells retain their touch target. |

## Responsive contract

| State | Portrait | Short landscape |
| --- | --- | --- |
| Waiting for a game | Room, connection action, and a plain next step; no pretend game controls. | The same path fits before the fold, leaving the device ready to pair. |
| Assigned role | Status stays above a bottom-anchored deck. Movement stays under one thumb; face actions under the other. | Setup stays one tap away. The handedness choice stays visible on wider phones; status is one line; the deck uses one left/centre/right row and keeps primary controls at the lower edges. |
| Dense role | Groups remain distinct: shoulder/index bars first, pad beneath the movement thumb, keys beneath the action thumb. | Bars share horizontal space, centre controls no longer consume a row, and the square pad is bounded by the available short viewport. |
| Keyboard | Every control remains native and focusable; held values release on blur. | The same focus order and release behavior applies. |

## Research log

Apple recommends a minimum 44×44pt hit region and an explicit press state for custom buttons. The controller keeps a more conservative 48px coarse-pointer directional cell floor. [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/buttons?changes=latest_minor)

Installed web apps need safe margins around notches and home indicators when using the full viewport. The controller already uses `viewport-fit=cover` and safe-area environment variables; the redesign keeps that padding intact at every breakpoint. [web.dev PWA app design](https://web.dev/learn/pwa/app-design?hl=en)

Thumb reach depends on device size, grip, and the person holding it, so the layout keeps primary game inputs at the lower edges, lets players mirror the deck, and treats physical-device review as required evidence rather than claiming a universal reach zone. [Otten, Karn, and Parsons on thumb reach envelopes](https://journals.sagepub.com/doi/abs/10.1177/0018720812470689?download=true)

## Verification and remaining evidence

Local browser checks used a production build and a live Controller Lab host. At 844×390, the unassigned controller showed only connection guidance. At 740×320, the dense seven-control layout fit within `scrollHeight === innerHeight`; the right-handed and left-handed arrangements both kept all controls visible. Activating the centre toggle set the host's normalized `lock` action to `true`. The browser accessibility tree reported native buttons, sliders, labels, and the handedness action.

This does not replace physical phone ergonomics, haptic feel, or screen-reader testing. Those remain in [PHYSICAL-ACCEPTANCE-RUNBOOK.md](PHYSICAL-ACCEPTANCE-RUNBOOK.md).
