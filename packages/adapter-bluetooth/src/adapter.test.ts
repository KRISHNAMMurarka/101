import assert from "node:assert/strict";
import test from "node:test";
import { WebBluetoothAdapter, type BluetoothCharacteristic101, type BluetoothDevice101, type BluetoothGATTServer101, type BluetoothManager101, type BluetoothService101 } from "./index.ts";

class FakeCharacteristic extends EventTarget implements BluetoothCharacteristic101 {
  value?: DataView; notifying = false; writes: number[][] = [];
  async startNotifications() { this.notifying = true; return this; }
  async stopNotifications() { this.notifying = false; return this; }
  async writeValue(value: BufferSource) { this.writes.push(Array.from(new Uint8Array(value instanceof ArrayBuffer ? value : value.buffer, value instanceof ArrayBuffer ? 0 : value.byteOffset, value instanceof ArrayBuffer ? value.byteLength : value.byteLength))); }
  notify(bytes: number[]) { this.value = new DataView(Uint8Array.from(bytes).buffer); this.dispatchEvent(new Event("characteristicvaluechanged")); }
}

test("Web Bluetooth prompts only on request and consumes GATT notifications", async () => {
  const characteristic = new FakeCharacteristic();
  const service: BluetoothService101 = { async getCharacteristic() { return characteristic; } };
  const gatt: BluetoothGATTServer101 = { connected: false, async connect() { this.connected = true; return this; }, disconnect() { this.connected = false; }, async getPrimaryService() { return service; } };
  const device: BluetoothDevice101 = Object.assign(new EventTarget(), { id: "ble-101", name: "101 Sensor", gatt });
  let prompts = 0;
  const manager: BluetoothManager101 = { async getDevices() { return []; }, async requestDevice() { prompts += 1; return device; } };
  const frames: Array<{ axes?: Record<string, number> }> = [];
  const adapter = new WebBluetoothAdapter({ manager, service: "101-service", characteristic: "101-input", filters: [{ namePrefix: "101" }], mapping: { controls: [{ kind: "axis", name: "steer", offset: 0, valueType: "u8", inputCenter: 128 }] } });
  await adapter.start((frame) => frames.push(frame));
  assert.equal(prompts, 0);
  await adapter.requestDevice();
  characteristic.notify([255]);
  assert.equal(frames.at(-1)?.axes?.steer, 1);
  await adapter.write(new Uint8Array([4, 5]));
  assert.deepEqual(characteristic.writes, [[4, 5]]);
  await adapter.stop();
  assert.equal(gatt.connected, false);
});

test("Web Bluetooth releases held input when the device leaves range unexpectedly", async () => {
  const characteristic = new FakeCharacteristic();
  const service: BluetoothService101 = { async getCharacteristic() { return characteristic; } };
  const gatt: BluetoothGATTServer101 = { connected: false, async connect() { this.connected = true; return this; }, disconnect() { this.connected = false; }, async getPrimaryService() { return service; } };
  const device: BluetoothDevice101 = Object.assign(new EventTarget(), { id: "ble-101", name: "101 Sensor", gatt });
  const manager: BluetoothManager101 = { async getDevices() { return []; }, async requestDevice() { return device; } };
  const frames: Array<{ actions: Record<string, boolean | number>; axes?: Record<string, number> }> = [];
  const statuses: boolean[] = [];
  const adapter = new WebBluetoothAdapter({
    manager, service: "101-service", characteristic: "101-input", filters: [{ namePrefix: "101" }],
    onStatus: (status) => statuses.push(status.connected),
    mapping: { controls: [{ kind: "action", name: "fire", offset: 0, valueType: "u8", threshold: 1 }, { kind: "axis", name: "steer", offset: 1, valueType: "u8", inputCenter: 128 }] },
  });
  await adapter.start((frame) => frames.push(frame));
  await adapter.requestDevice();
  characteristic.notify([1, 255]);
  assert.equal(frames.at(-1)?.actions.fire, true, "device should hold fire while connected");

  gatt.connected = false;
  device.dispatchEvent(new Event("gattserverdisconnected"));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(frames.at(-1)?.actions, {}, "an out-of-range device must not leave fire held");
  assert.deepEqual(frames.at(-1)?.axes, {}, "an out-of-range device must not leave steer latched");
  assert.equal(statuses.at(-1), false, "capability status must report the drop");

  characteristic.notify([1, 255]);
  assert.deepEqual(frames.at(-1)?.actions, {}, "a detached characteristic must not resume emitting");
  await adapter.stop();
});
