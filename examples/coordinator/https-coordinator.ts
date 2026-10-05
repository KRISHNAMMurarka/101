import { createCoordinatorFetcher, createHttpsCoordinator, type HttpsCoordinatorOptions } from "@101/hub-server";
import { createHttpSignalingSession, HttpControllerSignalingClient, HttpHostSignalingClient } from "@101/pairing";

export interface CoordinatorExampleOptions {
  coordinator: HttpsCoordinatorOptions;
  origin: string;
  host: { certificatePem: string; privateKeyPem: string };
  peer: { certificatePem: string; privateKeyPem: string; deviceId: string };
}
/**
 * Actual local HTTPS rendezvous through public APIs and provisioned Node mTLS clients.
 * The bounded synthetic offer/answer demonstrates private signaling; it is not a WebRTC/media session.
 * Caller supplies explicit credentials. There is no default account, persistent authority or resource grant.
 */
export async function runHttpsCoordinatorExample(options: CoordinatorExampleOptions) {
  const coordinator = createHttpsCoordinator(options.coordinator);
  const endpoint = await coordinator.start();
  const callers: ReturnType<typeof createCoordinatorFetcher>[] = [];
  try {
    const hostCaller = createCoordinatorFetcher({ endpoint, origin: options.origin, caCertificatePem: options.coordinator.clientCaCertificatePem, certificatePem: options.host.certificatePem, privateKeyPem: options.host.privateKeyPem });
    callers.push(hostCaller);
    const peerCaller = createCoordinatorFetcher({ endpoint, origin: options.origin, caCertificatePem: options.coordinator.clientCaCertificatePem, certificatePem: options.peer.certificatePem, privateKeyPem: options.peer.privateKeyPem });
    callers.push(peerCaller);
    const created = await createHttpSignalingSession(endpoint, "LOCAL-HTTPS-101", { ttlMs: 60_000, hostName: "Local coordinator caller", fetcher: hostCaller.fetch });
    const host = new HttpHostSignalingClient(endpoint, created.ticket.sessionId, created.hostToken, hostCaller.fetch);
    const peer = new HttpControllerSignalingClient(created.ticket, peerCaller.fetch);
    const lease = await peer.join({ deviceId: options.peer.deviceId, label: "Enrolled local peer", capabilities: {} });
    await host.publishOffer(lease.peerId, lease.generation, "101-local-example-offer");
    if ((await peer.getOffer(lease)).offer !== "101-local-example-offer") throw new Error("Private offer was not retained");
    await peer.publishAnswer(lease, lease.generation, "101-local-example-answer");
    const peers = await host.listPeers();
    if (peers.length !== 1 || peers[0]?.deviceId !== options.peer.deviceId || peers[0]?.answer !== "101-local-example-answer") throw new Error("Private answer was not retained");
    const resumed = await createHttpSignalingSession(endpoint, created.ticket.sessionId, { hostToken: created.hostToken, fetcher: hostCaller.fetch });
    if (resumed.hostToken === created.hostToken) throw new Error("Host bearer was not rotated");
    await peer.leave(lease);
    const resumedHost = new HttpHostSignalingClient(endpoint, resumed.ticket.sessionId, resumed.hostToken, hostCaller.fetch);
    if ((await resumedHost.listPeers()).length !== 0) throw new Error("Departed peer remained visible");
    return { profile: "provisioned-loopback-node-mtls/1", levels: ["authenticated-create", "authenticated-join", "private-rendezvous", "host-bearer-rotation", "peer-removal"], signalingOnly: true } as const;
  } finally {
    callers.forEach((caller) => caller.close());
    await coordinator.stop();
  }
}
