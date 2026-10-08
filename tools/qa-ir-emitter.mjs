import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const paths = ['packages/hub-server/src/nec32-ir-emitter-gateway.ts', 'packages/hub-server/src/nec32-ir-emitter-gateway.test.ts',
  'examples/ir-emitter/software-emitter.mjs', 'examples/ir-emitter/consumer.mjs', 'tools/qa-ir-emitter.mjs',
  'tools/qa-installed-ir-emitter.mjs'];
const before = Object.fromEntries(await Promise.all(paths.map(async path => [path, await readFile(new URL(`../${path}`, import.meta.url))])));
const sourceSha256 = Object.fromEntries(Object.entries(before).map(([path, bytes]) =>
  [path, createHash('sha256').update(bytes).digest('hex')]));
const { runIrEmitterConsumer } = await import('../examples/ir-emitter/consumer.mjs');
const result = await runIrEmitterConsumer();
for (const path of paths) assert.equal(createHash('sha256').update(await readFile(new URL(`../${path}`, import.meta.url))).digest('hex'),
  sourceSha256[path], `Source changed while QA imported or copied ${path}`);
const receipt = { schemaVersion: 1, status: result.status, environment: { node: process.version, platform: process.platform },
  sourceSha256, result, scope: 'Selected one-shot NEC inverse-byte software fixture. Provider completion only; physical carrier, appliance acknowledgement, independently observed state, GPIO and firmware remain unverified or unsupported.' };
if (process.argv[2]) await writeFile(process.argv[2], `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt));
