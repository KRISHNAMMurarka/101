import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { runModbusRegisterConsumer } from '../examples/modbus-register/consumer.mjs';

const paths = ['packages/hub-server/src/modbus-register.ts', 'packages/hub-server/src/modbus-register.test.ts',
  'examples/modbus-register/consumer.mjs', 'tools/qa-modbus-register.mjs'];
const sourceSha256 = Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(new URL('../' + path, import.meta.url))).digest('hex')]));
const result = await runModbusRegisterConsumer();
const receipt = { schemaVersion: 1, status: result.status, environment: { node: process.version, platform: process.platform }, sourceSha256, result };
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt));
