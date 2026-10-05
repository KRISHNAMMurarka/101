#!/usr/bin/env node
// Local packaging only. Each run owns one new directory; prior artifacts survive.
// Default mode is diagnostic and reports build skips with exit zero. In --release
// mode every selected target is required and must have a production profile.
// Successful packaging does not establish signing, installation or release acceptance.
//
//   node tools/package-release.mjs                    # diagnostic, all targets
//   node tools/package-release.mjs --release web hub  # required production targets

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as zlib from "node:zlib";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB_METADATA = [
  "LICENSE", "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_LICENSES.json", "THIRD_PARTY_RUST_LICENSES.json",
  "third_party/APACHE-2.0.txt", "docs/vision.md",
];
const WEB_GENERATED_FILES = new Set([
  "client/.assetsignore", "client/.vite/manifest.json", "client/_headers", "client/icons/101-link.svg",
  "client/link.webmanifest", "client/manifest.webmanifest", "client/og.png", "client/sw.js",
  "client/vinext-client-entry-manifest.json", "client/models/hand_landmarker.task", "client/models/pose_landmarker_lite.task",
  "client/mediapipe/wasm/vision_wasm_internal.js", "client/mediapipe/wasm/vision_wasm_internal.wasm",
  "client/mediapipe/wasm/vision_wasm_nosimd_internal.js", "client/mediapipe/wasm/vision_wasm_nosimd_internal.wasm",
  "server/.vite/manifest.json", "server/BUILD_ID", "server/index.js", "server/wrangler.json",
  "server/__vite_rsc_assets_manifest.js", "server/vinext-client-assets.js", "server/vinext-externals.json", "server/vinext-server.json",
  "server/ssr/index.js", "server/ssr/__vite_rsc_assets_manifest.js", "server/ssr/vinext-client-assets.js", "server/ssr/vinext-server.json",
]);
const WEB_GENERATED_PATTERNS = [
  /^client\/_next\/static\/.+\.(?:js|css|woff2|html)(?:\.(?:br|gz|zst))?$/,
  /^server\/(?:ssr\/)?_next\/static\/.+\.(?:js|css|woff2)$/,
];

const TARGETS = [
  {
    name: "web",
    profile: "production",
    description: "Standalone browser build of the launcher, all ten games and the Labs",
    async build() {
      await auditJavaScriptLicenseInventory();
      await npm("build");
      return collect("dist", "web", WEB_METADATA);
    },
  },
  {
    name: "hub",
    profile: "production",
    description: "Native 101 Hub desktop bundle for this platform",
    async build() {
      await npm("desktop:app");
      // Tauri writes per-platform bundles; take whichever this OS produced.
      return collect("apps/desktop-hub/src-tauri/target/release/bundle", "desktop-hub");
    },
  },
  {
    name: "link",
    profile: "intermediate",
    description: "JavaScript bundles for native 101 Link (iOS and Android)",
    async build() {
      await npm("native:export");
      return collect("apps/controller-native/dist", "link-native");
    },
  },
  {
    name: "wear",
    profile: "debug",
    description: "Wear OS watch companion APK",
    async build() {
      await npm("watch:wear:build");
      return collect("apps/watch-wear/app/build/outputs/apk/debug/app-debug.apk", "watch-wear/101-link-wear-debug.apk");
    },
  },
];

const args = process.argv.slice(2);
const requested = args.filter((arg) => arg !== "--release");
const invalid = args.filter((arg) => arg !== "--release" && !TARGETS.some((target) => target.name === arg));
if (invalid.length || new Set(args).size !== args.length) {
  console.error(`Unknown or duplicate argument. Use [--release] [${TARGETS.map((target) => target.name).join(" ")}].`);
  process.exit(1);
}
const mode = args.includes("--release") ? "release" : "diagnostic";
const selected = requested.length ? requested.map((name) => TARGETS.find((target) => target.name === name)) : TARGETS;

await mkdir(join(ROOT, "release"), { recursive: true });
const OUT = await mkdtemp(join(ROOT, "release", "package-"));

const produced = [];
const skipped = [];

