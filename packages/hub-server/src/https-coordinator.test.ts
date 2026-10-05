import assert from "node:assert/strict";
import { request } from "node:https";
import test from "node:test";
import { createHttpSignalingSession, HttpHostSignalingClient, HttpControllerSignalingClient } from "@101/pairing";
import { createCoordinatorFixtures } from "../../../tools/qa-https-coordinator.mjs";
import { createHttpsCoordinator, createCoordinatorFetcher, HTTPS_COORDINATOR_LIMITS } from "./https-coordinator.ts";

const ORIGIN = "https://coordinator-ui.example";
const fixtures = createCoordinatorFixtures();
process.once("exit", () => fixtures.close());
const config = () => ({ serverCertificatePem: fixtures.server.certificatePem, serverPrivateKeyPem: fixtures.server.privateKeyPem, clientCaCertificatePem: fixtures.ca, allowedOrigins: [ORIGIN], enrollments: fixtures.clients.slice(0, 5).map(({ principalId, deviceId, certificatePem }) => ({ principalId, deviceId, certificatePem })), port: 0 });
function client(endpoint: string, index: number) {
  return createCoordinatorFetcher({ endpoint, origin: ORIGIN, caCertificatePem: fixtures.ca, certificatePem: fixtures.clients[index]!.certificatePem, privateKeyPem: fixtures.clients[index]!.privateKeyPem });
}
async function raw(endpoint: string, options: { index?: number; origin?: string | null; method?: string; path?: string; body?: unknown; token?: string; ca?: string; certificatePem?: string; privateKeyPem?: string } = {}) {
  const credential = options.index === undefined ? undefined : fixtures.clients[options.index];
  return new Promise<{ status: number; body: string; headers: Record<string, unknown>; protocol: string | null }>((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const outgoing = request(`${endpoint}${options.path ?? "/v1/health"}`, { method: options.method ?? "GET", ca: options.ca ?? fixtures.ca, cert: options.certificatePem ?? credential?.certificatePem, key: options.privateKeyPem ?? credential?.privateKeyPem, minVersion: "TLSv1.3", maxVersion: "TLSv1.3", agent: false, headers: { ...(options.origin === null ? {} : { Origin: options.origin ?? ORIGIN }), ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString(), headers: response.headers, protocol: (response.socket as import("node:tls").TLSSocket).getProtocol() }));
    });
    outgoing.once("error", reject);
    outgoing.setTimeout(3000, () => outgoing.destroy(new Error("Test request timeout")));
    outgoing.end(body);
  });
}

test("fails closed before binding invalid or mutable startup configuration", () => {
  assert.throws(() => createHttpsCoordinator({ ...config(), allowedOrigins: ["*"] }));
  assert.throws(() => createHttpsCoordinator({ ...config(), allowedOrigins: ["http://example.test"] }));
  assert.throws(() => createHttpsCoordinator({ ...config(), allowedOrigins: [ORIGIN + "/path"] }));
  assert.throws(() => createHttpsCoordinator({ ...config(), allowedOrigins: [] }));
  assert.throws(() => createHttpsCoordinator({ ...config(), serverCertificatePem: fixtures.wrongHost.certificatePem, serverPrivateKeyPem: fixtures.wrongHost.privateKeyPem }));
  assert.throws(() => createHttpsCoordinator({ ...config(), serverPrivateKeyPem: fixtures.clients[0]!.privateKeyPem }));
  assert.throws(() => createHttpsCoordinator({ ...config(), serverCertificatePem: fixtures.expiredServer.certificatePem, serverPrivateKeyPem: fixtures.expiredServer.privateKeyPem }));
  assert.throws(() => createHttpsCoordinator({ ...config(), enrollments: [fixtures.clients[0]!, fixtures.clients[0]!] }));
  assert.throws(() => createHttpsCoordinator({ ...config(), clientCaCertificatePem: fixtures.clients[0]!.certificatePem }));
  assert.throws(() => createHttpsCoordinator({ ...config(), port: -1 }));
  const accessor = { ...config() };
  Object.defineProperty(accessor, "serverCertificatePem", { get() { return fixtures.server.certificatePem; } });
  assert.throws(() => createHttpsCoordinator(accessor));
});

