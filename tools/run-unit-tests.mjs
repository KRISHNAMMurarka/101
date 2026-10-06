import { spawnSync } from "node:child_process";
import { discoverUnitTests } from "./unit-test-files.mjs";

const files = discoverUnitTests();
if (!files.length) throw new Error("No unit tests discovered");
// Native fixtures keep their real readiness/deadline bounds. Bound simultaneous
// test processes so the gate does not oversubscribe the host with those fixtures.
const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test", "--test-concurrency=4", ...process.argv.slice(2), ...files], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
