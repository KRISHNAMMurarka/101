# Lighthouse receipt — launcher, 12 September 2026

Produced locally against a production build served on localhost. Nothing was deployed, hosted or
published. This is the first recorded audit; the repository made no score claim before it existed.

## Environment

| Field | Value |
| --- | --- |
| Commit | `40eef752ac30a0f00ed0610509e6067e98584d91` |
| Route audited | `http://127.0.0.1:3000/` (launcher) |
| Build | `npm run build` then `npm run start` (vinext production server, port 3000) |
| Lighthouse | 13.4.1 |
| Chrome / host UA | Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36 |
| Form factor | mobile |
| Screen emulation | 412x823 @ 1.75x, mobile=True |
| Throttling method | simulate |
| Throttling | 150 ms RTT, 1638.4 kbps, 4x CPU |
| Runs | Single run per configuration |

## Scores

"Before" is the first audit of this build, run before anything was changed. "After" is the same
audit once the head-placement defect below was fixed. Nothing was tuned to chase a number.

| Category | Before | After |
| --- | --- | --- |
| Performance | 66 | 67 |
| Accessibility | 100 | 100 |
| Best Practices | 96 | 96 |
| SEO | 90 | 100 |

## Metrics (after)

| Metric | Value |
| --- | --- |
| First Contentful Paint | 4.7 s |
| Largest Contentful Paint | 5.8 s |
| Total Blocking Time | 10 ms |
| Cumulative Layout Shift | 0.001 |
| Speed Index | 4.7 s |

## What the first audit found

### The head was empty of everything that matters — fixed

`title`, `description`, `keywords`, `application-name`, the Open Graph and Twitter sets, the icon
and the web app manifest were all rendered into a `<div hidden>` in the body, in the served HTML and
still there after hydration. This framework's metadata shim renders its tags inside the streamed
part of the tree and relies on React hoisting them into `<head>`; from the root layout that does not
happen.

The manifest is the one that costs something. A browser only honours `<link rel="manifest">` in the
head, so the controller could not be installed — which is the first step of the offline-update case
in the acceptance runbook. Nothing that unfurls a link could read a description or find an image
either. `meta-description` was scored 0 while the string was sitting in the page.

Fixed by writing those tags in the layout's own JSX, which lands in the static shell. Page-level
metadata exports were never affected and still work. SEO went 90 to 100.

Two things found while fixing it, both now asserted in `tests/rendered-html.test.mjs`:

- A `<title>` in the root layout won at runtime over the page's own, so the controller tab read
  "101 — Anything can be a controller" instead of "101 Link". Titles are per route; the root layout
  sets none, and the two routes that had none of their own now have one.
- The controller declares its own manifest because it installs as its own app. Both links reach the
  head on that route and the browser takes the first, so document order is load-bearing — which is
  why the order is asserted rather than assumed.

The old guard for this was `assert.match(layout, /openGraph/)` against the source of `layout.tsx`.
It passed the entire time, because it only ever proved the key had been typed.

### Performance is 67 and that is the honest number

First Contentful Paint 4.7 s and Largest Contentful Paint 5.8 s under Lighthouse's simulated mobile
profile (4x CPU slowdown, 1.6 Mbps). Total Blocking Time is 10 ms and Cumulative Layout Shift is
0.001, so the page is not janky once it arrives — it simply arrives late. The two contributors
Lighthouse names are roughly 230 KiB of unused JavaScript and 89 KiB of unused CSS on first load.

Not tuned before recording, deliberately. This is the baseline any later work is measured against.

### Console errors come from the framework, not this repository

Two per load: `[vinext] RSC prefetch setup error: TypeError: ee is not a function`, raised inside
the framework's own `link` chunk. Recorded rather than chased — there is no call site in this
repository to change.

*Resolved 25 September — the cause was the bundler version this repository pins, not the framework;
see the follow-up below.*

## Not covered by this receipt

Lighthouse 13 removed the PWA category and its installability audits, so this run proves nothing
about whether the controller installs. The manifest now satisfies the one requirement that can be
checked statically — it is in the head, and it is the controller's own — but an actual install on a
physical device remains a case in
[PHYSICAL-ACCEPTANCE-RUNBOOK.md](PHYSICAL-ACCEPTANCE-RUNBOOK.md).

A single run on one machine is a baseline, not a distribution. Scores move between runs.

## Follow-up — 25 September 2026

Same route, same Lighthouse 13.4.1 and the same simulated mobile profile (412x823 @ 1.75x, 150 ms
RTT, 1638.4 kbps, 4x CPU). Chrome was HeadlessChrome/154.0.0.0. The tree was `39fba9b` plus the two
changes below. "Before" repeats the baseline on that tree, and "after" is three consecutive runs, all
identical.

| | Before | After (×3) |
| --- | --- | --- |
| Performance | 66 | 90 |
| Accessibility | 100 | 100 |
| Best Practices | 96 | 100 |
| SEO | 100 | 100 |
| First Contentful Paint | 4.8 s | 2.7 s |
| Largest Contentful Paint | 6.0 s | 3.0 s |
| Total Blocking Time | 0 ms | 0 ms |
| Script transferred | 589,057 B | 182,943 B |
| CSS transferred | 145,804 B | 23,556 B |

**Why it arrived late: nothing was compressed.** The HTML was compressed, but every hashed script
and stylesheet went out raw. `vinext start` compresses a hashed asset only when the build has left a
`.br`/`.gz`/`.zst` file beside it. It never compresses one on the fly, and vinext leaves that
precompression off by default because an edge host normally does the job. Players run this local
server, so `vite.config.ts` now sets `vinext({ precompress: true })`. The "unused" JavaScript and CSS
named above were mostly raw bytes: once the assets were compressed, the estimates fell from 230 KiB
and 93 KiB to 29 KiB and 15 KiB. A rendered test fails if a hashed script or stylesheet ships without
its compressed siblings.

**Why the console errored: a bundler bug.** Rolldown 1.0.1, pinned by Vite 8.0.13, merged the
framework's navigation module into the app entry chunk under minified export names. It left the link
chunk's dynamic `import("./navigation.js")` pointing at that chunk bare, so every destructured
function was `undefined` and no link was ever prefetched. Rolldown 1.0.2 fixed exactly this ("publish
absorbed dynamic-entry namespace cross-chunk", #9448). Vite is now 8.0.16 (Rolldown 1.0.3). The
import now extracts the namespace, the console is empty, and visible links prefetch their routes. A
rendered test fails if any bare dynamic import targets a chunk that was not built for that module.

What remains: the 23.6 KB stylesheet still blocks rendering (an estimated 450 ms), and the largest
paint is the hero heading's text.
