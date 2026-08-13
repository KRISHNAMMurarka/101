#!/usr/bin/env node
// Verifies that the watch companion actually compiles for watchOS, not merely for macOS.
//
// `swift test` runs the shared core fast on the host, which is what you want while iterating, but
// it proves nothing about the watch: the app shell imports WatchConnectivity, CoreMotion, WatchKit
// and SwiftUI, none of which the host build touches. This typechecks every source against the real
// watchOS SDK so a watch-only API mistake fails here rather than on a developer's wrist.
//
// It needs the watchOS SDK from Xcode, but deliberately not an installed watchOS simulator
// runtime, so it stays runnable on a machine that has not downloaded several gigabytes of
// platform support. Where the SDK is absent it skips with a clear message instead of failing.

import { execFile } from "node:child_process";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = new URL("../apps/watch-ios/", import.meta.url).pathname;
const TARGET = "arm64_32-apple-watchos10.0";

const sdk = await watchOSSDK();
if (!sdk) {
  console.log("SKIP: no watchOS SDK is installed. Install the watchOS platform in Xcode to run this check.");
  process.exit(0);
}
console.log(`Using watchOS SDK: ${sdk}`);

const build = await mkdtemp(join(tmpdir(), "one01-watch-"));
const core = await swiftFiles("Sources/One01WatchCore");
const app = await swiftFiles("App");

// The core has to become a real module first, because the app shell imports it.
await compile(["-emit-module", "-module-name", "One01WatchCore", "-emit-module-path", join(build, "One01WatchCore.swiftmodule"), ...core]);
console.log(`  ok  One01WatchCore (${core.length} files) builds for watchOS`);

await compile(["-typecheck", "-I", build, ...app]);
console.log(`  ok  watchOS app shell (${app.length} files) typechecks against WatchConnectivity, CoreMotion, WatchKit and SwiftUI`);

console.log("\nPASS: the watch companion compiles for watchOS.");

async function compile(args) {
  try {
    await run("swiftc", ["-sdk", sdk, "-target", TARGET, ...args], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    console.error(error.stderr || error.message);
    process.exit(1);
  }
}

async function swiftFiles(directory) {
  const entries = await readdir(join(ROOT, directory));
  return entries.filter((entry) => entry.endsWith(".swift")).map((entry) => join(directory, entry));
}

async function watchOSSDK() {
  try {
    const { stdout } = await run("xcrun", ["--sdk", "watchos", "--show-sdk-path"]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
