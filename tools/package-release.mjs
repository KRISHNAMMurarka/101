#!/usr/bin/env node
// Builds the distributable 101 artifacts and collects them under `release/`.
//
// The targets need genuinely different toolchains — Node for the web build, Rust and Tauri for the
// desktop Hub, the Android SDK and JDK 21 for the Wear OS watch, Xcode for anything Apple — and no
// single machine is guaranteed to have all of them. So each target is attempted independently and
// the run reports exactly what was produced, what was skipped, and why.
//
// A skipped target is never silently omitted: "we shipped everything" and "we shipped what this
// machine could build" are different claims, and only the second one is usually true.
//
//   node tools/package-release.mjs            # everything this machine can build
//   node tools/package-release.mjs web hub    # only the named targets

import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = new URL("..", import.meta.url).pathname;
const OUT = join(ROOT, "release");

const TARGETS = [
  {
    name: "web",
    description: "Standalone browser build of the launcher, all ten games and the Labs",
    async build() {
      await npm("build");
      return collect("dist", "web");
    },
  },
  {
    name: "hub",
    description: "Native 101 Hub desktop bundle for this platform",
    async build() {
      await npm("desktop:app");
      // Tauri writes per-platform bundles; take whichever this OS produced.
      const bundles = join(ROOT, "apps/desktop-hub/src-tauri/target/release/bundle");
      if (!(await exists(bundles))) throw new Error("Tauri produced no bundle directory");
      return collect(bundles, "desktop-hub", { from: bundles });
    },
  },
  {
    name: "link",
    description: "JavaScript bundles for native 101 Link (iOS and Android)",
    async build() {
      await npm("native:export");
      return collect("apps/controller-native/dist", "link-native");
    },
  },
  {
    name: "wear",
    description: "Wear OS watch companion APK",
    async build() {
      await npm("watch:wear:build");
      return collect("apps/watch-wear/app/build/outputs/apk/debug/app-debug.apk", "watch-wear/101-link-wear-debug.apk");
    },
  },
];

const requested = process.argv.slice(2);
const selected = requested.length ? TARGETS.filter((target) => requested.includes(target.name)) : TARGETS;
if (!selected.length) {
  console.error(`Unknown target. Available: ${TARGETS.map((target) => target.name).join(", ")}`);
  process.exit(1);
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const produced = [];
const skipped = [];

for (const target of selected) {
  process.stdout.write(`\n▸ ${target.name} — ${target.description}\n`);
  try {
    const artifact = await target.build();
    produced.push({ target: target.name, artifact });
    console.log(`  ok  ${artifact}`);
  } catch (error) {
    const reason = firstMeaningfulLine(error);
    skipped.push({ target: target.name, reason });
    console.log(`  skipped  ${reason}`);
  }
}

const manifest = {
  // Callers stamp the time; scripts here stay deterministic so repeated runs diff cleanly.
  version: JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")).version,
  produced,
  skipped,
};
await writeFile(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`\n${produced.length} produced, ${skipped.length} skipped. See release/manifest.json`);
if (skipped.length) {
  console.log("\nSkipped targets need a toolchain this machine is missing:");
  for (const entry of skipped) console.log(`  ${entry.target}: ${entry.reason}`);
  console.log("\nThis is a report, not a failure. Install the toolchain and rerun that target alone.");
}

// iOS and watchOS deliberately have no target here. Both need a provisioning profile tied to a
// registered Apple Developer account, so a repository cannot produce an installable build for
// someone else. See docs/native-link.md and docs/watches.md for the signing steps.
console.log("\nApple installables are not built here: they require your own signing identity.");

async function npm(script) {
  await run("npm", ["run", script], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
}

async function collect(source, destination, options = {}) {
  const from = options.from ?? join(ROOT, source);
  if (!(await exists(from))) throw new Error(`${source} was not produced`);
  const to = join(OUT, destination);
  await mkdir(join(to, ".."), { recursive: true });
  await cp(from, to, { recursive: true });
  return `release/${destination}`;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function firstMeaningfulLine(error) {
  const text = `${error.stderr ?? ""}\n${error.stdout ?? ""}\n${error.message ?? ""}`;
  const line = text.split("\n").map((entry) => entry.trim())
    .find((entry) => entry && !entry.startsWith("npm ERR") && !entry.startsWith(">"));
  return (line ?? "unavailable").slice(0, 200);
}


