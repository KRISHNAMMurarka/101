#!/usr/bin/env node
// Local packaging only. Each run owns one new directory; prior artifacts survive.
// Default mode is diagnostic and reports build skips with exit zero. In --release
// mode every selected target is required and must have a production profile.
// Successful packaging does not establish signing, installation or release acceptance.
//
//   node tools/package-release.mjs                    # diagnostic, all targets
//   node tools/package-release.mjs --release web hub  # required production targets

import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB_METADATA = [
  "LICENSE", "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_LICENSES.json", "THIRD_PARTY_RUST_LICENSES.json",
  "third_party/APACHE-2.0.txt", "docs/vision.md",
];

const TARGETS = [
  {
    name: "web",
    profile: "production",
    description: "Standalone browser build of the launcher, all ten games and the Labs",
    async build() {
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
    produced.push({ target: target.name, profile: target.profile, artifact });
    console.log(`  ok  ${artifact}`);
  } catch (error) {
    const reason = firstMeaningfulLine(error);
    skipped.push({ target: target.name, profile: target.profile, reason });
    console.log(`  skipped  ${reason}`);
  }
}

const manifest = {
  schemaVersion: 1,
  version: JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")).version,
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
    await inspectArtifact(to);
    return relative(ROOT, to).replaceAll("\\", "/");
  } catch (error) {
    await rm(to, { recursive: true, force: true });
    throw error;
  }
}

async function inspectArtifact(path) {
  let files = 0, bytes = 0;
  async function visit(current) {
    const info = await lstat(current);
    if (info.isFile()) { files++; bytes += info.size; }
    else if (info.isDirectory()) {
      for (const entry of await readdir(current)) await visit(join(current, entry));
    } else throw new Error("Artifact contains a symlink or unsupported file type");
  }
  await visit(path);
  if (!files || !bytes) throw new Error("Artifact has no nonempty regular files");
}

function firstMeaningfulLine(error) {
  const text = `${error.stderr ?? ""}\n${error.stdout ?? ""}\n${error.message ?? ""}`;
  const line = text.split("\n").map((entry) => entry.trim())
    .find((entry) => entry && !entry.startsWith("npm ERR") && !entry.startsWith(">"));
  return (line ?? "unavailable").slice(0, 200);
}
