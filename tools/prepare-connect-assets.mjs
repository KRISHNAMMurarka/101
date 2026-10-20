import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "..");
const manifestPath = fileURLToPath(import.meta.resolve("@uynis-connect/connect/assets/manifest.json"));
const source = dirname(manifestPath);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.schemaVersion !== "uynis.connect.camera-assets.v1") throw new Error("Unsupported Connect asset manifest");
const destination = resolve(root, "public/connect-assets");
for (const entry of manifest.files) {
  if (typeof entry.path !== "string" || !entry.path || entry.path.includes("\\") || entry.path.split("/").includes("..")) {
    throw new Error("Invalid Connect asset path");
  }
  const from = resolve(source, entry.path);
  const to = resolve(destination, entry.path);
  if (!from.startsWith(source + sep) || !to.startsWith(destination + sep)) throw new Error("Connect asset escaped its package");
  const bytes = readFileSync(from);
  if (bytes.length !== entry.bytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
    throw new Error(`Connect asset failed verification: ${entry.path}`);
  }
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}
writeFileSync(resolve(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Prepared ${manifest.files.length} verified package assets in ${relative(root, destination)}.`);
