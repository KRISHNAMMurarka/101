import { readdirSync } from "node:fs";
import { resolve } from "node:path";

export const UNIT_TEST_ROOTS = ["app", "apps", "games", "packages", "tests"];
const SKIP = new Set(["node_modules", "dist", "build", "ios", "android"]);

export function discoverUnitTests(root = resolve(import.meta.dirname, "..")) {
  const files = [];
  function walk(dir) {
    for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
      if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(path);
    }
  }
  for (const dir of UNIT_TEST_ROOTS) walk(dir);
  return files.sort();
}