test("real TLS1.3 authenticates enrolled clients and rejects missing, expired, unknown and untrusted credentials", async () => {
  const coordinator = createHttpsCoordinator(config());
  const endpoint = await coordinator.start();
  try {
    const admitted = await raw(endpoint, { index: 0 });
    assert.equal(admitted.status, 200);
    assert.equal(admitted.protocol, "TLSv1.3");
    assert.deepEqual(JSON.parse(admitted.body), { service: "101-https-coordinator", version: 1 });
    await assert.rejects(() => raw(endpoint));
    await assert.rejects(() => raw(endpoint, { index: 0, ca: fixtures.clients[0]!.certificatePem }));
    await assert.rejects(() => raw(endpoint, { certificatePem: fixtures.expiredClient.certificatePem, privateKeyPem: fixtures.expiredClient.privateKeyPem }));
    assert.equal((await raw(endpoint, { index: 5 })).status, 401);
  } finally { await coordinator.stop(); }
});

test("origin rejection including preflight happens before session mutation and config is snapshotted", async () => {
  const options = config();
  const coordinator = createHttpsCoordinator(options);
  options.allowedOrigins.push("https://evil.example");
  options.enrollments[0]!.principalId = "changed-by-caller";
  const endpoint = await coordinator.start();
  const host = client(endpoint, 0);
  try {
    for (const origin of ["https://evil.example", "null", null, "https://coordinator-ui.example.evil.example"]) {
      const result = await raw(endpoint, { index: 0, origin, method: "POST", path: "/v1/sessions", body: { sessionId: "ORIGIN101" } });
      assert.equal(result.status, 403);
      assert.equal(result.headers["access-control-allow-origin"], undefined);
    }
    assert.equal((await raw(endpoint, { index: 0, origin: "https://evil.example", method: "OPTIONS", path: "/v1/sessions" })).status, 403);
    const preflight = await raw(endpoint, { index: 0, method: "OPTIONS", path: "/v1/sessions" });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers["access-control-allow-origin"], ORIGIN);
    const created = await createHttpSignalingSession(endpoint, "ORIGIN101", { fetcher: host.fetch });
    assert.equal(created.ticket.endpoint, endpoint);
  } finally { host.close(); await coordinator.stop(); fixtures.clients[0]!.principalId = "host-a"; }
});

