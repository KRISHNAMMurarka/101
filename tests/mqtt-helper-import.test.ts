import assert from 'node:assert/strict';
import test from 'node:test';

test('MQTT helper import does not inspect an unrelated CLI argument', async () => {
  const previous = process.argv[1]; process.argv[1] = '101-unrelated-nonfile-argument';
  try {
    const helper = await import('../tools/qa-mqtt-connector.mjs');
    assert.equal(typeof helper.startOwnedMqttBroker, 'function');
  } finally { if (previous === undefined) process.argv.splice(1, 1); else process.argv[1] = previous; }
});
