import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

/**
 * Everything whose contents can change what the build produces. Lockfiles are included because a
 * dependency bump changes the output without touching a line of this repository's own source.
 */
const SOURCES = ["app", "games", "packages", "public", "worker", "schemas"];
const FILES = ["package.json", "package-lock.json", "next.config.ts", "vite.config.ts", "tsconfig.json"];

/** Build outputs and caches are derived, not inputs — folding them in would be circular. */
const SKIP = new Set(["node_modules", "dist", ".vinext", ".wrangler", ".git", "build", "release", "ios", "android"]);

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

/**
 * A stable identity for the source tree.
 *
 * vinext mints a random UUID per build for both the build id and the RSC compatibility id:
 *
 *     function createRscCompatibilityId(nextConfig) {
 *       if (nextConfig.deploymentId) return nextConfig.deploymentId;
 *       return randomUUID();
 *     }
 *
 * That UUID is baked into a chunk, so its hash changes on every build, and 22 further chunks change
 * with it because they import it — which is why two builds of identical source produced different
 * filenames. Pinning both ids to a hash of the source makes the output reproducible, and keeps the
 * property those ids exist for: they must change when the deployed app changes, which a source hash
 * does and a fresh UUID does only by accident.
 */
export async function sourceId(root = process.cwd()) {
  const hash = createHash("sha256");
  const paths = [];
  for (const dir of SOURCES) {
    for await (const path of walk(join(root, dir))) paths.push(path);
  }
  for (const file of FILES) paths.push(join(root, file));

  // Directory order is not guaranteed across machines; the id must describe the source, not the
  // filesystem that happened to hold it.
  paths.sort();
  for (const path of paths) {
    const contents = await readFile(path).catch(() => undefined);
    if (!contents) continue;
    hash.update(relative(root, path).split("\\").join("/"));
    hash.update(contents);
  }
  return hash.digest("hex").slice(0, 32);
}