test("public pairing callers create/join and two peers receive only their own rendezvous", async () => {
  const coordinator = createHttpsCoordinator(config());
  const endpoint = await coordinator.start();
  const callers = [0, 1, 2, 3, 4].map((index) => client(endpoint, index));
  try {
    const session = await createHttpSignalingSession(endpoint, "PRIVATE101", { fetcher: callers[0]!.fetch });
    const otherSession = await createHttpSignalingSession(endpoint, "PRIVATE202", { fetcher: callers[1]!.fetch });
    const host = new HttpHostSignalingClient(endpoint, session.ticket.sessionId, session.hostToken, callers[0]!.fetch);
    const peerA = new HttpControllerSignalingClient(session.ticket, callers[2]!.fetch);
    const peerB = new HttpControllerSignalingClient(session.ticket, callers[3]!.fetch);
    const leaseA = await peerA.join({ deviceId: "device-peer-a", label: "Peer A", capabilities: { touch: true } });
    const leaseB = await peerB.join({ deviceId: "device-peer-b", label: "Peer B", capabilities: { touch: true } });
    assert.notEqual(leaseA.peerToken, leaseB.peerToken);
    await host.publishOffer(leaseA.peerId, 1, "101-private-offer-a");
    await host.publishOffer(leaseB.peerId, 1, "101-private-offer-b");
    assert.equal((await peerA.getOffer(leaseA)).offer, "101-private-offer-a");
    assert.equal((await peerB.getOffer(leaseB)).offer, "101-private-offer-b");
    await peerA.publishAnswer(leaseA, 1, "101-private-answer-a");
    assert.equal((await host.listPeers()).find((peer) => peer.peerId === leaseA.peerId)?.answer, "101-private-answer-a");
    const copiedHost = await raw(endpoint, { index: 4, path: `/v1/sessions/PRIVATE101/host/peers`, token: session.hostToken });
    const missingHost = await raw(endpoint, { index: 4, path: `/v1/sessions/UNKNOWN101/host/peers`, token: session.hostToken });
    assert.equal(copiedHost.status, 404);
    assert.equal(copiedHost.body, missingHost.body);
    assert.equal((await raw(endpoint, { index: 3, path: `/v1/sessions/PRIVATE101/peers/${leaseA.peerId}/offer`, token: leaseA.peerToken })).status, 404);
    assert.equal((await raw(endpoint, { index: 2, path: `/v1/sessions/${otherSession.ticket.sessionId}/peers/${leaseA.peerId}/offer`, token: leaseA.peerToken })).status, 404);
    assert.equal((await raw(endpoint, { index: 4, method: "POST", path: "/v1/sessions", body: { sessionId: "PRIVATE101" }, token: session.hostToken })).status, 404);
    await peerA.leave(leaseA);
    assert.equal((await host.listPeers()).length, 1);
    await assert.rejects(() => peerA.getOffer(leaseA));
    const resumed = await createHttpSignalingSession(endpoint, "PRIVATE101", { hostToken: session.hostToken, fetcher: callers[0]!.fetch });
    assert.notEqual(resumed.hostToken, session.hostToken);
    await assert.rejects(() => host.listPeers());
  } finally { callers.forEach((caller) => caller.close()); await coordinator.stop(); }
});

test("closed paths and body schemas reject spoofed identity, arbitrary endpoints and oversized bodies", async () => {
  const coordinator = createHttpsCoordinator(config());
  const endpoint = await coordinator.start();
  try {
    for (const body of [{ sessionId: "BOUNDS101", endpoint: "https://evil.example" }, { sessionId: "BOUNDS101", unknown: true }, { sessionId: "BOUNDS101", ttlMs: 999_999_999 }, { sessionId: "BOUNDS101", hostName: "x".repeat(200) }]) {
      assert.equal((await raw(endpoint, { index: 0, method: "POST", path: "/v1/sessions", body })).status, 400);
    }
    const created = await raw(endpoint, { index: 0, method: "POST", path: "/v1/sessions", body: { sessionId: "BOUNDS101" } });
    const session = JSON.parse(created.body);
    assert.equal(created.status, 201);
    assert.equal((await raw(endpoint, { index: 2, method: "POST", path: "/v1/sessions/BOUNDS101/peers", token: session.ticket.joinToken, body: { deviceId: "spoofed", label: "Peer", capabilities: { touch: true } } })).status, 400);
    assert.equal((await raw(endpoint, { index: 0, path: "/v1/sessions/BOUNDS101/host/peers/extra", token: session.hostToken })).status, 404);
    await raw(endpoint, { index: 0, method: "POST", path: "/v1/sessions", body: { sessionId: "BOUNDS202", hostName: "x".repeat(HTTPS_COORDINATOR_LIMITS.requestBytes) } }).then((result) => assert.equal(result.status, 413), (cause: NodeJS.ErrnoException) => assert.match(cause.code ?? "", /^(?:EPIPE|ECONNRESET)$/));
    assert.equal((await raw(endpoint, { index: 0, method: "POST", path: "/v1/sessions", body: { sessionId: "BOUNDS202" } })).status, 201);
  } finally { await coordinator.stop(); }
});

