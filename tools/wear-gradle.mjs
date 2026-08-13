#!/usr/bin/env node
// Runs a Gradle task for the Wear OS companion with the toolchain resolved for you.
//
// The Android Gradle Plugin needs an SDK location and a JDK it supports, and it fails with a
// generic message when either is missing. Both live in predictable places on a normal developer
// machine, so this finds them and explains precisely what to install when it cannot — rather than
// making every contributor rediscover that the Kotlin/CMake toolchain rejects newer JDKs.

import { execFile, spawn } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const PROJECT = new URL("../apps/watch-wear/", import.meta.url).pathname;
const REQUIRED_JDK = 21;

const task = process.argv[2];
if (!task) {
  console.error("Usage: node tools/wear-gradle.mjs <gradle-task>");
  process.exit(1);
}

const androidHome = await resolveAndroidHome();
if (!androidHome) {
  console.error("No Android SDK found.\n" +
    "Set ANDROID_HOME, or install the SDK through Android Studio.\n" +
    "The Wear OS build needs platform API 36 and build-tools.");
  process.exit(1);
}

const javaHome = await resolveJavaHome();
if (!javaHome) {
  console.error(`No JDK ${REQUIRED_JDK} found.\n` +
    `The Android Gradle Plugin's toolchain rejects newer JDKs, so JDK ${REQUIRED_JDK} is required even if a later one is installed.\n` +
    `Install it (for example \`brew install openjdk@${REQUIRED_JDK}\`) or point JAVA_HOME at an existing one.`);
  process.exit(1);
}

console.log(`Android SDK: ${androidHome}`);
console.log(`JDK:         ${javaHome}\n`);

const gradle = spawn("./gradlew", [task, "--console=plain"], {
  cwd: PROJECT,
  stdio: "inherit",
  env: { ...process.env, ANDROID_HOME: androidHome, JAVA_HOME: javaHome },
});
gradle.on("exit", (code) => process.exit(code ?? 1));

async function resolveAndroidHome() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), "Library/Android/sdk"),
    join(homedir(), "Android/Sdk"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await exists(join(candidate, "platforms"))) return candidate;
  }
  return undefined;
}

async function resolveJavaHome() {
  if (process.env.JAVA_HOME && await isRequiredJDK(process.env.JAVA_HOME)) return process.env.JAVA_HOME;

  // macOS keeps a registry of installed JDKs; ask it for the exact major version.
  try {
    const { stdout } = await run("/usr/libexec/java_home", ["-v", String(REQUIRED_JDK)]);
    if (stdout.trim()) return stdout.trim();
  } catch { /* Not macOS, or no matching JDK registered. */ }

  const candidates = [
    `/opt/homebrew/opt/openjdk@${REQUIRED_JDK}`,
    `/usr/local/opt/openjdk@${REQUIRED_JDK}`,
    `/usr/lib/jvm/java-${REQUIRED_JDK}-openjdk-amd64`,
  ];
  for (const candidate of candidates) {
    if (await isRequiredJDK(candidate)) return candidate;
  }

  // Homebrew installs versioned JDKs under a libexec path on some setups.
  try {
    const base = "/opt/homebrew/Cellar/openjdk@" + REQUIRED_JDK;
    for (const entry of await readdir(base)) {
      const candidate = join(base, entry, "libexec/openjdk.jdk/Contents/Home");
      if (await isRequiredJDK(candidate)) return candidate;
    }
  } catch { /* Not installed through Homebrew. */ }

  return undefined;
}

async function isRequiredJDK(home) {
  if (!await exists(join(home, "bin/javac"))) return false;
  try {
    const { stdout, stderr } = await run(join(home, "bin/javac"), ["-version"]);
    return `${stdout}${stderr}`.includes(`javac ${REQUIRED_JDK}.`);
  } catch {
    return false;
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
