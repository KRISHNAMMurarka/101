import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runLearningQualification } from './qa-ir-learning.mjs';

/** Root prepares byte-exact copies beneath an existing ordinary installed consumer. This runner never copies/builds/installs. */
export function runInstalledLearningQualification(manifestPath, observerOptions) {
  return runLearningQualification(manifestPath, 'installed-positive', observerOptions);
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  assert.equal(process.argv.length, 3, 'Expected a root-frozen installed positive manifest');
  const result = await runInstalledLearningQualification(process.argv[2]);
  console.log(JSON.stringify({ status: result.status, primaryError: result.primaryError, cleanupErrors: result.cleanupErrors }));
  process.exitCode = result.status === 'joined-software-learning' ? 0 : 1;
}