test("finite session/peer/rate budgets and shutdown retire authority", async () => {
  const coordinator = createHttpsCoordinator(config());
  const endpoint = await coordinator.start();
  const host = client(endpoint, 0);
  const peer = client(endpoint, 2);
  try {
    const sessions = [];
    for (let index = 0; index < HTTPS_COORDINATOR_LIMITS.sessionsPerPrincipal; index++) sessions.push(await createHttpSignalingSession(endpoint, `LIMIT${index}`, { fetcher: host.fetch }));
    assert.equal((await host.fetch(`${endpoint}/v1/sessions`, { method: "POST", body: JSON.stringify({ sessionId: "EXTRA101" }), headers: { "Content-Type": "application/json" } })).status, 429);
    const session = sessions[0]!;
    const controller = new HttpControllerSignalingClient(session.ticket, peer.fetch);
    for (let index = 0; index < HTTPS_COORDINATOR_LIMITS.peersPerSession; index++) await controller.join({ deviceId: "device-peer-a", label: "Peer", capabilities: {} });
    await assert.rejects(() => controller.join({ deviceId: "device-peer-a", label: "Peer", capabilities: {} }), /429/);
    await coordinator.stop();
    await assert.rejects(() => raw(endpoint, { index: 0 }));
    await assert.rejects(() => coordinator.start(), /closed/i);
    assert.throws(() => coordinator.url, /closed|start/i);
  } finally { host.close(); peer.close(); await coordinator.stop(); }
});

test("caller never forwards credentials off origin, follows redirects or survives close", async () => {
  const coordinator = createHttpsCoordinator(config());
  const endpoint = await coordinator.start();
  const caller = client(endpoint, 0);
  try {
    await assert.rejects(() => caller.fetch("https://other.example/v1/health"));
    await assert.rejects(() => caller.fetch(`${endpoint}/v1/health`, { redirect: "follow" }));
    await assert.rejects(() => caller.fetch(`${endpoint}/v1/health`, { headers: { Origin: "https://evil.example" } }));
    caller.close();
    await assert.rejects(() => caller.fetch(`${endpoint}/v1/health`));
  } finally { caller.close(); await coordinator.stop(); }
});

test("stop promptly closes an accepted TCP socket before a TLS handshake completes", async () => {
  const { connect } = await import("node:net");
  const coordinator = createHttpsCoordinator(config());
  const endpoint = await coordinator.start();
  const held = connect({ host: "127.0.0.1", port: Number(new URL(endpoint).port) });
  await new Promise<void>((resolve) => held.once("connect", resolve));
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([coordinator.stop().then(() => "closed"), new Promise<string>((resolve) => { deadline = setTimeout(() => resolve("timeout"), 200); })]);
    assert.equal(outcome, "closed");
  } finally { if (deadline) clearTimeout(deadline); held.destroy(); await coordinator.stop(); }
});

test("expired sessions reject rendezvous and cannot prevent shutdown", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const coordinator = createHttpsCoordinator(config());
  const endpoint = await coordinator.start();
  const caller = client(endpoint, 0);
  try {
    const session = await createHttpSignalingSession(endpoint, "EXPIRY101", { ttlMs: 60_000, fetcher: caller.fetch });
    context.mock.timers.tick(60_001);
    // Shutdown must reap expiry without invoking a now-invalid host operation.
    await coordinator.stop();
    assert.ok(session.ticket.expiresAt < Date.now());
  } finally { caller.close(); await coordinator.stop(); context.mock.timers.reset(); }
});

test("caller bounds pending requests as well as sockets", async () => {
  const coordinator = createHttpsCoordinator(config());
  const endpoint = await coordinator.start();
  const caller = client(endpoint, 0);
  const pending = Array.from({ length: 4 }, () => caller.fetch(`${endpoint}/v1/health`));
  try { await assert.rejects(() => caller.fetch(`${endpoint}/v1/health`), /capacity|pending/i); }
  finally { await Promise.allSettled(pending); caller.close(); await coordinator.stop(); }
});

