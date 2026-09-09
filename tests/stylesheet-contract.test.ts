import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import postcss from "postcss";

/**
 * Guards on the design system that a typecheck cannot see.
 *
 * A stylesheet has no compiler, so the failures it does have are silent: a self-referential custom
 * property does not error, it simply computes to nothing, and every rule downstream of it falls
 * back to an initial value. Light mode shipped broken that way — `--ink: var(--paper)` alongside
 * `--paper: var(--ink)` made both invalid at computed-value time, the body background computed to
 * transparent, and the primary button lost its fill. The same shape then reappeared within a day
 * when a bulk edit rewrote `--gutter`'s own definition into `var(--gutter)`, which silently zeroed
 * the padding on every page. Two occurrences of one invisible failure is what a test is for.
 */
const source = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

/** Comments are stripped but their newlines are kept, so reported line numbers still point at the
    real declaration — the prose in this file necessarily quotes the very patterns being banned. */
const css = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
const stylesheet = postcss.parse(css);

test("a selector list has one definition per cascade context", () => {
  // A shared base list and a more specific variant are legitimate. The same list in a different
  // media query is too. Repeating the entire list in the same context conceals stale overrides.
  const seen = new Map<string, number>();
  const duplicates: string[] = [];
  stylesheet.walkRules((rule) => {
    const contexts: string[] = [];
    for (let parent = rule.parent; parent && parent.type !== "root"; parent = parent.parent) {
      if (parent.type === "atrule") contexts.unshift(`@${parent.name} ${parent.params}`);
      else if (parent.type === "rule") contexts.unshift(parent.selector);
    }
    const selectors = rule.selectors.map((selector) => selector.replace(/\s+/g, " ").trim()).sort().join(", ");
    const key = [...contexts, selectors].join(" | ");
    if (seen.has(key)) duplicates.push(`${key}: lines ${seen.get(key)} and ${rule.source?.start?.line}`);
    else seen.set(key, rule.source?.start?.line ?? 0);
  });
  assert.deepEqual(duplicates, []);
});

test("conditional colour tokens always have an unconditional default", () => {
  const defaults = new Set<string>();
  stylesheet.walkRules((rule) => {
    if (rule.selector === ":root" && rule.parent?.type === "root") {
      rule.walkDecls(/^--/, (declaration) => { defaults.add(declaration.prop); });
    }
  });
  const missing: string[] = [];
  stylesheet.walkDecls(/^--/, (declaration) => {
    if (/(?:#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|color-mix)\()/i.test(declaration.value)
      && !defaults.has(declaration.prop)) missing.push(declaration.prop);
  });
  assert.deepEqual(missing, []);
});

function grey(value: string, ground = 0) {
  if (value.startsWith("#")) return parseInt(value.slice(1, 3), 16);
  const rgba = value.match(/^rgba?\(\s*([\d.]+),\s*[\d.]+,\s*[\d.]+(?:,\s*([\d.]+))?\s*\)$/);
  assert.ok(rgba, `expected a literal monochrome palette value: ${value}`);
  const alpha = Number(rgba[2] ?? 1);
  return Number(rgba[1]) * alpha + ground * (1 - alpha);
}

function contrast(a: number, b: number) {
  const luminance = (value: number) => {
    const channel = value / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  };
  const values = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (values[1] + .05) / (values[0] + .05);
}

test("text and control edges clear contrast on both theme surfaces", () => {
  const failures: string[] = [];
  stylesheet.walkRules((rule) => {
    if (!rule.selector.startsWith(":root")) return;
    const palette = new Map<string, string>();
    rule.walkDecls(/^--/, (declaration) => { palette.set(declaration.prop, declaration.value); });
    if (!palette.has("--ink")) return;
    for (const surface of ["--ink", "--panel", "--panel-2"]) {
      const background = grey(palette.get(surface)!);
      for (const token of ["--paper", "--muted", "--faint", "--line-control", "--line-strong"]) {
        const ratio = contrast(grey(palette.get(token)!, background), background);
        const minimum = token.startsWith("--line") ? 3 : 4.5;
        if (ratio < minimum) failures.push(`${rule.selector} ${token} on ${surface}: ${ratio.toFixed(2)}:1 < ${minimum}:1`);
      }
    }
  });
  assert.deepEqual(failures, []);
});

test("controller setup remains available in short landscape viewports", () => {
  const hidden: string[] = [];
  stylesheet.walkAtRules("media", (media) => {
    if (!media.params.includes("orientation: landscape")) return;
    media.walkRules((rule) => {
      if (!rule.selectors.some((selector) => /(?:dynamic-controller-heading|link-runtime|controller-speaker)/.test(selector.replace(/:not\([^)]*\)/g, "")))) return;
      rule.walkDecls("display", (declaration) => { if (declaration.value === "none") hidden.push(rule.selector); });
    });
  });
  assert.deepEqual(hidden, [], "fold controller chrome through data-phase, not viewport shape");
});

