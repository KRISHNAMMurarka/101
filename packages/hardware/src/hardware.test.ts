import assert from "node:assert/strict";
import test from "node:test";
import { DelimitedByteFramer, FixedLengthByteFramer, HardwareFrameEmitter, createHardwareDecoder } from "./index.ts";

test("declarative binary mappings normalize actions, axes, and vectors", () => {
  const decoder = createHardwareDecoder({ reportId: 7, controls: [
    { kind: "axis", name: "steer", offset: 0, valueType: "u8", inputCenter: 128, deadZone: .05 },
    { kind: "action", name: "fire", offset: 1, valueType: "u8", threshold: 1 },
    { kind: "vector", name: "aim", component: "x", offset: 2, valueType: "i16", inputMin: -1000, inputCenter: 0, inputMax: 1000 },
    { kind: "vector", name: "aim", component: "y", offset: 4, valueType: "i16", inputMin: -1000, inputCenter: 0, inputMax: 1000, invert: true },
  ] });
  const bytes = new Uint8Array(6);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 255); view.setUint8(1, 1); view.setInt16(2, 500, true); view.setInt16(4, -250, true);
  const state = decoder({ bytes, reportId: 7, timestamp: 1 })!;
  assert.equal(state.actions.fire, true);
  assert.equal(state.axes.steer, 1);
  assert.deepEqual(state.vectors.aim, { x: .5, y: .25 });
  assert.equal(decoder({ bytes, reportId: 8, timestamp: 2 }), undefined);
});

test("serial framers retain split packets without unbounded buffering", () => {
  const delimited = new DelimitedByteFramer();
  assert.deepEqual(delimited.push(new Uint8Array([1, 2])), []);
  assert.deepEqual(delimited.push(new Uint8Array([3, 10, 4, 10])).map((bytes) => Array.from(bytes)), [[1, 2, 3], [4]]);
  const fixed = new FixedLengthByteFramer(3);
  assert.deepEqual(fixed.push(new Uint8Array([1, 2, 3, 4, 5, 6, 7])).map((bytes) => Array.from(bytes)), [[1, 2, 3], [4, 5, 6]]);
  assert.deepEqual(fixed.push(new Uint8Array([8, 9])).map((bytes) => Array.from(bytes)), [[7, 8, 9]]);
});

test("hardware frame emitter preserves stable identity and releases state", () => {
  const emitter = new HardwareFrameEmitter("custom-board", "player-2", "hid", createHardwareDecoder({ controls: [{ kind: "action", name: "trigger", offset: 0, valueType: "u8", threshold: 1 }] }));
  const frame = emitter.decode({ bytes: new Uint8Array([1]), timestamp: 10 })!;
  assert.equal(frame.sequence, 1);
  assert.equal(frame.playerId, "player-2");
  assert.equal(frame.actions.trigger, true);
  assert.equal(emitter.release(11).sequence, 2);
});
