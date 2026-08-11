import assert from "node:assert/strict";
import test from "node:test";
import { NetworkDiagnostics } from "./index.ts";

test("measures round trip jitter and dropped realtime sequences", () => {
  const diagnostics = new NetworkDiagnostics();
  diagnostics.sentPing();
  diagnostics.observeRoundTrip(8);
  diagnostics.observeRoundTrip(12);
  diagnostics.observeFrame({ deviceId: "phone-1", sequence: 10 });
  diagnostics.observeFrame({ deviceId: "phone-1", sequence: 13 });

  assert.deepEqual(diagnostics.snapshot(), {
    roundTripMs: 10,
    jitterMs: 4,
    droppedPercent: 50,
    receivedPackets: 2,
    sentPings: 1,
  });
});
