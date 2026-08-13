import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const manifest = fileURLToPath(new URL("../apps/desktop-hub/src-tauri/Cargo.toml", import.meta.url));
const metadata = JSON.parse(execFileSync("cargo", [
  "metadata",
  "--format-version", "1",
  "--locked",
  "--manifest-path", manifest,
], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));

const packages = metadata.packages
  .filter((pkg) => pkg.name !== "oneohone-hub")
  .map((pkg) => ({
    name: pkg.name,
    version: pkg.version,
    license: pkg.license ?? "UNKNOWN",
    source: pkg.source ?? "workspace",
  }))
  .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));

await writeFile(new URL("../THIRD_PARTY_RUST_LICENSES.json", import.meta.url), `${JSON.stringify({
  schemaVersion: 1,
  generatedFrom: "apps/desktop-hub/src-tauri/Cargo.lock",
  packages,
}, null, 2)}\n`);

console.log(`Recorded ${packages.length} locked Rust dependencies.`);
