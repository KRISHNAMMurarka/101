import assert from "node:assert/strict";
import test from "node:test";
import { WebHIDAdapter, type HIDDevice101, type HIDInputReportEvent101, type HIDManager101 } from "./index.ts";

class FakeHIDDevice extends EventTarget implements HIDDevice101 {
  opened = false; vendorId = 0x101; productId = 0x202; productName = "101 Wand"; sent: number[] = [];
  async open() { this.opened = true; }
  async close() { this.opened = false; }
  async sendReport(reportId: number) { this.sent.push(reportId); }
  report(bytes: number[]) { this.dispatchEvent(Object.assign(new Event("inputreport"), { device: this, reportId: 1, data: new DataView(Uint8Array.from(bytes).buffer) } satisfies HIDInputReportEvent101)); }
}

test("WebHID keeps chooser permission explicit and emits mapped reports", async () => {
  const device = new FakeHIDDevice();
  let prompts = 0;
  const manager: HIDManager101 = { async getDevices() { return []; }, async requestDevice() { prompts += 1; return [device]; } };
  const frames: Array<{ actions: Record<string, boolean | number> }> = [];
  const adapter = new WebHIDAdapter({ manager, filters: [{ vendorId: 0x101 }], mapping: { reportId: 1, controls: [{ kind: "action", name: "trigger", offset: 0, valueType: "u8", threshold: 1 }] } });
  await adapter.start((frame) => frames.push(frame));
  assert.equal(prompts, 0);
  await adapter.requestDevice();
  assert.equal(prompts, 1);
  device.report([1]);
  assert.equal(frames.at(-1)?.actions.trigger, true);
  await adapter.sendReport(2, new Uint8Array([7]));
  assert.deepEqual(device.sent, [2]);
  await adapter.stop();
  assert.equal(device.opened, false);
});

test("WebHID releases held input when the device is unplugged", async () => {
  const device = new FakeHIDDevice();
  const manager = Object.assign(new EventTarget(), { async getDevices() { return []; }, async requestDevice() { return [device]; } }) satisfies HIDManager101;
  const frames: Array<{ actions: Record<string, boolean | number> }> = [];
  const statuses: boolean[] = [];
  const adapter = new WebHIDAdapter({
    manager, filters: [{ vendorId: 0x101 }],
    onStatus: (status) => statuses.push(status.connected),
    mapping: { reportId: 1, controls: [{ kind: "action", name: "trigger", offset: 0, valueType: "u8", threshold: 1 }] },
  });
  await adapter.start((frame) => frames.push(frame));
  await adapter.requestDevice();
  device.report([1]);
  assert.equal(frames.at(-1)?.actions.trigger, true, "device should hold trigger while connected");

  device.opened = false;
  manager.dispatchEvent(Object.assign(new Event("disconnect"), { device }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(frames.at(-1)?.actions, {}, "an unplugged device must not leave trigger held");
  assert.equal(statuses.at(-1), false, "capability status must report the drop");

  device.report([1]);
  assert.deepEqual(frames.at(-1)?.actions, {}, "a detached device must not resume emitting");
  await adapter.stop();
});
