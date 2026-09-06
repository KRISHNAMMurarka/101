import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { INPUT_SOURCES } from "../packages/input/src/index.ts";

/**
 * The published JSON Schemas, rendered from the one place an input source is declared.
 *
 * `packages/input/src/index.ts` owns `INPUT_SOURCES`; the schemas exist for editors and for tooling
 * that is not TypeScript, and docs/architecture.md is explicit that the runtime parsers stay
 * authoritative. So this generates the schemas from the tuple rather than the other way round —
 * which also keeps the tuple's *order* in TypeScript, next to the encoder that turns it into a
 * 4-bit wire index.
 *
 * Hand-copying these did not work: `maxItems` said 14 against thirteen sources, in three places
 * across two files.
 *
 * Pure on purpose. `packages/input/src/input.test.ts` compares this output byte-for-byte with the
 * checked-in files, so the two cannot drift without a failing test naming the command to fix it.
 */
export const SOURCE_SCHEMAS = ["game-manifest", "input-manifest"];

function applySources(node) {
  if (Array.isArray(node)) {
    for (const item of node) applySources(item);
    return;
  }
  if (!node || typeof node !== "object") return;
  // The source enum is the one whose members are input sources; every other enum in these files
  // (handedness, emphasis, renderer) shares no member with the tuple.
  if (Array.isArray(node.enum) && node.enum.some((value) => INPUT_SOURCES.includes(value))) {
    node.enum = [...INPUT_SOURCES];
  }
  // A list of sources cannot be longer than the vocabulary it draws from.
  if (typeof node.maxItems === "number" && JSON.stringify(node.items ?? {}).includes("/source")) {
    node.maxItems = INPUT_SOURCES.length;
  }
  for (const value of Object.values(node)) applySources(value);
}

/** Every schema file and the exact bytes it should contain. */
export function renderSourceSchemas() {
  return SOURCE_SCHEMAS.map((name) => {
    const url = new URL(`../schemas/${name}.schema.json`, import.meta.url);
    const schema = JSON.parse(readFileSync(url, "utf8"));
    applySources(schema);
    return [url, `${JSON.stringify(schema, null, 2)}\n`];
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  for (const [url, contents] of renderSourceSchemas()) writeFileSync(url, contents);
  console.log(`Published ${INPUT_SOURCES.length} input sources to ${SOURCE_SCHEMAS.length} schemas.`);
}
