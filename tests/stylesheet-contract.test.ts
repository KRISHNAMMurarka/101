import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
