# First release acceptance

The first release is a local gaming system with a manifest-driven library, playable conventional controls, optional phone controllers, and optional camera controls. Installing extra hardware must never block a game whose declared fallback is available.

This is an acceptance definition, not a release approval. Publishing, deployment, signing, and distribution are outside the current authorization.

## Required evidence

- Every commit passes the four commands in AGENTS.md against a current production build. CI repeats that gate. Bundle budgets are 2 MiB gzip for all client JavaScript, 800 KiB per JavaScript file, and 32 KiB for CSS; increases require a written reason.
- Every game can start, accept its declared basic controls, end a run, and restart. Run completion announces the result and focuses Play again. No stale held input survives disconnect, role replacement, a hidden dock, or teardown.
- Camera permission, denial, retry, selection, unplug, missing remembered device, skip, restart, and navigation away all work. Setup measures light and framing and confirms a real gesture. Both supported camera games visibly distinguish two people and preserve their slots when one briefly leaves.
- Phone pairing/reconnect works on physical iOS and Android devices. Portrait and landscape controls remain reachable, with no play-area obstruction. The installed controller reopens offline after a completed update; an update does not remove assets still needed by an active older client.
- All routes work in both themes at 320px and 2560px. Touch targets and focus remain visible. Reduced motion is respected. A keyboard and an actual screen reader can complete the chooser and walkthrough.
- Record laptop and physical-phone inference distributions, not just a single frame. Confirm placement and gesture completion with CPU throttled fourfold. Record a production Lighthouse run, browser version, device, and throttling profile.
- Player copy contains no raw technical failures, model measurements, or fixed catalog totals. Diagnostic content stays in Studio. Color belongs inside the games, while product chrome stays monochrome.

A red gate, a missing input path, lost private role data, an offline boot failure, unreadable controls, or a required physical-device check with no evidence blocks release. Unit tests or viewport emulation cannot substitute for physical-device or assistive-technology evidence.

## Explicit scope boundaries

Hosted/streamed metadata, display/audio capability declarations, and the routing design are extension contracts. This release does not claim a working remote runtime, multiple rendered game views, remote output subscription, or migration of a live engine across host-process upgrades. The protocol document defines compatible reconnect and incompatible-peer rejection.

Hardware skeleton frames are supported through the adapter boundary. A player-facing suit connection requires a reviewed device profile (identity filter, decoder, semantic controls, and calibration); no arbitrary device is advertised as usable merely because a browser exposes an API.

Face capture is omitted because no model/game integration is included. Camera previews contain no audio track to caption. There is no screen-reader detection or automatic hiding of camera choices: the walkthrough offers verbal placement feedback and an accessible alternative. Physical accessibility feedback remains an acceptance requirement.

There is deliberately no print-specific stylesheet for the live play surface: canvas gameplay and held controls have no useful printed state. Documentation is ordinary Markdown and can be printed independently. This decision can be revisited for exportable scores or instructions when such a feature exists.

## Completion rule

Close a backlog item only with a source/test/browser receipt, or document that its reported premise was false. A design decision closes a design task; it does not close the later implementation. Record hardware-dependent checks as pending until run. Keep the remaining release blockers in QA results instead of silently declaring the project finished.
