import { readFile, writeFile } from "node:fs/promises";

const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
const entries = Object.entries(lock.packages ?? {})
  .filter(([path, pkg]) => path.includes("node_modules/") && pkg.version)
  .map(([path, pkg]) => ({
    name: pkg.name ?? path.split("node_modules/").at(-1),
    version: pkg.version,
    license: pkg.license ?? "UNKNOWN",
  }))
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const inventory = {
  schemaVersion: 1,
  generatedFrom: "package-lock.json",
  packages: entries,
};

await writeFile(
  new URL("../THIRD_PARTY_LICENSES.json", import.meta.url),
  `${JSON.stringify(inventory, null, 2)}\n`,
);

console.log(`Recorded ${entries.length} locked dependencies.`);