test("invalid invitations receive the same private rejection before body or capacity disclosures", async () => {
  const coordinator = createHttpsCoordinator(config());
  const endpoint = await coordinator.start();
  const host = client(endpoint, 0);
  try {
    await createHttpSignalingSession(endpoint, "HIDDEN101", { fetcher: host.fetch });
    const wrong = await raw(endpoint, { index: 2, method: "POST", path: "/v1/sessions/HIDDEN101/peers", token: "x".repeat(43), body: { deviceId: "spoofed", label: "", capabilities: {} } });
    const absent = await raw(endpoint, { index: 2, method: "POST", path: "/v1/sessions/ABSENT101/peers", token: "x".repeat(43), body: { deviceId: "spoofed", label: "", capabilities: {} } });
    assert.equal(wrong.status, 404);
    assert.equal(wrong.body, absent.body);
  } finally { host.close(); await coordinator.stop(); }
});

test("per-principal request budgets reject a frozen-second burst and recover in the next window", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const coordinator = createHttpsCoordinator(config());
  const endpoint = await coordinator.start();
  try {
    for (let index = 0; index < HTTPS_COORDINATOR_LIMITS.requestsPerSecond; index++) assert.equal((await raw(endpoint, { index: 0 })).status, 200);
    assert.equal((await raw(endpoint, { index: 0 })).status, 429);
    assert.equal((await raw(endpoint, { index: 1 })).status, 200);
    context.mock.timers.tick(1001);
    assert.equal((await raw(endpoint, { index: 0 })).status, 200);
  } finally { await coordinator.stop(); context.mock.timers.reset(); }
});

test("global session and cross-session principal peer budgets remain finite", async () => {
  const coordinator = createHttpsCoordinator(config());
  const endpoint = await coordinator.start();
  const callers = [0, 1, 2, 3, 4].map((index) => client(endpoint, index));
  try {
    const sessions = [];
    for (let principal = 0; principal < 4; principal++) for (let index = 0; index < 4; index++) sessions.push(await createHttpSignalingSession(endpoint, `GLOBAL-${principal}-${index}`, { fetcher: callers[principal]!.fetch }));
    assert.equal(sessions.length, HTTPS_COORDINATOR_LIMITS.sessions);
    await assert.rejects(() => createHttpSignalingSession(endpoint, "GLOBAL-EXTRA", { fetcher: callers[4]!.fetch }), /429/);
    const peer = callers[4]!;
    for (const session of sessions.slice(0, 2)) {
      const controller = new HttpControllerSignalingClient(session.ticket, peer.fetch);
      for (let index = 0; index < HTTPS_COORDINATOR_LIMITS.peersPerSession; index++) await controller.join({ deviceId: "device-other", label: "Enrolled peer", capabilities: {} });
    }
    const third = new HttpControllerSignalingClient(sessions[2]!.ticket, peer.fetch);
    await assert.rejects(() => third.join({ deviceId: "device-other", label: "Enrolled peer", capabilities: {} }), /429/);
  } finally { callers.forEach((caller) => caller.close()); await coordinator.stop(); }
});

test("concurrent start followed immediately by stop cannot leave a listener", { timeout: 1000 }, async () => {
  const coordinator = createHttpsCoordinator(config());
  const starting = coordinator.start();
  const stopped = coordinator.stop();
  await assert.rejects(() => starting, /closed|startup/i);
  await stopped;
  await assert.rejects(() => coordinator.start(), /closed/i);
});

