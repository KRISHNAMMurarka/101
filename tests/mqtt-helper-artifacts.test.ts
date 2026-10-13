import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { opcUaQaSourceFingerprints } from '../tools/qa-opcua-json-telemetry.mjs';

const root = resolve(import.meta.dirname, '..');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function phase(path: string, start: string, end: string) {
  const source = readFileSync(join(root, path), 'utf8');
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, 'Select the actual installed artifact producer phase');
  return source.slice(from, to);
}

// Removing the sibling from any production copy list breaks its actual copied
// helper import. Execute those existing producer statements without creating
// fake SDK receipts, invoking a broker, or claiming an installed SDK rehearsal.
for (const kind of ['connector', 'clocked', 'zigbee'] as const) {
  test(`copied ${kind} broker helper carries its executable module dependency`, async () => {
    mkdirSync(join(root, 'outputs/batches'), { recursive: true });
    const consumer = mkdtempSync(join(root, 'outputs/batches/helper-artifacts-'));
    const context = { root, consumer, hash, digest: hash, assert, ts, join,
      mkdirSync, mkdtempSync, readFileSync, writeFileSync };
    try {
      let helper: string;
      if (kind === 'zigbee') {
        const sourceBefore: Record<string, string> = {};
        for (const path of ['packages/hub-server/src/zigbee2mqtt-bridge.ts', 'packages/hub-server/src/zigbee2mqtt-bridge.test.ts',
          'examples/zigbee2mqtt-bridge/producer.mjs', 'examples/zigbee2mqtt-bridge/consumer.mjs',
          'tools/qa-zigbee2mqtt-bridge.mjs', 'tools/qa-installed-zigbee2mqtt-bridge.mjs', 'tools/mqtt-broker-binary.mjs']) {
          sourceBefore[join(root, path)] = hash(readFileSync(join(root, path)));
        }
        helper = runInNewContext(phase('tools/qa-installed-zigbee2mqtt-bridge.mjs', 'const sources =', 'const brokerBinary=')
          + '\nhelperPath;', { ...context, sourceBefore }) as string;
      } else {
        runInNewContext(phase('tools/qa-installed-connectors.mjs', 'const work =', 'const { runModbusRegisterConsumer }'), { ...context });
        helper = join(consumer, 'selected-node-connectors/mqtt-qa.mjs');
        if (kind === 'clocked') {
          runInNewContext(phase('tools/qa-installed-clocked-mqtt.mjs', 'const work =', 'const { runClockedMqttConnectorQa }'), { ...context });
          helper = join(consumer, 'clocked-node-connector/qa-mqtt-connector.mjs');
        }
      }
      const imported = await import(pathToFileURL(helper).href);
      assert.equal(typeof (kind === 'zigbee' ? imported.startOwnedZigbeeBroker : imported.startOwnedMqttBroker), 'function');
      assert.equal(readFileSync(join(dirname(helper), 'mqtt-broker-binary.mjs'), 'utf8'),
        readFileSync(join(root, 'tools/mqtt-broker-binary.mjs'), 'utf8'));
    } finally { rmSync(consumer, { recursive: true, force: true }); }
  });
}

test('OPC UA source receipt binds the executed broker discovery module', () => {
  const path = join(root, 'tools/mqtt-broker-binary.mjs');
  assert.equal(opcUaQaSourceFingerprints()[path], hash(readFileSync(path)));
});
