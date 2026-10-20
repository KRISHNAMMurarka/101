# Games follow-through after the move

All ten games completed one real-time journey in Chromium and one in WebKit: **20/20 passed**. Each checked initial and fresh-run controls, a natural result, result naming, score description, restart-button focus, Space restart and Back navigation. No game state, time or rendering override was used. No runtime defect was observed; only the QA harness changed.

The run finished at `2026-10-20T13:01:07.125Z`. All 469 source and 405 build pins remained unchanged. Owned browser contexts and the ephemeral server closed. [Journeys](journeys.json) preserves the complete report, while [completion](completion.json) records its original source location, hashes and cleanup.

G06 remains open. The [coverage matrix](G06-coverage.json) and [CSV](G06-coverage.csv) distinguish 82 observed combinations, 406 offered but unobserved combinations and 24 combinations not offered by current keyboard/role declarations. This is an evidence inventory, not 406 demonstrated defects. It covers keyboard and on-page local controls; physical controllers, comprehensive neutral release and heard screen-reader announcements remain separate. Echo Maze movement was observed during its initial natural-end route only. [Prior Spellcaster evidence](spellcaster-prior-evidence.json) retains its original scope and is not relabelled as a fresh SDK run.

N11 also remains open. Its [reuse check](N11-reuse.json) matches all 20 source and three bundle pins for the existing 32 browser checks. These cover actual local browser RTC, consent, scoped output and release. The expiry test advances a software clock and the visibility test invokes a synthetic handler. Windows/UWP, installed WebView2, Xbox, physical controller/target and LAN qualification remain deferred.

This receipt refers to the unchanged cutover game build identified in the report. Later additive SDK control-service work does not retroactively change that artifact or claim new game journey coverage.

The later additive platform dependency at `3a8b43f9fc846a9a5590cb8032f4d31c5d6abd46` also passes a fresh Games build, typecheck, lint, 459 unit tests, 29 rendered checks and historical-record audit. [Current gates](current-gates.json) records those results separately from the earlier journey artifact. CI pins the matching kit inputs; private repository read access remains an external setup requirement.
