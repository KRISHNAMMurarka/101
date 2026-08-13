import assert from "node:assert/strict";
import test from "node:test";
import { FixedLengthByteFramer } from "@101/hardware";
import { WebSerialAdapter, type SerialManager101, type SerialPort101 } from "./index.ts";

class FakeSerialPort implements SerialPort101 {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  controller?: ReadableStreamDefaultController<Uint8Array>;
  writes: number[][] = [];
  getInfo() { return { usbVendorId: 0x101, usbProductId: 0x303 }; }
  async open() {
    this.readable = new ReadableStream({ start: (controller) => { this.controller = controller; } });
    this.writable = new WritableStream({ write: (bytes) => { this.writes.push(Array.from(bytes)); } });
  }
  async close() { this.readable = null; this.writable = null; }
  push(bytes: number[]) { this.controller?.enqueue(Uint8Array.from(bytes)); }
  fail(error: Error) { this.controller?.error(error); }
  finish() { this.controller?.close(); }
}

test("Web Serial keeps chooser permission explicit and frames split input", async () => {
  const port = new FakeSerialPort();
  let prompts = 0;
  const manager: SerialManager101 = { async getPorts() { return []; }, async requestPort() { prompts += 1; return port; } };
  const frames: Array<{ actions: Record<string, boolean | number> }> = [];
  const adapter = new WebSerialAdapter({ manager, open: { baudRate: 115200 }, framer: new FixedLengthByteFramer(2), mapping: { controls: [{ kind: "action", name: "buttonA", offset: 0, valueType: "u8", threshold: 1 }] } });
  await adapter.start((frame) => frames.push(frame));
  assert.equal(prompts, 0);
  await adapter.requestPort();
  port.push([1]); port.push([9]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(frames.at(-1)?.actions.buttonA, true);
  await adapter.write(new Uint8Array([7, 8]));
  assert.deepEqual(port.writes, [[7, 8]]);
  await adapter.stop();
});

test("Web Serial releases held input when the cable is pulled", async () => {
  const port = new FakeSerialPort();
  const manager: SerialManager101 = { async getPorts() { return []; }, async requestPort() { return port; } };
  const frames: Array<{ actions: Record<string, boolean | number> }> = [];
  const statuses: boolean[] = [];
  const adapter = new WebSerialAdapter({
    manager, open: { baudRate: 115200 }, framer: new FixedLengthByteFramer(2),
    onStatus: (status) => statuses.push(status.connected),
    mapping: { controls: [{ kind: "action", name: "buttonA", offset: 0, valueType: "u8", threshold: 1 }] },
  });
  await adapter.start((frame) => frames.push(frame));
  await adapter.requestPort();
  port.push([1, 0]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(frames.at(-1)?.actions.buttonA, true, "device should hold buttonA while connected");

  port.fail(new Error("The device has been lost."));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(frames.at(-1)?.actions, {}, "an unplugged device must not leave buttonA held");
  assert.equal(statuses.at(-1), false, "capability status must report the drop");
  await adapter.stop();
});

test("Web Serial releases held input when the stream closes cleanly", async () => {
  const port = new FakeSerialPort();
  const manager: SerialManager101 = { async getPorts() { return []; }, async requestPort() { return port; } };
  const frames: Array<{ actions: Record<string, boolean | number> }> = [];
  const adapter = new WebSerialAdapter({ manager, open: { baudRate: 115200 }, framer: new FixedLengthByteFramer(2), mapping: { controls: [{ kind: "action", name: "buttonA", offset: 0, valueType: "u8", threshold: 1 }] } });
  await adapter.start((frame) => frames.push(frame));
  await adapter.requestPort();
  port.push([1, 0]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(frames.at(-1)?.actions.buttonA, true);

  port.finish();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(frames.at(-1)?.actions, {}, "a closed stream must not leave buttonA held");
  await adapter.stop();
});