for (const target of selected) {
  process.stdout.write(`\n▸ ${target.name} — ${target.description}\n`);
  try {
    if (mode === "release" && target.profile !== "production") {
      throw new Error(`${target.profile} target is unavailable for release packaging; an installable production target is required`);
    }
    const artifact = await target.build();
    produced.push({ target: target.name, profile: target.profile, ...artifact });
    console.log(`  ok  ${artifact.artifact}`);
  } catch (error) {
    const reason = firstMeaningfulLine(error);
    skipped.push({ target: target.name, profile: target.profile, reason });
    console.log(`  skipped  ${reason}`);
  }
}

const manifest = {
  schemaVersion: 2,
  version: JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")).version,
  source: await sourceProvenance(),
  environment: { node: process.versions.node, npm: (await run("npm", ["--version"])).stdout.trim(), platform: process.platform, arch: process.arch },
  builderSha256: await fileSha256(fileURLToPath(import.meta.url)),
  mode,
  requiredTargets: mode === "release" ? selected.map((target) => target.name) : [],
  status: mode === "diagnostic" ? "diagnostic" : skipped.length ? "incomplete" : "complete",
  packagingComplete: mode === "release" && skipped.length === 0,
  releaseAccepted: false,
  produced,
  skipped,
};
await writeFile(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`\n${produced.length} produced, ${skipped.length} skipped. See ${relative(ROOT, join(OUT, "manifest.json"))}`);
if (skipped.length) {
  console.log("\nSkipped targets:");
  for (const entry of skipped) console.log(`  ${entry.target}: ${entry.reason}`);
}
console.log(mode === "release"
  ? `\nRequired production packaging ${manifest.packagingComplete ? "passed" : "failed"}. Release acceptance remains separate.`
  : "\nDiagnostic report only; no release acceptance.");
if (mode === "release" && skipped.length) process.exitCode = 1;

// iOS and watchOS deliberately have no target here. Both need a provisioning profile tied to a
// registered Apple Developer account, so a repository cannot produce an installable build for
// someone else. See docs/native-link.md and docs/watches.md for the signing steps.
console.log("\nApple installables are not built here: they require your own signing identity.");

async function npm(script) {
  await run("npm", ["run", script], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
}

async function collect(source, destination, metadata = []) {
  const from = join(ROOT, source);
  const to = join(OUT, destination);
  try {
    await inspectArtifact(from);
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to, { recursive: true, errorOnExist: true, force: false });
    for (const path of metadata) {
      if (!(await lstat(join(ROOT, path))).isFile()) throw new Error(`Required metadata is not a regular file: ${path}`);
      await mkdir(dirname(join(to, path)), { recursive: true });
      await cp(join(ROOT, path), join(to, path), { errorOnExist: true, force: false });
    }
    const fingerprint = await inspectArtifact(to, true);
    if (destination === "web") {
      for (const entry of fingerprint.contents) {
        if (!WEB_METADATA.includes(entry.path) && !WEB_GENERATED_FILES.has(entry.path)
          && !WEB_GENERATED_PATTERNS.some((pattern) => pattern.test(entry.path))) {
          throw new Error(`Unexpected web artifact file: ${entry.path}`);
        }
      }
      await auditWebContents(to, fingerprint.contents);
    }
    return { artifact: relative(ROOT, to).replaceAll("\\", "/"), ...fingerprint };
  } catch (error) {
    await rm(to, { recursive: true, force: true });
    throw error;
  }
}

async function auditWebContents(directory, contents) {
  const paths = new Set(contents.map((entry) => entry.path));
  const localPaths = new Set([resolve(ROOT), await realpath(ROOT)]);
  for (const { path } of contents) {
    const bytes = await readFile(join(directory, path));
    const compressed = /\.(br|gz|zst)$/.exec(path);
    if (compressed) {
      const plainPath = path.slice(0, -compressed[0].length);
      if (!paths.has(plainPath)) throw new Error(`Compressed web asset has no plain sibling: ${path}`);
      const decoder = compressed[1] === "br" ? zlib.brotliDecompressSync
        : compressed[1] === "gz" ? zlib.gunzipSync : zlib.zstdDecompressSync;
      // The plain sibling is scanned on runtimes without a Zstandard decoder.
      if (decoder) {
        const plain = await readFile(join(directory, plainPath));
        try {
          if (!decoder(bytes, { maxOutputLength: plain.length + 1 }).equals(plain)) throw new Error();
        } catch { throw new Error(`Compressed web asset differs from its plain sibling: ${path}`); }
      }
      continue;
    }
    const text = bytes.toString("utf8");
    if (/-----BEGIN (?:ENCRYPTED |RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) ||
      [...localPaths].some((localPath) => text.includes(localPath)))
      throw new Error(`Web artifact contains private key text or a local source path: ${path}`);
  }
}

