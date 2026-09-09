import assert from "node:assert/strict";
import test from "node:test";
import { resolveControllerRoute } from "./controller-route.ts";

test("an offline controller joins the requested room instead of its cached shell's room", () => {
  assert.deepEqual(resolveControllerRoute({ session: "101LAB" }, "?session=OTHER"), {
    session: "OTHER", pairCode: undefined, ready: true,
  });
});

test("the server and first hydration paint retain props without opening a transport", () => {
  assert.deepEqual(resolveControllerRoute({ session: "SERVER", pairCode: "server-ticket" }, undefined), {
    session: "SERVER", pairCode: "server-ticket", ready: false,
  });
});

test("live room names preserve the host's case, hyphens, and supported length", () => {
  const session = "host-room-1234567890";
  assert.equal(resolveControllerRoute({ session: "HOSTROOM1234" }, `?session=${session}`).session, session);
  const longest = "a".repeat(128);
  assert.equal(resolveControllerRoute({ session: "101LAB" }, `?session=${longest}`).session, longest);
});

test("live pairing authority replaces or clears cached props and is not stored in the route helper", () => {
  const cached = { session: "CACHED", pairCode: "old-ticket" };
  assert.deepEqual(resolveControllerRoute(cached, "?session=ROOM&pair=new%2Bticket"), {
    session: "ROOM", pairCode: "new+ticket", ready: true,
  });
  assert.deepEqual(resolveControllerRoute(cached, "?session=ROOM"), {
    session: "ROOM", pairCode: undefined, ready: true,
  });
  assert.deepEqual(cached, { session: "CACHED", pairCode: "old-ticket" });
});

test("an absent or invalid live room falls back without reusing cached pairing authority", () => {
  for (const search of ["", "?session=", "?session=x", "?session=bad%2Froom", `?session=${"a".repeat(129)}`]) {
    assert.deepEqual(resolveControllerRoute({ session: "CACHED", pairCode: "old-ticket" }, search), {
      session: "101LAB", pairCode: undefined, ready: true,
    });
  }
});