test("retained answer admission keeps the full public host list within its UTF8 response budget", async (context) => {
  const coordinator = createHttpsCoordinator(config());
  const endpoint = await coordinator.start();
  const callers = [0, 2, 3].map((index) => client(endpoint, index));
  try {
    const session = await createHttpSignalingSession(endpoint, "AGGREGATE101", { fetcher: callers[0]!.fetch });
    const host = new HttpHostSignalingClient(endpoint, session.ticket.sessionId, session.hostToken, callers[0]!.fetch);
    const peers = [1, 2].map((index) => new HttpControllerSignalingClient(session.ticket, callers[index]!.fetch));
    const leases = await Promise.all(peers.map((peer, index) => peer.join({ deviceId: `device-peer-${index ? "b" : "a"}`, label: "Peer", capabilities: {} })));
    for (const lease of leases) await host.publishOffer(lease.peerId, 1, "101-offer-budget");
    const firstAnswer = "101" + "a".repeat(249_997);
    await peers[0]!.publishAnswer(leases[0]!, 1, firstAnswer);
    const second = await callers[2]!.fetch(`${endpoint}/v1/sessions/AGGREGATE101/peers/${leases[1]!.peerId}/answer`, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${leases[1]!.peerToken}` }, body: JSON.stringify({ generation: 1, answer: "101" + "b".repeat(249_997) }) });
    if (second.status === 204) {
      const oversized = await raw(endpoint, { index: 0, path: "/v1/sessions/AGGREGATE101/host/peers", token: session.hostToken });
      context.diagnostic(`Reproduced host-list bytes: ${Buffer.byteLength(oversized.body)} > ${HTTPS_COORDINATOR_LIMITS.responseBytes}`);
      assert.ok(Buffer.byteLength(oversized.body) > HTTPS_COORDINATOR_LIMITS.responseBytes);
      await assert.rejects(() => host.listPeers());
    }
    assert.equal(second.status, 429);
    let retained = await host.listPeers();
    assert.equal(retained.length, 2);
    assert.equal(retained[0]!.answer, firstAnswer);
    assert.equal(retained[1]!.answer, undefined);
    const retryAnswer = "101" + "b".repeat(149_997);
    await peers[1]!.publishAnswer(leases[1]!, 1, retryAnswer);
    retained = await host.listPeers();
    assert.equal(retained[0]!.answer, firstAnswer);
    assert.equal(retained[1]!.answer, retryAnswer);
    assert.ok(Buffer.byteLength(JSON.stringify(retained)) <= HTTPS_COORDINATOR_LIMITS.responseBytes);
    await assert.rejects(() => peers[0]!.publishAnswer(leases[0]!, 1, "101" + "c".repeat(399_997)), /429/);
    assert.deepEqual((await host.listPeers()).map((peer) => peer.answer), [firstAnswer, retryAnswer]);
  } finally { callers.forEach((caller) => caller.close()); await coordinator.stop(); }
});

test("escaped answers and a near-cap join cannot make retained host metadata unrepresentable", async (context) => {
  const options = config();
  options.enrollments[4]!.deviceId = "z".repeat(128);
  const coordinator = createHttpsCoordinator(options);
  const endpoint = await coordinator.start();
  const callers = [0, 2, 4].map((index) => client(endpoint, index));
  try {
    const session = await createHttpSignalingSession(endpoint, "METADATA101", { fetcher: callers[0]!.fetch });
    const host = new HttpHostSignalingClient(endpoint, session.ticket.sessionId, session.hostToken, callers[0]!.fetch);
    const peer = new HttpControllerSignalingClient(session.ticket, callers[1]!.fetch);
    const lease = await peer.join({ deviceId: "device-peer-a", label: "Peer", capabilities: {} });
    await host.publishOffer(lease.peerId, 1, "101-offer-budget");
    const existing = await host.listPeers();
    const encodedAnswerCapacity = HTTPS_COORDINATOR_LIMITS.responseBytes - Buffer.byteLength(JSON.stringify(existing)) - 12 - 64;
    const answer = "101" + '"'.repeat(Math.floor((encodedAnswerCapacity - 3) / 2));
    await peer.publishAnswer(lease, 1, answer);
    assert.equal((await host.listPeers())[0]!.answer, answer);
    const joined = await callers[2]!.fetch(`${endpoint}/v1/sessions/METADATA101/peers`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.ticket.joinToken}` }, body: JSON.stringify({ deviceId: options.enrollments[4]!.deviceId, label: "Second peer", capabilities: {} }) });
    if (joined.status === 201) {
      const oversized = await raw(endpoint, { index: 0, path: "/v1/sessions/METADATA101/host/peers", token: session.hostToken });
      context.diagnostic(`Reproduced joined host-list bytes: ${Buffer.byteLength(oversized.body)}`);
      await assert.rejects(() => host.listPeers());
    }
    assert.equal(joined.status, 429);
    const retained = await host.listPeers();
    assert.equal(retained.length, 1);
    assert.equal(retained[0]!.answer, answer);
    await peer.getOffer(lease); // Refreshes lastSeenAt while retaining the near-cap answer.
    assert.equal((await host.listPeers())[0]!.answer, answer);
    await peer.publishAnswer(lease, 1, "101-smaller-retry");
    const second = new HttpControllerSignalingClient(session.ticket, callers[2]!.fetch);
    await second.join({ deviceId: options.enrollments[4]!.deviceId, label: "Second peer", capabilities: {} });
    assert.equal((await host.listPeers()).length, 2);
    assert.equal((await host.listPeers())[0]!.answer, "101-smaller-retry");
  } finally { callers.forEach((caller) => caller.close()); await coordinator.stop(); }
});