async function auditJavaScriptLicenseInventory() {
  const lock = JSON.parse(await readFile(join(ROOT, "package-lock.json"), "utf8"));
  const inventory = JSON.parse(await readFile(join(ROOT, "THIRD_PARTY_LICENSES.json"), "utf8"));
  if (inventory.schemaVersion !== 1 || inventory.generatedFrom !== "package-lock.json" || !Array.isArray(inventory.packages)) {
    throw new Error("JavaScript license inventory has an unsupported or invalid format");
  }
  const locked = Object.entries(lock.packages ?? {})
    .filter(([path, pkg]) => path.includes("node_modules/") && pkg.version)
    .map(([path, pkg]) => ({
      name: pkg.name ?? path.split("node_modules/").at(-1),
      version: pkg.version,
      license: pkg.license ?? "UNKNOWN",
    }))
    .sort(compareLicenseEntries);
  const listed = inventory.packages
    .map(({ name, version, license }) => ({ name, version, license }))
    .sort(compareLicenseEntries);
  if (JSON.stringify(listed) !== JSON.stringify(locked)) {
    throw new Error("JavaScript license inventory does not match package-lock.json; run npm run license:inventory");
  }
}

function compareLicenseEntries(a, b) {
  return a.name.localeCompare(b.name) || a.version.localeCompare(b.version) || a.license.localeCompare(b.license);
}

async function inspectArtifact(path, fingerprint = false) {
  let files = 0, bytes = 0;
  const contents = [];
  async function visit(current) {
    const segments = relative(path, current).split(/[\\/]/);
    if (segments.some((segment) => /^(?:\.env(?:\..*)?|\.npmrc|\.git|\.ssh|node_modules|receipts|credentials?\.json|secrets?\.json|google-services\.json|GoogleService-Info\.plist)$/i.test(segment)
      || /\.(?:pem|p12|mobileprovision|key)$/i.test(segment))) {
      throw new Error(`Artifact contains a private or development file: ${relative(path, current)}`);
    }
    const info = await lstat(current);
    if (info.isFile()) {
      files++; bytes += info.size;
      if (fingerprint) contents.push({
        path: (current === path ? basename(current) : relative(path, current)).replaceAll("\\", "/"),
        bytes: info.size,
        sha256: await fileSha256(current),
      });
    }
    else if (info.isDirectory()) {
      for (const entry of await readdir(current)) await visit(join(current, entry));
    } else throw new Error("Artifact contains a symlink or unsupported file type");
  }
  await visit(path);
  if (!files || !bytes) throw new Error("Artifact has no nonempty regular files");
  if (!fingerprint) return;
  contents.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const digest = createHash("sha256");
  for (const entry of contents) digest.update(JSON.stringify(entry) + "\n");
  return { bytes, sha256: digest.digest("hex"), contents };
}

async function fileSha256(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function sourceProvenance() {
  let revision = null, tree = null, workingTreeClean = null;
  try {
    const gitRoot = (await run("git", ["rev-parse", "--show-toplevel"], { cwd: ROOT })).stdout.trim();
    if (resolve(gitRoot) === resolve(ROOT)) {
      revision = (await run("git", ["rev-parse", "HEAD"], { cwd: ROOT })).stdout.trim();
      tree = (await run("git", ["rev-parse", "HEAD^{tree}"], { cwd: ROOT })).stdout.trim();
      workingTreeClean = !(await run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: ROOT })).stdout.trim();
    }
  } catch { /* A fixture or source archive may have no Git history. */ }
  let packageLockSha256 = null;
  try { packageLockSha256 = await fileSha256(join(ROOT, "package-lock.json")); } catch { /* Lockfile not present. */ }
  return { revision, tree, workingTreeClean, packageLockSha256 };
}

function firstMeaningfulLine(error) {
  const text = `${error.stderr ?? ""}\n${error.stdout ?? ""}\n${error.message ?? ""}`;
  const line = text.split("\n").map((entry) => entry.trim())
    .find((entry) => entry && !entry.startsWith("npm ERR") && !entry.startsWith(">"));
  return (line ?? "unavailable").slice(0, 200);
}
