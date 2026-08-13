#!/usr/bin/env node
// Production dependency gate.
//
// `npm audit --omit=dev` cannot distinguish code that ships to a player from build tooling that
// only ever runs on a developer machine. Both live under the native app's production dependencies
// because that is how Expo declares itself. Deleting the gate would hide real risk; leaving it
// permanently red would train everyone to ignore it.
//
// So: every advisory must either be absent, or be individually reviewed in
// security/build-tooling-advisories.json with a dependency path, a justification and an expiry.
// Anything unreviewed fails. Any review past its date fails. New advisories can never be
// absorbed silently.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const ALLOWLIST = new URL("../security/build-tooling-advisories.json", import.meta.url);
const run = promisify(execFile);

const audit = await runAudit();
const reviewed = await readReviewed();
const advisories = Object.values(audit.vulnerabilities ?? {});

// Only entries carrying their own advisory are real findings. The rest are "depends on a
// vulnerable package" propagation that resolves automatically once the root cause is fixed.
const roots = advisories.filter((entry) => entry.via.some((via) => typeof via === "object"));
const propagated = advisories.length - roots.length;

const today = new Date().toISOString().slice(0, 10);
const unreviewed = [];
const expired = [];
const accepted = [];

for (const entry of roots) {
  const record = reviewed.get(entry.name);
  if (!record) { unreviewed.push(entry); continue; }
  if (record.reviewBy < today) { expired.push({ entry, record }); continue; }
  accepted.push({ entry, record });
}

const stale = [...reviewed.values()].filter((record) => !roots.some((entry) => entry.name === record.package));

console.log(`101 production dependency audit — ${audit.metadata.vulnerabilities.total} advisory entries (${roots.length} root cause, ${propagated} propagated)\n`);

for (const { entry, record } of accepted) {
  console.log(`  ACCEPTED  ${entry.severity.padEnd(8)} ${entry.name}`);
  console.log(`            ${record.path}`);
  console.log(`            ${record.surface} · vulnerable path reachable: ${record.vulnerableCodePathReachable} · review by ${record.reviewBy}`);
}

for (const entry of unreviewed) {
  console.error(`  UNREVIEWED ${entry.severity.padEnd(8)} ${entry.name}  (${entry.range})`);
  console.error(`            ${entry.via.filter((via) => typeof via === "object").map((via) => via.title).join(" | ")}`);
}

for (const { entry, record } of expired) {
  console.error(`  EXPIRED   ${entry.severity.padEnd(8)} ${entry.name}  (review was due ${record.reviewBy})`);
}

for (const record of stale) {
  console.error(`  STALE     ${record.package} is reviewed but no longer reported — remove it from the allowlist`);
}

if (unreviewed.length || expired.length || stale.length) {
  console.error(`\nFAIL: ${unreviewed.length} unreviewed, ${expired.length} expired, ${stale.length} stale.`);
  console.error("Fix the dependency, or review it in security/build-tooling-advisories.json with a path, justification and expiry.");
  process.exit(1);
}

console.log(`\nPASS: no unreviewed advisories. ${accepted.length} build-tooling exception(s) in force.`);

async function runAudit() {
  try {
    const { stdout } = await run("npm", ["audit", "--omit=dev", "--json"], { maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    // npm audit exits non-zero whenever it finds anything; the JSON report is still on stdout.
    if (typeof error.stdout === "string" && error.stdout.trim()) return JSON.parse(error.stdout);
    throw error;
  }
}

async function readReviewed() {
  const parsed = JSON.parse(await readFile(ALLOWLIST, "utf8"));
  const records = new Map();
  for (const record of parsed.reviewed) {
    for (const field of ["package", "path", "surface", "justification", "reviewed", "reviewBy"]) {
      if (typeof record[field] !== "string" || !record[field]) throw new Error(`Allowlist entry ${record.package ?? "?"} is missing ${field}`);
    }
    if (record.surface !== "build-tooling") throw new Error(`Only build-tooling advisories may be accepted; ${record.package} claims ${record.surface}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(record.reviewBy)) throw new Error(`Allowlist entry ${record.package} has an invalid reviewBy date`);
    records.set(record.package, record);
  }
  return records;
}
