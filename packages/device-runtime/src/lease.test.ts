import assert from "node:assert/strict";
import test from "node:test";
import { LeaseBook } from "./lease.ts";

test("an exclusive lease expires and cannot be renewed by another owner", () => {
  const leases = new LeaseBook();
  assert.equal(leases.claim("pointer", "one", 100, 0), true);
  assert.equal(leases.claim("pointer", "two", 100, 0), false);
  assert.equal(leases.renew("pointer", "two", 200, 50), false);
  assert.equal(leases.renew("pointer", "one", 200, 100), false);
  assert.equal(leases.claim("pointer", "two", 200, 100), true);
  assert.equal(leases.release("pointer", "one"), false);
  assert.equal(leases.release("pointer", "two"), true);
});

test("partitions have independent keys and releasing ownership is idempotent", () => {
  const leases = new LeaseBook();
  assert.equal(leases.claim("surface:left", "one", 100, 0), true);
  assert.equal(leases.claim("surface:right", "two", 100, 0), true);
  assert.equal(leases.release("surface:left", "one"), true);
  assert.equal(leases.release("surface:left", "one"), false);
  leases.clear();
  assert.equal(leases.claim("surface:right", "three", 100, 0), true);
});
