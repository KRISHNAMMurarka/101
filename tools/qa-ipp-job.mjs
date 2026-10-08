import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { runIppJobConsumer } from '../examples/ipp-job/consumer.mjs';

const paths = ['packages/hub-server/src/ipp-job-gateway.ts', 'packages/hub-server/src/ipp-job-gateway.test.ts',
  'examples/ipp-job/consumer.mjs', 'examples/ipp-job/software-printer.mjs', 'tools/qa-ipp-job.mjs'];
const result = await runIppJobConsumer();
const sourceSha256 = Object.fromEntries(await Promise.all(paths.map(async path =>
  [path, createHash('sha256').update(await readFile(new URL(`../${path}`, import.meta.url))).digest('hex')])));
const receipt = { schemaVersion: 1, status: result.status, environment: { node: process.version, platform: process.platform },
  sourceSha256, result };
if (process.argv[2]) await writeFile(process.argv[2], `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt));
