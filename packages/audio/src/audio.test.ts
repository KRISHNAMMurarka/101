import assert from "node:assert/strict";
import test from "node:test";
import { toneDataUri } from "./index.ts";

test("generates a bounded offline PCM wave without an external asset", () => {
  const uri = toneDataUri({ frequency: 440, duration: .05, wave: "triangle" });
  assert.match(uri, /^data:audio\/wav;base64,/);
  const bytes = Buffer.from(uri.split(",")[1]!, "base64");
  assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(bytes.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(bytes.readUInt16LE(22), 1);
  assert.equal(bytes.readUInt32LE(24), 22_050);
  assert.ok(bytes.length > 44);
});
