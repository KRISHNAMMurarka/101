import assert from "node:assert/strict";
import test from "node:test";
import { LatestSlot, OperationQueue } from "./scheduler.ts";

test("latest sample holds one value and discards stale data", () => {
  const latest = new LatestSlot<number>();
  for (let value = 0; value < 1000; value++) latest.offer(value, 10);
  assert.equal(latest.size, 1);
  assert.equal(latest.take(20, 20), 999);
  assert.equal(latest.size, 0);
  latest.offer(42, 10);
  assert.equal(latest.take(31, 20), undefined);
});

test("reliable queue bounds active work and preserves duplicate deadlines", () => {
  const queue = new OperationQueue<string>(2);
  assert.equal(queue.admit("1", 100, "on", 0).ok, true);
  assert.equal(queue.admit("1", 200, "off", 0).ok, false);
  assert.equal(queue.admit("2", 100, "off", 0).ok, true);
  assert.equal(queue.next(1)?.value, "on");
  assert.equal(queue.admit("3", 100, "on", 1).ok, false);
  queue.settle("1", "observed");
  assert.equal(queue.records()[0].state, "observed");
  queue.clear();
  assert.equal(queue.pending, 0);
});

test("expired identities cannot be replayed by extending their deadline", () => {
  const queue = new OperationQueue<string>(2);
  queue.admit("1", 10, "on", 0);
  assert.equal(queue.next(10), undefined);
  assert.equal(queue.records()[0].state, "expired");
  queue.purge(2000);
  assert.equal(queue.admit("1", 3000, "on", 2000).ok, false);
  assert.equal(queue.admit("2", 3000, "off", 2000).ok, true);
  assert.equal(queue.admit("3", 2000, "on", 2000).ok, false);
});

test("operation evidence never regresses and bounded history expires", () => {
  const queue = new OperationQueue<boolean>(1);
  queue.admit("1", 100, true, 0);
  queue.next(0);
  queue.settle("1", "observed");
  queue.evidence("1", "dispatched");
  assert.equal(queue.records()[0].state, "observed");
  queue.purge(1101);
  assert.equal(queue.records().length, 0);
  assert.equal(queue.admit("2", 1200, false, 1101).ok, true);
});

test("settled evidence yields capacity to new events without allowing replay", () => {
  const queue = new OperationQueue<string>(2);
  assert.equal(queue.admit("1", 1000, "first", 0).ok, true);
  assert.equal(queue.next(0)?.value, "first");
  queue.settle("1", "observed");
  assert.equal(queue.admit("2", 1000, "second", 1).ok, true);
  assert.equal(queue.next(1)?.value, "second");
  queue.settle("2", "observed");
  assert.equal(queue.pending, 0);
  assert.equal(queue.admit("3", 1000, "third", 2).ok, true);
  assert.deepEqual(queue.records().map(record => record.id), ["2", "3"]);
  assert.deepEqual(queue.admit("1", 1000, "replay", 2), { ok: false, reason: "stale-operation" });
});

test("pinned evidence cannot be retired to admit another event", () => {
  const queue = new OperationQueue<string>(1);
  assert.equal(queue.admit("1", 1000, "first", 0).ok, true);
  queue.next(0);
  queue.pin("1");
  queue.settle("1", "observed");
  assert.deepEqual(queue.admit("2", 1000, "second", 1), { ok: false, reason: "capacity" });
  queue.unpin("1", 1);
  assert.equal(queue.admit("2", 1000, "second", 1).ok, true);
});