test("catalog columns can shrink below intrinsic title width", () => {
  stylesheet.walkRules((rule) => {
    if (rule.selector !== ".game-grid") return;
    rule.walkDecls("grid-template-columns", (declaration) => {
      assert.match(declaration.value, /minmax\(0,\s*1fr\)/);
    });
  });
});

test("game results retain contrast on their dark scrim in either theme", () => {
  assert.match(css, /\.game-over-panel\s*\{[^}]*color:\s*var\(--stage-paper\)/);
  assert.match(css, /\.game-over-panel p\s*\{[^}]*color:\s*var\(--stage-muted\)/);
  const palette = new Map<string, string>();
  stylesheet.walkRules((rule) => {
    if (rule.selector === ":root" && rule.parent?.type === "root") {
      rule.walkDecls(/^--stage-/, (declaration) => { palette.set(declaration.prop, declaration.value); });
    }
  });
  // Brightest possible scene behind the 87% dark scrim.
  const ground = 10 * .87 + 255 * .13;
  for (const name of ["--stage-paper", "--stage-muted"]) assert.ok(contrast(grey(palette.get(name)!), ground) >= 4.5);
});

test("focus and reduced motion apply to every native interactive element", () => {
  assert.doesNotMatch(css, /outline:\s*none/);
  assert.match(css, /textarea:focus-visible/);
  assert.match(css, /summary:focus-visible/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*animation:\s*none\s*!important;\s*transition:\s*none\s*!important/);
});

test("no custom property is defined in terms of itself", () => {
  const offenders: string[] = [];
  css.split("\n").forEach((line, index) => {
    const match = line.match(/^\s*(--[a-z0-9-]+)\s*:\s*var\(\s*(--[a-z0-9-]+)/i);
    if (match && match[1] === match[2]) offenders.push(`line ${index + 1}: ${line.trim()}`);
  });
  assert.deepEqual(offenders, [], `a token defined as itself is invalid at computed-value time and silently erases every rule that uses it:\n${offenders.join("\n")}`);
});

test("the light and dark palettes do not reference each other", () => {
  // The specific cycle that broke light mode: each palette must state its own literal values.
  const core = ["--ink", "--paper", "--panel", "--solid", "--on-solid"];
  const offenders: string[] = [];
  for (const token of core) {
    const pattern = new RegExp(`${token}\\s*:\\s*var\\(`, "g");
    for (const match of css.matchAll(pattern)) {
      const line = css.slice(0, match.index).split("\n").length;
      offenders.push(`line ${line}: ${token} is defined by reference, not literally`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

test("no type is set below the 11px floor", () => {
  // 11px matches the native app's `label` role. ~155 declarations sat at 6-8px, which is the single
  // biggest reason the product read as defaulted rather than designed.
  const offenders: string[] = [];
  for (const match of css.matchAll(/font(?:-size)?:\s*[^;{}]*?\b([0-9]|10)px\b/g)) {
    const line = css.slice(0, match.index).split("\n").length;
    offenders.push(`line ${line}: ${match[0].trim()}`);
  }
  assert.deepEqual(offenders, [], `below the 11px floor:\n${offenders.join("\n")}`);
});

test("one gutter, not six", () => {
  // The stylesheet held 21 gutter declarations across six different clamp values, which is why the
  // topbar and the content under it disagreed by 14.4px and one page showed four different rails.
  const literals = [...css.matchAll(/padding[^:;{}]*:\s*[^;{}]*clamp\(\s*2[0-9]px,\s*[45]vw/g)].map((match) => {
    const line = css.slice(0, match.index).split("\n").length;
    return `line ${line}: ${match[0].trim()}`;
  });
  assert.deepEqual(literals, [], `horizontal page padding must use var(--gutter):\n${literals.join("\n")}`);
});

test("every .controller-page padding respects the safe-area insets", () => {
  // `viewport-fit=cover` extends the page under the notch and the home indicator, so the padding is
  // the only thing keeping content clear of them. A later rule that re-declares the shorthand as a
  // flat number silently drops every inset — and because media queries add no specificity, whichever
  // rule is written last simply wins. That is how the narrow-screen `padding: 14px` undid it once.
  const offenders: string[] = [];
  for (const match of css.matchAll(/\.controller-page\s*(?:>[^{]*)?\{([^}]*)\}/g)) {
    const body = match[1];
    const padding = body.match(/(?:^|;)\s*padding\s*:([^;]*)/);
    if (!padding) continue;
    if (!/env\(\s*safe-area-inset/.test(padding[1])) {
      const line = css.slice(0, match.index).split("\n").length;
      offenders.push(`line ${line}: padding:${padding[1].trim()}`);
    }
  }
  assert.deepEqual(offenders, [], `a flat padding on .controller-page drops the safe-area insets:\n${offenders.join("\n")}`);
});
