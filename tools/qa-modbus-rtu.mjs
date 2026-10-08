import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { runModbusRtuConsumer } from '../examples/modbus-rtu/consumer.mjs';

const paths = ['packages/hub-server/src/modbus-rtu.ts', 'packages/hub-server/src/modbus-rtu.test.ts',
  'examples/modbus-rtu/consumer.mjs', 'examples/modbus-rtu/producer.mjs', 'tools/qa-modbus-rtu.mjs'];
const sourceSha256 = Object.fromEntries(paths.map(path => [path,
  createHash('sha256').update(readFileSync(new URL('../' + path, import.meta.url))).digest('hex')]));
const result = await runModbusRtuConsumer();
const receipt = { schemaVersion: 1, status: result.status, environment: { node: process.version, platform: process.platform },
  sourceSha256, result };
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt));
