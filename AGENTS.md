# 101 engineering conventions

Work locally on this repository. Do not publish, deploy, create preview URLs, or add
third-party services. The only permitted Git remote is github.com/KRISHNAMMurarka/101.

Read this file first. For non-trivial work read
`/Users/km/Desktop/AI-Agent-Prompt-Suite/CORE_RULES.md`, then its relevant module;
continue with this file if that shared policy is unavailable.

## Product contract

- Player surfaces: `app/` except `app/studio/**` and developer labs. Plain instructions,
  no model names, confidence/software percentages, raw browser errors or architecture copy.
- Developer surfaces: `app/studio/**` and `app/*-lab`; measurements and diagnostics belong here.
- Product chrome is monochrome. Game canvases may use colour.
- Derive options, counts, input support and launch behavior from manifests and capabilities.
  Never add a per-game id special case to shared platform code.
- Camera lifecycle belongs in `use-camera-input.ts` and camera adapters, not each game.
- Never detect assistive technology or hide a control on that basis. Offer equivalent
  keyboard controls, readable status, a skip, and recovery from every permission failure.

## Every commit gate

Run against the exact candidate tree, never commit a red gate:

```sh
npx tsc --noEmit
npm run lint
npm run test:unit
node --test tests/rendered-html.test.mjs
```

Rendered tests consume `dist/server/index.js`; rebuild with `npm run build` after
source changes before running them. An old successful build does not verify new code.
Local builds do not publish anything.

For a bug fix, run the smallest regression against the old implementation and observe
it fail, then fix and rerun. Keep fixtures faithful to actual producer output.

The Node unit runner strips types but cannot import `.tsx`. Put testable logic in
plain `.ts` modules; use the local browser or built HTML for UI behavior.
`test:unit` discovers `.test.ts` under app/apps/games/packages/tests through
`tools/unit-test-files.mjs`; no manual script registration is needed. Keep that
bounded discovery guard when adding a source root. Do not descend into native build trees.

## CSS and lifecycle traps

Media queries add no specificity. Search every occurrence of a selector before editing;
another rule later in globals.css can override it. Contextual media/theme overrides are
legitimate; duplicate selector lists within the same scope are not.
Use ResizeObserver to measure canvases, cancel animation/timer work on unmount, and
release held input on disconnect. Always retain visible focus and reduced-motion behavior.
