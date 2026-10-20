#!/usr/bin/env node
// Local packaging only. Each run owns one new directory; prior artifacts survive.
// Default mode is diagnostic and reports build skips with exit zero. In --release
// mode every selected target is required and must have a production profile.
// Successful packaging does not establish signing, installation or release acceptance.
//
//   node tools/package-release.mjs                    # diagnostic, web application
//   node tools/package-release.mjs --release web      # required web production target

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { auditReleaseLicenseInventories } from "./license-inventory-validation.mjs";
import { DECLARED_LICENSE_SOURCES_PATH, collectDeclaredLicenseRepositoryFiles, verifyCopiedLicenseRepositoryFiles } from "./generate-license-inventory.mjs";
import { auditWebRuntimeAssets } from "./web-artifact-validation.mjs";
import * as zlib from "node:zlib";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB_METADATA = [
  "LICENSE", "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_LICENSES.json",
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
    description: "Standalone browser build of the launcher, manifest-defined games and their player surfaces",
    async build() {
      await auditReleaseLicenseInventories(ROOT);
      await npm("build");
      return collect("dist", "web", WEB_METADATA, await collectDeclaredLicenseRepositoryFiles(ROOT));
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
const version = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")).version;
const admittedSource = await sourceProvenance();
const builderSha256 = await fileSha256(fileURLToPath(import.meta.url));

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

let finishedSource = null, verificationError = null;
try { finishedSource = await sourceProvenance(); }
catch (error) { verificationError = firstMeaningfulLine(error); }
const inputsStable = finishedSource !== null && JSON.stringify(admittedSource) === JSON.stringify(finishedSource);
const beforeFiles = new Map(admittedSource.inputs.files.map((entry) => [entry.path, entry]));
const afterFiles = new Map((finishedSource?.inputs.files ?? []).map((entry) => [entry.path, entry]));
const changedInputs = finishedSource ? [...new Set([...beforeFiles.keys(), ...afterFiles.keys()])].sort()
  .filter((path) => JSON.stringify(beforeFiles.get(path)) !== JSON.stringify(afterFiles.get(path)))
  .map((path) => ({ path, before: beforeFiles.get(path) ?? null, after: afterFiles.get(path) ?? null })) : [];
if (!inputsStable) {
  // These copies belong exclusively to this invocation. Earlier runs survive.
  for (const artifact of produced.splice(0)) {
    await rm(join(ROOT, artifact.artifact), { recursive: true, force: true });
    skipped.push({ target: artifact.target, profile: artifact.profile,
      reason: verificationError ? `Build input verification failed: ${verificationError}` : "Build inputs changed during packaging" });
  }
}

const manifest = {
  schemaVersion: 2,
  version,
  source: admittedSource,
  buildInputVerification: {
    stable: inputsStable,
    after: finishedSource ? { ...finishedSource, inputs: { scope: finishedSource.inputs.scope, sha256: finishedSource.inputs.sha256 } } : null,
    error: verificationError,
    changedInputs,
  },
  environment: { node: process.versions.node, npm: (await run("npm", ["--version"])).stdout.trim(), platform: process.platform, arch: process.arch },
  builderSha256,
  mode,
  requiredTargets: mode === "release" ? selected.map((target) => target.name) : [],
  status: mode === "diagnostic" ? "diagnostic" : skipped.length || !inputsStable ? "incomplete" : "complete",
  packagingComplete: mode === "release" && skipped.length === 0 && inputsStable,
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
if (mode === "release" && (skipped.length || !inputsStable)) process.exitCode = 1;


async function npm(script) {
  await run("npm", ["run", script], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
}

async function collect(source, destination, metadata = [], authorFiles = []) {
  const selectedMetadata = [...new Set([...metadata, ...authorFiles.map(file => file.path)])];
  const from = join(ROOT, source);
  const to = join(OUT, destination);
  try {
    await inspectArtifact(from);
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to, { recursive: true, errorOnExist: true, force: false });
    for (const path of selectedMetadata) {
      if (!(await lstat(join(ROOT, path))).isFile()) throw new Error(`Required metadata is not a regular file: ${path}`);
      await mkdir(dirname(join(to, path)), { recursive: true });
      await cp(join(ROOT, path), join(to, path), { errorOnExist: true, force: false });
    }
    await verifyCopiedLicenseRepositoryFiles(to, authorFiles);
    const fingerprint = await inspectArtifact(to, true);
    if (destination === "web") {
      for (const entry of fingerprint.contents) {
        if (!selectedMetadata.includes(entry.path) && !WEB_GENERATED_FILES.has(entry.path)
          && !WEB_GENERATED_PATTERNS.some((pattern) => pattern.test(entry.path))) {
          throw new Error(`Unexpected web artifact file: ${entry.path}`);
        }
      }
      await auditWebRuntimeAssets(to, fingerprint.contents);
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
  let gitRoot = null;
  try {
    gitRoot = (await run("git", ["rev-parse", "--show-toplevel"], { cwd: ROOT })).stdout.trim();
  } catch { /* A fixture or source archive may have no Git history. */ }
  let scope = "declared-packaging-files-only";
  let paths = ["package.json", "package-lock.json", DECLARED_LICENSE_SOURCES_PATH, ...WEB_METADATA,
    "tools/package-release.mjs", "tools/license-inventory-validation.mjs", "tools/generate-license-inventory.mjs", "tools/web-artifact-validation.mjs"];
  if (gitRoot && resolve(gitRoot) === resolve(ROOT)) {
    revision = (await run("git", ["rev-parse", "HEAD"], { cwd: ROOT })).stdout.trim();
    tree = (await run("git", ["rev-parse", "HEAD^{tree}"], { cwd: ROOT })).stdout.trim();
    workingTreeClean = !(await run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: ROOT })).stdout.trim();
    const listed = (await run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 })).stdout;
    paths = [...paths, ...listed.split("\0").filter(Boolean)];
    scope = "git-versioned-and-unignored-files-plus-declared-packaging-files";
  }
  paths.push(...(await collectDeclaredLicenseRepositoryFiles(ROOT)).map(file => file.path));
  const files = [];
  for (const path of [...new Set(paths)].sort()) {
    try {
      const info = await lstat(join(ROOT, path));
      if (!info.isFile()) throw new Error(`Build input is not a regular file: ${path}`);
      files.push({ path, bytes: info.size, sha256: await fileSha256(join(ROOT, path)) });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      files.push({ path, missing: true });
    }
  }
  const packageLockSha256 = files.find((entry) => entry.path === "package-lock.json")?.sha256 ?? null;
  return { revision, tree, workingTreeClean, packageLockSha256,
    inputs: { scope, sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"), files } };
}

function firstMeaningfulLine(error) {
  const text = `${error.stderr ?? ""}\n${error.stdout ?? ""}\n${error.message ?? ""}`;
  const line = text.split("\n").map((entry) => entry.trim())
    .find((entry) => entry && !entry.startsWith("npm ERR") && !entry.startsWith(">"));
  return (line ?? "unavailable").slice(0, 200);
}