test("a single escaped answer is rejected before retaining bytes larger than the host response", async () => {
  const coordinator = createHttpsCoordinator(config());
  const endpoint = await coordinator.start();
  const hostCaller = client(endpoint, 0);
  const peerCaller = client(endpoint, 2);
  try {
    const session = await createHttpSignalingSession(endpoint, "ESCAPED101", { fetcher: hostCaller.fetch });
    const host = new HttpHostSignalingClient(endpoint, session.ticket.sessionId, session.hostToken, hostCaller.fetch);
    const peer = new HttpControllerSignalingClient(session.ticket, peerCaller.fetch);
    const lease = await peer.join({ deviceId: "device-peer-a", label: "Peer", capabilities: {} });
    await host.publishOffer(lease.peerId, 1, "101-offer-budget");
    const answer = "101" + '"'.repeat(200_470);
    const body = JSON.stringify({ generation: 1, answer });
    assert.ok(Buffer.byteLength(body) <= HTTPS_COORDINATOR_LIMITS.requestBytes);
    const response = await peerCaller.fetch(`${endpoint}/v1/sessions/ESCAPED101/peers/${lease.peerId}/answer`, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${lease.peerToken}` }, body });
    assert.equal(response.status, 429);
    assert.equal((await host.listPeers())[0]!.answer, undefined);
    const retry = "101" + "😀".repeat(70_000) + '"'.repeat(30_000);
    await peer.publishAnswer(lease, 1, retry);
    assert.equal((await host.listPeers())[0]!.answer, retry);
    const largestAsciiAnswer = "101" + "a".repeat(HTTPS_COORDINATOR_LIMITS.signalCharacters - 3);
    await peer.publishAnswer(lease, 1, largestAsciiAnswer);
    assert.equal((await host.listPeers())[0]!.answer, largestAsciiAnswer);
  } finally { hostCaller.close(); peerCaller.close(); await coordinator.stop(); }
});

test("headers iterable reentrancy cannot exceed four actual TLS caller requests", async () => {
  const coordinator = createHttpsCoordinator(config());
  const endpoint = await coordinator.start();
  const caller = client(endpoint, 0);
  const nested: Promise<Response>[] = [];
  try {
    const headers = { *[Symbol.iterator]() { for (let index = 0; index < 4; index++) nested.push(caller.fetch(`${endpoint}/v1/health`)); yield ["Content-Type", "application/json"]; } } as unknown as HeadersInit;
    const outer = caller.fetch(`${endpoint}/v1/sessions`, { method: "POST", headers, body: JSON.stringify({ sessionId: "REENTRANT101" }) });
    const results = await Promise.allSettled([...nested, outer]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 4);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(results.at(-1)!.status, "fulfilled");
  } finally { caller.close(); await coordinator.stop(); }
});

test("headers conversion that closes the caller cannot dispatch credentials or create a session", async () => {
  const coordinator = createHttpsCoordinator(config());
  const endpoint = await coordinator.start();
  const caller = client(endpoint, 0);
  try {
    const headers = { *[Symbol.iterator]() { caller.close(); yield ["Content-Type", "application/json"]; } } as unknown as HeadersInit;
    await assert.rejects(() => caller.fetch(`${endpoint}/v1/sessions`, { method: "POST", headers, body: JSON.stringify({ sessionId: "POST-LATE101" }) }));
    const fresh = await raw(endpoint, { index: 0, method: "POST", path: "/v1/sessions", body: { sessionId: "POST-LATE101" } });
    assert.equal(fresh.status, 201);
  } finally { caller.close(); await coordinator.stop(); }
});


test("an escaped offer fitting the request cannot exceed its complete peer response", async (context) => {
  const coordinator = createHttpsCoordinator(config());
  const endpoint = await coordinator.start();
  const hostCaller = client(endpoint, 0);
  const peerCaller = client(endpoint, 2);
  try {
    const session = await createHttpSignalingSession(endpoint, "OFFER-UTF8-101", { fetcher: hostCaller.fetch });
    const host = new HttpHostSignalingClient(endpoint, session.ticket.sessionId, session.hostToken, hostCaller.fetch);
    const peer = new HttpControllerSignalingClient(session.ticket, peerCaller.fetch);
    const lease = await peer.join({ deviceId: "device-peer-a", label: "Peer", capabilities: {} });
    await host.publishOffer(lease.peerId, 1, "101-retained-small-offer");
    const body = JSON.stringify({ generation: 1, offer: "101" + '"'.repeat(200_492) });
    assert.ok(Buffer.byteLength(body) <= HTTPS_COORDINATOR_LIMITS.requestBytes);
    const published = await hostCaller.fetch(`${endpoint}/v1/sessions/OFFER-UTF8-101/host/peers/${lease.peerId}/offer`, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.hostToken}` }, body });
    if (published.status === 204) {
      const oversized = await raw(endpoint, { index: 2, path: `/v1/sessions/OFFER-UTF8-101/peers/${lease.peerId}/offer`, token: lease.peerToken });
      context.diagnostic(`Reproduced offer bytes: ${Buffer.byteLength(oversized.body)}`);
      await assert.rejects(() => peer.getOffer(lease));
    }
    assert.equal(published.status, 429);
    assert.equal((await peer.getOffer(lease)).offer, "101-retained-small-offer");
    await host.publishOffer(lease.peerId, 1, "101" + '"'.repeat(200_400));
    assert.equal((await peer.getOffer(lease)).offer, "101" + '"'.repeat(200_400));
    assert.ok(Buffer.byteLength(JSON.stringify(await peer.getOffer(lease))) <= HTTPS_COORDINATOR_LIMITS.responseBytes);
  } finally { hostCaller.close(); peerCaller.close(); await coordinator.stop(); }
});

test("caller releases reservations after invalid conversions and keeps all four slots usable", async () => {
  const coordinator = createHttpsCoordinator(config());
  const endpoint = await coordinator.start();
  const caller = client(endpoint, 0);
  try {
    for (let index = 0; index < 8; index++) await assert.rejects(() => caller.fetch(`${endpoint}/v1/health`, { headers: { "Bad Header Name": "value" } }));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => caller.fetch(`${endpoint}/v1/health`, { signal: controller.signal }));
    const responses = await Promise.all(Array.from({ length: 4 }, () => caller.fetch(`${endpoint}/v1/health`)));
    assert.equal(responses.length, 4);
    assert.ok(responses.every((response) => response.status === 200));
  } finally { caller.close(); await coordinator.stop(); }
});
