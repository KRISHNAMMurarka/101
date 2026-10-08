import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const paths = [
  'packages/hub-server/src/mechanical-relay-gateway.ts',
  'packages/hub-server/src/mechanical-relay-gateway.test.ts',
  'examples/mechanical-relay/software-relay-fixtures.mjs',
  'examples/mechanical-relay/consumer.mjs',
  'tools/qa-mechanical-relay.mjs',
  'tools/qa-installed-mechanical-relay.mjs',
];
const bytes = Object.fromEntries(await Promise.all(paths.map(async path =>
  [path, await readFile(new URL(`../${path}`, import.meta.url))])));
const sourceSha256 = Object.fromEntries(Object.entries(bytes).map(([path, value]) =>
  [path, createHash('sha256').update(value).digest('hex')]));

const { runMechanicalRelayConsumer } = await import('../examples/mechanical-relay/consumer.mjs');
const result = await runMechanicalRelayConsumer();
for (const path of paths) {
  const finalHash = createHash('sha256').update(await readFile(new URL(`../${path}`, import.meta.url))).digest('hex');
  assert.equal(finalHash, sourceSha256[path]);
}

const receipt = {
  schemaVersion: 1,
  status: result.status,
  environment: { node: process.version, platform: process.platform },
  sourceSha256,
  result,
  scope: 'Selected paired software relay fixtures only. Command completion and independently scripted software feedback do not verify physical actuation, carrier, watchdog hardware, sensor hardware, or target state.',
};
if (process.argv[2]) await writeFile(process.argv[2], `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt));
