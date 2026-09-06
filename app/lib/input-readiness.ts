import type { InputSource } from "@101/input";

import { CATALOG_INPUT_LABELS } from "./catalog.ts";

/**
 * How a game's resolved input needs are put into words.
 *
 * Resolution itself lives in `GameHost101`, which every game reaches through `useGameHost`. This
 * file used to own a second copy — `resolveGameInput`, written before the games ran on the SDK — and
 * it went dead the moment they did. Leaving it would have recreated exactly the problem this session
 * removed everywhere else: exported code with no caller, which reads as supported and drifts from
 * the path that actually runs.
 */

/**
 * What to print in a status bar's input slot.
 *
 * Three states, deliberately distinct. Before the effect has run — server render, first paint —
 * nothing has been measured, and printing "NO INPUT" there would replace one false claim with
 * another. Measured-and-empty is a real state worth naming. Anything else lists what is actually
 * connected.
 */
export function describeSources(readiness?: { available: InputSource[] }): string {
  if (!readiness) return "Checking…";
  if (readiness.available.length === 0) return "No controller yet";
  return readiness.available.map((source) => CATALOG_INPUT_LABELS[source] ?? source).join(" · ");
}
