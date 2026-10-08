import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { runOnvifSnapshotConsumer } from '../examples/onvif-snapshot/consumer.mjs';

const paths = ['packages/hub-server/src/onvif-snapshot-gateway.ts', 'packages/hub-server/src/onvif-snapshot-gateway.test.ts',
  'examples/onvif-snapshot/software-camera.mjs', 'examples/onvif-snapshot/consumer.mjs', 'tools/qa-onvif-snapshot.mjs',
  'tools/qa-installed-onvif-snapshot.mjs'];
const result = await runOnvifSnapshotConsumer();
const sourceSha256 = Object.fromEntries(await Promise.all(paths.map(async path => [path,
  createHash('sha256').update(await readFile(new URL(`../${path}`, import.meta.url))).digest('hex')])));
const receipt = { schemaVersion: 1, status: result.status, environment: { node: process.version, platform: process.platform }, sourceSha256, result };
if (process.argv[2]) await writeFile(process.argv[2], `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt));
