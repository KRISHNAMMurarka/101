import { spawnSync } from "node:child_process";
import { discoverUnitTests } from "./unit-test-files.mjs";

const files = discoverUnitTests();
if (!files.length) throw new Error("No unit tests discovered");
// Native fixtures keep their real readiness/deadline bounds. Run test processes
// serially so separate native fixtures do not compete for those bounded windows.
const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test", "--test-concurrency=1", ...process.argv.slice(2), ...files], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
