import assert from "node:assert/strict";
import test from "node:test";
import { answerClockProbe, sessionInputNow } from "./desktop-clock.ts";
import type { ControlMessage } from "@101/protocol";

test("desktop probe exposes two source-clock timestamps only for selected role", () => {
  const sent: ControlMessage[] = [];
  const stamps = [2002, 2003];
  answerClockProbe({ type: "ping", sentAt: 1000, deviceId: "phone" }, "desktop-control", "phone",
    () => stamps.shift()!, message => sent.push(message));
  assert.deepEqual(sent, [{ type: "pong", sentAt: 1000, receivedAt: 2002 }, { type: "ping", sentAt: 2003 }]);
  sent.length = 0;
  answerClockProbe({ type: "ping", sentAt: 1000, deviceId: "phone" }, "game", "phone", () => 2002,
    message => sent.push(message));
  assert.deepEqual(sent, [{ type: "pong", sentAt: 1000, receivedAt: 2002 }]);
});

test("desktop probe and frames share monotonic time across a forward wall-clock jump", () => {
  const sent: ControlMessage[] = [];
  let wall = 1000, monotonic = 200;
  const sourceNow = () => sessionInputNow("desktop-control", () => wall, () => monotonic);
  answerClockProbe({ type: "ping", sentAt: 100, deviceId: "phone" }, "desktop-control", "phone",
    sourceNow, message => sent.push(message));
  wall += 10_000;
  monotonic += 20;
  const frameTimestamp = sourceNow();
  assert.deepEqual(sent, [{ type: "pong", sentAt: 100, receivedAt: 200 }, { type: "ping", sentAt: 200 }]);
  assert.equal(frameTimestamp, 220);
  assert.equal(sessionInputNow("ordinary-game", () => wall, () => monotonic), 11_000);
});
