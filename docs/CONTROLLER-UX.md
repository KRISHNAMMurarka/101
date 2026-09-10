# Controller experience decisions

## Outcome

101 Link is a phone someone holds while looking at a game elsewhere. Its job is to connect quickly, then keep the assigned controls reachable and stable under both thumbs. The controller stays monochrome and accepts any game-defined layout; it does not carry game-specific placement rules.

## Evidence and decisions

| ID | Finding | Decision | Acceptance |
| --- | --- | --- | --- |
| CUX-01 | An unassigned controller showed a default D-pad and buttons that could not affect a game. On a short landscape screen they fell below the fold. | Show a short connection state until the host assigns a non-empty panel. | No inactive game control appears before assignment; the connection action and next step are visible at 844×390. |
| CUX-02 | A dense layout put the centred control in a separate row, reducing the height available to the thumb clusters and clipping lower controls at 740×320. | In short landscape, place left, centre, and right clusters in one row; compact bars share a row. | A seven-control stress layout has no vertical scroll and no clipped control at 480×320, 568×320, 667×375, 740×320, 844×390 and 932×430. |
| CUX-03 | A player's handedness can change their safe thumb reach. | Retain a reversible handedness control and mirror only left/right controls; centre controls do not move. | Switching handedness swaps thumb clusters, retains the centre control, and leaves every control keyboard reachable. |
| CUX-04 | A pad or surface changes input geometry if it is stretched to leftover vertical space. | Keep pads square; size them from the deck and set a 48px coarse-pointer floor for each directional cell. | Portrait and landscape D-pads remain square and directional cells retain their touch target. |
| CUX-05 | The portrait stress layout repeated labels inside the controls and left width unused beside the action thumb. | Show a secondary label only when it adds information; let two portrait face buttons fill their available thumb cluster on phones 360px and wider. | The dense layout has no repeated `MOVE` or `PRESSURE` label, and fits at 390×844 and 320×740 without overflow. |

## Responsive contract

| State | Portrait | Short landscape |
| --- | --- | --- |
| Waiting for a game | Room, connection action, and a plain next step; no pretend game controls. | The same path fits before the fold, leaving the device ready to pair. |
| Assigned role | Status stays above a bottom-anchored deck. Movement stays under one thumb; face actions under the other. | Setup stays one tap away. The handedness choice stays visible on wider phones; status is one line; the deck uses one left/centre/right row and keeps primary controls at the lower edges. |
| Dense role | Groups remain distinct: shoulder/index bars first, pad beneath the movement thumb, keys beneath the action thumb. Secondary labels never repeat the main label; two face buttons fill the portrait action cluster on phones 360px and wider. | Bars share horizontal space, centre controls no longer consume a row, and the square pad is bounded by the available short viewport. |
| Keyboard | Every control remains native and focusable; held values release on blur. | The same focus order and release behavior applies. |

## Research log

Apple recommends a minimum 44×44pt hit region and an explicit press state for custom buttons. The controller keeps a more conservative 48px coarse-pointer directional cell floor. [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/buttons?changes=latest_minor)

Installed web apps need safe margins around notches and home indicators when using the full viewport. The controller already uses `viewport-fit=cover` and safe-area environment variables; the redesign keeps that padding intact at every breakpoint. [web.dev PWA app design](https://web.dev/learn/pwa/app-design?hl=en)

Thumb reach depends on device size, grip, and the person holding it, so the layout keeps primary game inputs at the lower edges, lets players mirror the deck, and treats physical-device review as required evidence rather than claiming a universal reach zone. [Otten, Karn, and Parsons on thumb reach envelopes](https://journals.sagepub.com/doi/abs/10.1177/0018720812470689?download=true)

## Verification and remaining evidence

Local browser checks used a production build and a live Controller Lab host. At 844×390, the unassigned controller showed only connection guidance. At 740×320, the dense seven-control layout fit within `scrollHeight === innerHeight`; the right-handed and left-handed arrangements both kept all controls visible. At 390×844, the dense layout used its portrait action-thumb space without duplicate surface or pressure labels. At 320×740, `scrollHeight` and `scrollWidth` both matched the viewport. Activating the centre toggle set the host's normalized `lock` action to `true`. The browser accessibility tree reported native buttons, sliders, labels, and the handedness action.

This does not replace physical phone ergonomics, haptic feel, or screen-reader testing. Those remain in [PHYSICAL-ACCEPTANCE-RUNBOOK.md](PHYSICAL-ACCEPTANCE-RUNBOOK.md).

## Second pass — what a single-width acceptance missed

CUX-02 was accepted at 740×320 and only at 740×320. Three faults were sitting just outside that one
measurement.

| ID | Finding | Decision | Acceptance |
| --- | --- | --- | --- |
| CUX-06 | The handedness control was lifted out of flow only at 640px and wider. Below that it kept a 44px row the deck needed: at 568×320 the left cluster wants 48px of bars plus a 176px pad against 198px of space, so four controls were clipped and the page scrolled 48px. An iPhone SE on its side is 568×320. | Lift the control into the top bar across the whole short-landscape band, anchored to the right edge so it clears the wordmark at any width. | No clipped control and no page scroll at 480×320 and 568×320 with the seven-control layout. |
| CUX-07 | `--key-max` was pinned to a flat 56px for every landscape layout under 560px tall, so an 844px-wide screen gave a smaller action button than a 375px portrait one — more room, smaller target. | Let the cap grow with the deck: `clamp(56px, 12cqw, 92px)`. | Face buttons measure 56px at 480×320, 67px at 568×320, 87px at 740×320 and 92px at 844×390, with nothing clipped at any of them. |
| CUX-08 | A 56px face button holds about 44px of usable width. "Tap 3 together" put an eight-character word in it, and `overflow-wrap: anywhere` broke it mid-word into "togeth / er". | A phrase wraps cleanly only when its longest word fits the box: the chord hint reads "Tap 3 at once". Two analog bars share a row from 110px rather than 150px, so the right cluster is 84px tall instead of 174px. | No interaction hint breaks inside a word at 480×320 or wider. |

### Why one width was not enough

The failure was not the layout rule, which was right. It was the acceptance criterion naming a
single viewport. 740×320 happened to sit above the 640px breakpoint that lifts the handedness
control, so the deck had 44px the narrower phones did not, and the criterion could pass while two
common device sizes were broken. Acceptance criteria in this table now name the range they were
measured across, not one convenient point in it.

### Second-pass measurements

Emulated viewports against a live Controller Lab host running the seven-control "Full Gamepad"
layout. No control clipped and every interactive target at least 44px at 480×320, 568×320, 667×375,
740×320, 844×390 and 932×430; no page scroll on either axis at 320×740 or 390×844.

Emulated viewports are not a phone. Grip, thumb reach, haptic feel and screen-reader behaviour
remain physical evidence and stay in [PHYSICAL-ACCEPTANCE-RUNBOOK.md](PHYSICAL-ACCEPTANCE-RUNBOOK.md).
