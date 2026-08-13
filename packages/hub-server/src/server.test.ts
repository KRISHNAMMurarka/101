import assert from "node:assert/strict";
import test from "node:test";
import { HttpControllerSignalingClient, HttpHostSignalingClient } from "@101/pairing";
import { LocalHubServer, createRemoteHubSession } from "./index.ts";

test("serves the authenticated signaling contract over a real local HTTP socket", async () => {
  const server = new LocalHubServer({ host: "127.0.0.1", port: 0 });
  const endpoint = await server.start();
  try {
    const health = await fetch(`${endpoint}/v1/health`).then((response) => response.json()) as { service: string };
    assert.equal(health.service, "101-hub");
    const created = await createRemoteHubSession(endpoint, "HTTP101", { hostName: "Test Host" });
    const controller = new HttpControllerSignalingClient(created.ticket);
    const host = new HttpHostSignalingClient(endpoint, "HTTP101", created.hostToken);
    const lease = await controller.join({ deviceId: "phone-http", label: "HTTP Phone", capabilities: { touch: true } });
    assert.equal((await host.listPeers())[0]?.deviceId, "phone-http");
    await host.publishOffer(lease.peerId, lease.generation, "101-offer-http");
    assert.equal((await controller.getOffer(lease)).offer, "101-offer-http");
    await controller.publishAnswer(lease, lease.generation, "101-answer-http");
    assert.equal((await host.listPeers())[0]?.answer, "101-answer-http");
    await assert.rejects(() => new HttpHostSignalingClient(endpoint, "HTTP101", "x".repeat(32)).listPeers(), /401/);
  } finally {
    await server.stop();
  }
});
