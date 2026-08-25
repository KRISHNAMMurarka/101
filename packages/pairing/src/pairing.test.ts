import assert from "node:assert/strict";
import test from "node:test";
import {
  AutomaticPairingHost,
  BrokerControllerSignalingClient,
  BrokerHostSignalingClient,
  LocalSignalingBroker,
  MAX_SIGNALING_PEERS,
  MAX_SIGNALING_SESSIONS,
  SignaledLinkTransport,
  type NegotiatedLinkTransport,
} from "./index.ts";
import { MultiplexLinkTransport, type LinkState } from "@101/protocol";

test("broker separates host, join, and per-peer authorization and expires sessions", () => {
  let now = 100;
  let token = 0;
  const broker = new LocalSignalingBroker({ now: () => now, randomToken: () => `${String(++token).padStart(32, "a")}` });
  const created = broker.createSession({ sessionId: "PAIR101", endpoint: "http://127.0.0.1:10101", ttlMs: 60_000 });
  const controller = new BrokerControllerSignalingClient(broker, created.ticket);
  const host = new BrokerHostSignalingClient(broker, "PAIR101", created.hostToken);
  return controller.join({ deviceId: "phone", label: "Phone", capabilities: { touch: true } }).then(async (peer) => {
    assert.equal((await host.listPeers())[0]?.deviceId, "phone");
    await assert.rejects(() => new BrokerHostSignalingClient(broker, "PAIR101", "x".repeat(32)).listPeers(), /authorization/);
    assert.throws(() => broker.getOffer("PAIR101", peer.peerId, "x".repeat(32)), /authorization/);
    now = 60_101;
    assert.deepEqual(broker.expire(), ["PAIR101"]);
  });
});

test("broker reuses an id after its previous session expires", () => {
  let now = 1_000;
  let token = 0;
  const broker = new LocalSignalingBroker({ now: () => now, randomToken: () => `${String(++token).padEnd(32, "e")}` });
  const first = broker.createSession({ sessionId: "EXPIRE101", endpoint: "http://127.0.0.1:10101", ttlMs: 60_000 });

  now = 61_001;
  const replacement = broker.createSession({ sessionId: "EXPIRE101", endpoint: "http://127.0.0.1:10101", ttlMs: 60_000 });

  assert.notEqual(replacement.hostToken, first.hostToken);
  assert.notEqual(replacement.ticket.joinToken, first.ticket.joinToken);
});

test("broker validates session ids and bounds live sessions after expiry cleanup", () => {
  let now = 2_000;
  let token = 0;
  const broker = new LocalSignalingBroker({ now: () => now, randomToken: () => `${String(++token).padEnd(32, "s")}` });
  assert.throws(
    () => broker.createSession({ sessionId: "../not-a-session", endpoint: "http://127.0.0.1:10101" }),
    /Invalid signaling session id/,
  );
  for (let index = 0; index < MAX_SIGNALING_SESSIONS; index += 1) {
    broker.createSession({ sessionId: `SESSION-${index}`, endpoint: "http://127.0.0.1:10101", ttlMs: 60_000 });
  }
  assert.throws(
    () => broker.createSession({ sessionId: "SESSION-OVERFLOW", endpoint: "http://127.0.0.1:10101" }),
    /too many live sessions/,
  );

  now += 60_001;
  assert.doesNotThrow(() => broker.createSession({ sessionId: "SESSION-REUSED", endpoint: "http://127.0.0.1:10101" }));
});

test("broker validates and clamps session lifetime", () => {
  const now = 20_000;
  let token = 0;
  const broker = new LocalSignalingBroker({ now: () => now, randomToken: () => `${String(++token).padEnd(32, "t")}` });
  assert.throws(
    () => broker.createSession({ sessionId: "TTL-BAD", endpoint: "http://127.0.0.1:10101", ttlMs: Number.POSITIVE_INFINITY }),
    /Invalid signaling session lifetime/,
  );
  assert.throws(
    () => broker.createSession({ sessionId: "TTL-HUGE", endpoint: "http://127.0.0.1:10101", ttlMs: 1e308 }),
    /Invalid signaling session lifetime/,
  );
  const minimum = broker.createSession({ sessionId: "TTL-MIN", endpoint: "http://127.0.0.1:10101", ttlMs: 1 });
  const maximum = broker.createSession({ sessionId: "TTL-MAX", endpoint: "http://127.0.0.1:10101", ttlMs: 100_000_000 });
  assert.equal(minimum.ticket.expiresAt, now + 60_000);
  assert.equal(maximum.ticket.expiresAt, now + 24 * 60 * 60 * 1_000);
});

test("broker prunes crashed peers and allows the same controller ticket to join again", async () => {
  let now = 5_000;
  let token = 0;
  const broker = new LocalSignalingBroker({ now: () => now, randomToken: () => `${String(++token).padEnd(32, "p")}` });
  const created = broker.createSession({ sessionId: "STALE101", endpoint: "http://127.0.0.1:10101" });
  const controller = new BrokerControllerSignalingClient(broker, created.ticket);
  const host = new BrokerHostSignalingClient(broker, "STALE101", created.hostToken);
  const first = await controller.join({ deviceId: "sleepy-phone", label: "Phone", capabilities: { touch: true } });

  now += 30_001;
  assert.deepEqual(await host.listPeers(), []);
  await assert.rejects(() => controller.getOffer(first), /Unknown signaling peer/);

  const replacement = await controller.join({ deviceId: "sleepy-phone", label: "Phone", capabilities: { touch: true } });
  assert.notEqual(replacement.peerId, first.peerId);
  assert.equal((await host.listPeers()).length, 1);
});

test("broker bounds live peers and stale cleanup releases capacity", () => {
  let now = 12_000;
  let token = 0;
  const broker = new LocalSignalingBroker({ now: () => now, randomToken: () => `${String(++token).padEnd(32, "m")}` });
  const created = broker.createSession({ sessionId: "CAP101", endpoint: "http://127.0.0.1:10101" });
  const device = { deviceId: "phone", label: "Phone", capabilities: { touch: true } };
  for (let index = 0; index < MAX_SIGNALING_PEERS; index += 1) {
    broker.join(created.ticket, created.ticket.joinToken, { ...device, deviceId: `phone-${index}` });
  }
  assert.throws(
    () => broker.join(created.ticket, created.ticket.joinToken, { ...device, deviceId: "phone-overflow" }),
    /session is full/,
  );

  now += 30_001;
  assert.doesNotThrow(() => broker.join(created.ticket, created.ticket.joinToken, device));
});

test("a signaled controller rejoins after its crashed lease is pruned", async () => {
  let now = 8_000;
  let token = 0;
  const broker = new LocalSignalingBroker({ now: () => now, randomToken: () => `${String(++token).padEnd(32, "r")}` });
  const created = broker.createSession({ sessionId: "REJOIN101", endpoint: "http://127.0.0.1:10101" });
  const host = new BrokerHostSignalingClient(broker, "REJOIN101", created.hostToken);
  const transport = new SignaledLinkTransport({
    signaling: new BrokerControllerSignalingClient(broker, created.ticket),
    device: { deviceId: "returning-phone", label: "Phone", capabilities: { touch: true } },
    transportFactory: (initiator) => new FakeRtcNetwork().create(initiator),
    pollIntervalMs: 60_000,
  });

  await transport.connect();
  try {
    const originalPeer = (await host.listPeers())[0]!.peerId;
    now += 30_001;
    assert.deepEqual(await host.listPeers(), []);

    await transport.sync();
    const recoveredPeers = await host.listPeers();
    assert.equal(recoveredPeers.length, 1);
    assert.notEqual(recoveredPeers[0]!.peerId, originalPeer);
  } finally {
    await transport.disconnect();
  }
});

test("a second ticket holder cannot evict a live signaling peer by copying its device id", async () => {
  let token = 0;
  const broker = new LocalSignalingBroker({ randomToken: () => `${String(++token).padEnd(32, "s")}` });
  const created = broker.createSession({ sessionId: "ROUTE101", endpoint: "http://127.0.0.1:10101" });
  const controller = new BrokerControllerSignalingClient(broker, created.ticket);
  const host = new BrokerHostSignalingClient(broker, "ROUTE101", created.hostToken);
  const device = { deviceId: "copied-phone", label: "Phone", capabilities: { touch: true } };

  const first = await controller.join(device);
  const second = await controller.join({ ...device, label: "Impersonator" });
  const peers = await host.listPeers();
  assert.equal(peers.length, 2, "signaling identity, not a controller-provided id, owns a live peer");
  assert.notEqual(first.peerId, second.peerId);
  assert.deepEqual(peers.map((peer) => peer.deviceId), ["copied-phone", "copied-phone"]);
});

test("automatic signaling negotiates multiple WebRTC-style peers and reconnects by generation", async () => {
  let token = 0;
  const broker = new LocalSignalingBroker({ randomToken: () => `${String(++token).padStart(32, "b")}` });
  const created = broker.createSession({ sessionId: "AUTO101", endpoint: "http://127.0.0.1:10101" });
  const network = new FakeRtcNetwork();
  const multiplex = new MultiplexLinkTransport();
  await multiplex.connect();
  const host = new AutomaticPairingHost({
    signaling: new BrokerHostSignalingClient(broker, "AUTO101", created.hostToken),
    transport: multiplex,
    transportFactory: (initiator) => network.create(initiator),
    pollIntervalMs: 60_000,
  });
  const controller = new SignaledLinkTransport({
    signaling: new BrokerControllerSignalingClient(broker, created.ticket),
    device: { deviceId: "phone-1", label: "Phone 1", capabilities: { touch: true, gyroscope: true } },
    transportFactory: (initiator) => network.create(initiator),
    pollIntervalMs: 60_000,
  });
  const states: LinkState[] = [];
  controller.onStateChange((state) => states.push(state));
  await controller.connect();
  await host.start();
  await controller.sync();
  await host.sync();
  assert.equal(controller.state, "connected");
  assert.equal(multiplex.ids().length, 1);
  assert.equal(network.created.length, 2);

  network.created.find((transport) => !transport.initiator)?.fail();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await host.sync();
  await controller.sync();
  await host.sync();
  assert.equal(controller.state, "connected");
  assert.equal(multiplex.ids().length, 1);
  assert.equal(network.created.length, 4);
  assert.ok(states.includes("failed"));
  await controller.disconnect();
  assert.deepEqual(await new BrokerHostSignalingClient(broker, "AUTO101", created.hostToken).listPeers(), [],
    "a graceful controller disconnect must delete its authenticated peer lease");
  await host.stop();
});

test("a malformed controller answer cannot starve later signaling peers", async () => {
  let token = 0;
  const broker = new LocalSignalingBroker({ randomToken: () => `${String(++token).padEnd(32, "q")}` });
  const created = broker.createSession({ sessionId: "ISOLATE101", endpoint: "http://127.0.0.1:10101" });
  const hostSignaling = new BrokerHostSignalingClient(broker, "ISOLATE101", created.hostToken);
  const controllerSignaling = new BrokerControllerSignalingClient(broker, created.ticket);
  const multiplex = new MultiplexLinkTransport();
  await multiplex.connect();
  let transportId = 0;
  const host = new AutomaticPairingHost({
    signaling: hostSignaling,
    transport: multiplex,
    transportFactory: () => stubNegotiatedTransport({
      async createOfferCode() { return `101-offer-isolation-${++transportId}`; },
      async acceptAnswerCode(code) {
        if (code === "101malformed") throw new Error("Invalid 101 pairing code");
      },
    }),
    pollIntervalMs: 60_000,
  });
  const poisoned = await controllerSignaling.join({
    deviceId: "poisoned-phone",
    label: "Poisoned phone",
    capabilities: { touch: true },
  });

  await host.start();
  try {
    await controllerSignaling.publishAnswer(poisoned, poisoned.generation, "101malformed");
    const healthy = await controllerSignaling.join({
      deviceId: "healthy-phone",
      label: "Healthy phone",
      capabilities: { touch: true },
    });

    await host.sync();

    assert.match((await controllerSignaling.getOffer(healthy)).offer ?? "", /^101-offer-isolation-/,
      "one broken controller must not prevent a later peer from receiving its offer");
  } finally {
    await host.stop();
    await multiplex.disconnect();
  }
});

test("automatic host retries a failed generation reset before publishing another offer", async () => {
  let generation = 1;
  let resetAttempts = 0;
  let hubAvailable = false;
  let signalFirstReset!: () => void;
  const firstReset = new Promise<void>((resolve) => { signalFirstReset = resolve; });
  const offers: number[] = [];
  const stateListeners: Array<(state: LinkState) => void> = [];
  const multiplex = new MultiplexLinkTransport();
  await multiplex.connect();
  const host = new AutomaticPairingHost({
    signaling: {
      async listPeers() {
        return [{ peerId: "reset-peer", deviceId: "reset-phone", generation, lastSeenAt: Date.now() }];
      },
      async publishOffer(_peerId, offerGeneration) { offers.push(offerGeneration); },
      async resetPeer() {
        resetAttempts += 1;
        if (resetAttempts === 1) signalFirstReset();
        if (!hubAvailable) throw new Error("temporary reset outage");
        generation += 1;
      },
    },
    transport: multiplex,
    transportFactory: () => stubNegotiatedTransport({
      async createOfferCode() { return `101-offer-reset-${generation}`; },
      onStateChange(callback) {
        stateListeners.push(callback);
        callback("connecting");
        return () => undefined;
      },
    }),
    pollIntervalMs: 2,
  });

  await host.start();
  try {
    assert.deepEqual(offers, [1]);
    stateListeners[0]?.("failed");
    await firstReset;
    hubAvailable = true;

    for (let attempt = 0; attempt < 40 && !offers.includes(2); attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 3));
      await host.sync();
    }

    assert.ok(resetAttempts >= 2, "the failed host reset intent must survive the Hub outage");
    assert.ok(offers.includes(2), "the host must wait for a fresh generation before replacing its offer");
  } finally {
    await host.stop();
    await multiplex.disconnect();
  }
});

test("automatic host stop waits for a generation reset already in flight", async () => {
  let releaseReset!: () => void;
  const resetPending = new Promise<void>((resolve) => { releaseReset = resolve; });
  let signalResetStarted!: () => void;
  const resetStarted = new Promise<void>((resolve) => { signalResetStarted = resolve; });
  let completedResets = 0;
  const stateListeners: Array<(state: LinkState) => void> = [];
  const multiplex = new MultiplexLinkTransport();
  await multiplex.connect();
  const host = new AutomaticPairingHost({
    signaling: {
      async listPeers() {
        return [{ peerId: "stopping-reset-peer", deviceId: "stopping-reset-phone", generation: 1, lastSeenAt: Date.now() }];
      },
      async publishOffer() {},
      async resetPeer() {
        signalResetStarted();
        await resetPending;
        completedResets += 1;
      },
    },
    transport: multiplex,
    transportFactory: () => stubNegotiatedTransport({
      onStateChange(callback) {
        stateListeners.push(callback);
        callback("connecting");
        return () => undefined;
      },
    }),
    pollIntervalMs: 60_000,
  });

  await host.start();
  stateListeners[0]?.("failed");
  await resetStarted;
  let stopped = false;
  const stop = host.stop().then(() => { stopped = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const stoppedBeforeResetSettled = stopped;

  releaseReset();
  await stop;
  assert.equal(stoppedBeforeResetSettled, false,
    "stop must not resolve while an authenticated generation reset can still mutate the Hub");
  assert.equal(completedResets, 1);
  assert.deepEqual(multiplex.ids(), []);
  await multiplex.disconnect();
});

test("automatic host stop cancels a peer sync that is still listing", async () => {
  let releasePeers!: (peers: readonly [{ peerId: string; deviceId: string; generation: number; lastSeenAt: number }]) => void;
  let signalPeerQueryStarted!: () => void;
  const peerQueryStarted = new Promise<void>((resolve) => { signalPeerQueryStarted = resolve; });
  const peers = new Promise<readonly [{ peerId: string; deviceId: string; generation: number; lastSeenAt: number }]>(
    (resolve) => { releasePeers = resolve; },
  );
  let publishedOffers = 0;
  const network = new FakeRtcNetwork();
  const multiplex = new MultiplexLinkTransport();
  const host = new AutomaticPairingHost({
    signaling: {
      async listPeers() { signalPeerQueryStarted(); return peers; },
      async publishOffer() { publishedOffers += 1; },
      async resetPeer() {},
    },
    transport: multiplex,
    transportFactory: (initiator) => network.create(initiator),
    pollIntervalMs: 60_000,
  });

  const start = host.start();
  await peerQueryStarted;
  let stopped = false;
  const stop = host.stop().then(() => { stopped = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const stoppedBeforePeersResolved = stopped;

  releasePeers([{ peerId: "late-peer", deviceId: "late-phone", generation: 1, lastSeenAt: 1 }]);
  await Promise.all([start, stop]);
  const installedAfterStop = multiplex.ids();
  const publishedAfterStop = publishedOffers;
  const createdAfterStop = network.created.length;
  await host.stop();
  assert.equal(stoppedBeforePeersResolved, false,
    "stop must include any already-running sync in its teardown boundary");
  assert.deepEqual(installedAfterStop, [], "a listed peer must not be installed after stop begins");
  assert.equal(publishedAfterStop, 0, "a stopped host must not publish a late offer");
  assert.equal(createdAfterStop, 0, "cancellation after peer discovery should avoid creating WebRTC state");
});

test("controller disconnect cancels a sync that is waiting for an offer", async () => {
  let releaseOffer!: (offer: { generation: number; offer: string; expiresAt: number }) => void;
  let signalOfferQueryStarted!: () => void;
  const offerQueryStarted = new Promise<void>((resolve) => { signalOfferQueryStarted = resolve; });
  const offer = new Promise<{ generation: number; offer: string; expiresAt: number }>((resolve) => { releaseOffer = resolve; });
  let publishedAnswers = 0;
  const network = new FakeRtcNetwork();
  const remote = network.create(true);
  const offeredCode = await remote.createOfferCode();
  const transportsBeforeConnect = network.created.length;
  const controller = new SignaledLinkTransport({
    signaling: {
      async join() {
        return { peerId: "late-peer", peerToken: "t".repeat(32), sessionId: "LATE01", endpoint: "http://127.0.0.1", generation: 1, expiresAt: 9_999 };
      },
      async getOffer() { signalOfferQueryStarted(); return offer; },
      async publishAnswer() { publishedAnswers += 1; },
      async requestReconnect(lease) { return lease; },
      async leave() {},
    },
    device: { deviceId: "late-phone", label: "Phone", capabilities: { touch: true } },
    transportFactory: (initiator) => network.create(initiator),
    pollIntervalMs: 60_000,
  });

  const connect = controller.connect();
  await offerQueryStarted;
  let disconnected = false;
  const disconnect = controller.disconnect().then(() => { disconnected = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const disconnectedBeforeOfferResolved = disconnected;

  releaseOffer({ generation: 1, offer: offeredCode, expiresAt: 9_999 });
  await Promise.all([connect, disconnect]);
  const createdAfterDisconnect = network.created.length;
  const answersAfterDisconnect = publishedAnswers;
  const stateAfterDisconnect = controller.state;
  await controller.disconnect();
  assert.equal(disconnectedBeforeOfferResolved, false,
    "disconnect must wait for and cancel an in-flight offer sync");
  assert.equal(createdAfterDisconnect, transportsBeforeConnect,
    "a late offer must not construct a transport after disconnect begins");
  assert.equal(answersAfterDisconnect, 0, "a disconnected controller must not answer a late offer");
  assert.equal(stateAfterDisconnect, "disconnected");
});

test("controller disconnect prevents a deferred join from installing polling", async () => {
  const originalSetInterval = globalThis.setInterval;
  let intervalsInstalled = 0;
  globalThis.setInterval = ((handler: TimerHandler, timeout?: number, ...arguments_: unknown[]) => {
    intervalsInstalled += 1;
    return originalSetInterval(handler, timeout, ...arguments_);
  }) as typeof setInterval;
  let releaseJoin!: (lease: { peerId: string; peerToken: string; generation: number; expiresAt: number }) => void;
  let signalJoinStarted!: () => void;
  const joinStarted = new Promise<void>((resolve) => { signalJoinStarted = resolve; });
  const joined = new Promise<{ peerId: string; peerToken: string; generation: number; expiresAt: number }>(
    (resolve) => { releaseJoin = resolve; },
  );
  const controller = new SignaledLinkTransport({
    signaling: {
      async join() { signalJoinStarted(); return joined; },
      async getOffer() { return { generation: 0, expiresAt: 9_999 }; },
      async publishAnswer() {},
      async requestReconnect(lease) { return lease; },
      async leave() {},
    },
    device: { deviceId: "join-phone", label: "Phone", capabilities: { touch: true } },
    pollIntervalMs: 60_000,
  });

  try {
    const connect = controller.connect();
    await joinStarted;
    await controller.disconnect();
    releaseJoin({ peerId: "late-join", peerToken: "j".repeat(32), generation: 0, expiresAt: 9_999 });
    await connect;
    assert.equal(intervalsInstalled, 0,
      "a join resolving after disconnect must not resurrect the signaling poller");
    assert.equal(controller.state, "disconnected");
  } finally {
    releaseJoin({ peerId: "late-join", peerToken: "j".repeat(32), generation: 0, expiresAt: 9_999 });
    await controller.disconnect();
    globalThis.setInterval = originalSetInterval;
  }
});

test("a rejected initial join rolls back so connect can retry", async () => {
  let joinAttempts = 0;
  let offerPolls = 0;
  const controller = new SignaledLinkTransport({
    signaling: {
      async join() {
        joinAttempts += 1;
        if (joinAttempts === 1) throw new Error("temporary join failure");
        return { peerId: "retry-peer", peerToken: "r".repeat(32), generation: 1, expiresAt: 9_999 };
      },
      async getOffer() {
        offerPolls += 1;
        return { generation: 1, expiresAt: 9_999 };
      },
      async publishAnswer() {},
      async requestReconnect(lease) { return lease; },
      async leave() {},
    },
    device: { deviceId: "retry-phone", label: "Phone", capabilities: { touch: true } },
    pollIntervalMs: 60_000,
  });

  await assert.rejects(() => controller.connect(), /temporary join failure/);
  const stateAfterFailure = controller.state;
  try {
    await controller.connect();
    assert.equal(joinAttempts, 2, "retry must issue a fresh authenticated join");
    assert.equal(offerPolls, 1, "a successful retry must proceed into offer polling");
    assert.equal(stateAfterFailure, "disconnected", "failed startup must leave a retryable link state");
  } finally {
    await controller.disconnect();
  }
});

test("a failed initial offer transaction releases its lease and retries from a fresh join", async () => {
  let joinAttempts = 0;
  let transportAttempts = 0;
  let transportDisconnects = 0;
  let publishedAnswers = 0;
  const departedPeers: string[] = [];
  const controller = new SignaledLinkTransport({
    signaling: {
      async join() {
        joinAttempts += 1;
        return { peerId: `transaction-peer-${joinAttempts}`, peerToken: "x".repeat(32), generation: 1, expiresAt: 9_999 };
      },
      async getOffer() { return { generation: 1, offer: "101-offer-transaction", expiresAt: 9_999 }; },
      async publishAnswer() { publishedAnswers += 1; },
      async requestReconnect(lease) { return lease; },
      async leave(lease) { departedPeers.push(lease.peerId); },
    },
    device: { deviceId: "transaction-phone", label: "Phone", capabilities: { touch: true } },
    transportFactory: () => {
      transportAttempts += 1;
      const attempt = transportAttempts;
      return stubNegotiatedTransport({
        async acceptOfferCode() {
          if (attempt === 1) throw new Error("offer transaction failed");
          return "101-answer-transaction";
        },
        async disconnect() { transportDisconnects += 1; },
      });
    },
    pollIntervalMs: 60_000,
  });

  await assert.rejects(() => controller.connect(), /offer transaction failed/);
  const stateAfterFailure = controller.state;
  const leasesAfterFailure = [...departedPeers];
  const disconnectsAfterFailure = transportDisconnects;
  try {
    await controller.connect();
    assert.equal(joinAttempts, 2, "post-join failure must not leave connect trapped behind active=true");
    assert.equal(transportAttempts, 2, "retry must build a new transport transaction");
    assert.equal(publishedAnswers, 1, "the fresh transaction must reach answer publication");
    assert.deepEqual(leasesAfterFailure, ["transaction-peer-1"], "the unusable first lease must be released");
    assert.ok(disconnectsAfterFailure >= 1, "the partial first transport must be disconnected");
    assert.equal(stateAfterFailure, "disconnected");
  } finally {
    await controller.disconnect();
  }
});

test("a later controller offer failure is reported and backed off without an unhandled rejection", async () => {
  let exposeOffer = false;
  let signalOfferAttempted!: () => void;
  const offerAttempted = new Promise<void>((resolve) => { signalOfferAttempted = resolve; });
  const errors: Error[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  const controller = new SignaledLinkTransport({
    signaling: {
      async join() { return { peerId: "timer-peer", peerToken: "t".repeat(32), generation: 1, expiresAt: 9_999 }; },
      async getOffer() {
        return exposeOffer
          ? { generation: 1, offer: "101-offer-timer", expiresAt: 9_999 }
          : { generation: 1, expiresAt: 9_999 };
      },
      async publishAnswer() {},
      async requestReconnect(lease) { return lease; },
      async leave() {},
    },
    device: { deviceId: "timer-phone", label: "Phone", capabilities: { touch: true } },
    transportFactory: () => stubNegotiatedTransport({
      async acceptOfferCode() {
        signalOfferAttempted();
        throw new Error("timer offer failed");
      },
    }),
    pollIntervalMs: 10,
  });
  controller.onError((error) => errors.push(error));
  process.on("unhandledRejection", onUnhandled);

  try {
    await controller.connect();
    exposeOffer = true;
    await offerAttempted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, [], "polling failures must not escape into the global rejection handler");
    assert.equal(errors.length, 1, "the transaction failure should be reported once through the error channel");
    assert.match(errors[0]!.message, /timer offer failed/);
    assert.ok(controller.retryDelayMs > 0, "a broken transaction must back off before rebuilding it");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await controller.disconnect();
  }
});

test("a signaled controller retries a reconnect request that failed during a Hub outage", async () => {
  let generation = 1;
  let reconnectAttempts = 0;
  let hubAvailable = false;
  let signalFirstReconnect!: () => void;
  const firstReconnect = new Promise<void>((resolve) => { signalFirstReconnect = resolve; });
  const stateListeners: Array<(state: LinkState) => void> = [];
  let transports = 0;
  const controller = new SignaledLinkTransport({
    signaling: {
      async join() {
        return { peerId: "recover-peer", peerToken: "r".repeat(32), generation, expiresAt: Date.now() + 60_000 };
      },
      async getOffer() {
        return { generation, offer: `101-offer-recover-${generation}`, expiresAt: Date.now() + 60_000 };
      },
      async publishAnswer() {},
      async requestReconnect(lease) {
        reconnectAttempts += 1;
        if (reconnectAttempts === 1) signalFirstReconnect();
        if (!hubAvailable) throw new Error("temporary reconnect outage");
        generation += 1;
        return { ...lease, generation };
      },
      async leave() {},
    },
    device: { deviceId: "recover-phone", label: "Phone", capabilities: { touch: true } },
    transportFactory: () => {
      transports += 1;
      return stubNegotiatedTransport({
        async acceptOfferCode() { return `101-answer-recover-${generation}`; },
        onStateChange(callback) {
          stateListeners.push(callback);
          callback("connecting");
          return () => undefined;
        },
      });
    },
    pollIntervalMs: 2,
  });

  await controller.connect();
  try {
    assert.equal(transports, 1);
    stateListeners[0]?.("failed");
    await firstReconnect;
    hubAvailable = true;

    for (let attempt = 0; attempt < 40 && transports < 2; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 3));
      await controller.sync();
    }

    assert.ok(reconnectAttempts >= 2, "the controller must retain reconnect intent across signaling backoff");
    assert.equal(transports, 2, "a recovered Hub must drive a fresh-generation peer transport");
  } finally {
    await controller.disconnect();
  }
});

test("automatic host startup rolls back after an initial peer-list failure", async () => {
  let listAttempts = 0;
  const host = new AutomaticPairingHost({
    signaling: {
      async listPeers() {
        listAttempts += 1;
        if (listAttempts === 1) throw new Error("temporary peer-list failure");
        return [];
      },
      async publishOffer() {},
      async resetPeer() {},
    },
    transport: new MultiplexLinkTransport(),
    pollIntervalMs: 60_000,
  });

  await assert.rejects(() => host.start(), /temporary peer-list failure/);
  try {
    await host.start();
    assert.equal(listAttempts, 2, "a second start must perform a new peer listing");
  } finally {
    await host.stop();
  }
});

test("automatic host polling absorbs failures, backs off, and resumes", async () => {
  const pollIntervalMs = 20;
  const calls: number[] = [];
  let failNextPoll = false;
  let signalRecovered!: () => void;
  const recovered = new Promise<void>((resolve) => { signalRecovered = resolve; });
  const errors: Error[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  const host = new AutomaticPairingHost({
    signaling: {
      async listPeers() {
        calls.push(Date.now());
        if (failNextPoll) {
          failNextPoll = false;
          throw new Error("timer peer-list failure");
        }
        if (calls.length >= 3) signalRecovered();
        return [];
      },
      async publishOffer() {},
      async resetPeer() {},
    },
    transport: new MultiplexLinkTransport(),
    pollIntervalMs,
  });
  const observable = host as AutomaticPairingHost & {
    onError?(callback: (error: Error) => void): () => void;
  };
  const removeError = observable.onError?.((error) => errors.push(error));
  process.on("unhandledRejection", onUnhandled);

  try {
    await host.start();
    failNextPoll = true;
    await recovered;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, [], "host polling must absorb timer-path signaling failures");
    assert.equal(errors.length, 1, "host polling should report the first failure in a run");
    assert.match(errors[0]!.message, /timer peer-list failure/);
    assert.ok(calls[2]! - calls[1]! >= 30, "the failed poll must back off before retrying");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    removeError?.();
    await host.stop();
  }
});

class FakeRtcNetwork {
  readonly created: FakeNegotiatedTransport[] = [];
  private nextId = 0;
  private readonly offers = new Map<string, FakeNegotiatedTransport>();
  private readonly answers = new Map<string, FakeNegotiatedTransport>();

  create(initiator: boolean) {
    const transport = new FakeNegotiatedTransport(++this.nextId, initiator, this);
    this.created.push(transport);
    return transport;
  }

  offer(transport: FakeNegotiatedTransport) {
    const code = `101-offer-${transport.id}`;
    this.offers.set(code, transport);
    return code;
  }

  answer(code: string, transport: FakeNegotiatedTransport) {
    assert.ok(this.offers.has(code));
    const answer = `101-answer-${transport.id}`;
    this.answers.set(answer, transport);
    return answer;
  }

  accept(answer: string, host: FakeNegotiatedTransport) {
    const controller = this.answers.get(answer);
    assert.ok(controller);
    host.connected();
    controller.connected();
  }
}

function stubNegotiatedTransport(overrides: Partial<NegotiatedLinkTransport> = {}): NegotiatedLinkTransport {
  return {
    state: "idle",
    async connect() {},
    async disconnect() {},
    async createOfferCode() { return "101-offer-stub"; },
    async acceptOfferCode() { return "101-answer-stub"; },
    async acceptAnswerCode() {},
    sendReliable() {},
    sendRealtime() {},
    onMessage() { return () => undefined; },
    onStateChange(callback) { callback("idle"); return () => undefined; },
    ...overrides,
  };
}

class FakeNegotiatedTransport implements NegotiatedLinkTransport {
  private readonly stateListeners = new Set<(state: LinkState) => void>();
  readonly id: number;
  readonly initiator: boolean;
  private readonly network: FakeRtcNetwork;
  state: LinkState = "idle";

  constructor(id: number, initiator: boolean, network: FakeRtcNetwork) {
    this.id = id;
    this.initiator = initiator;
    this.network = network;
  }

  async connect() { this.setState("connecting"); }
  async disconnect() { this.setState("disconnected"); }
  async createOfferCode() { return this.network.offer(this); }
  async acceptOfferCode(code: string) { await this.connect(); return this.network.answer(code, this); }
  async acceptAnswerCode(code: string) { this.network.accept(code, this); }
  sendReliable() {}
  sendRealtime() {}
  onMessage() { return () => undefined; }
  onStateChange(callback: (state: LinkState) => void) { this.stateListeners.add(callback); callback(this.state); return () => this.stateListeners.delete(callback); }
  connected() { this.setState("connected"); }
  fail() { this.setState("failed"); }
  private setState(state: LinkState) { this.state = state; this.stateListeners.forEach((listener) => listener(state)); }
}

test("an unreachable Hub reports a connection state instead of an unhandled rejection", async () => {
  // A controller polls signaling several times a second. When the Hub goes away, every one of
  // those rejections used to escape into the global handler and surface on the device as
  // "Uncaught (in promise): fetch failed" — roughly eighty error toasts a minute.
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);

  let joined = false;
  const failing = {
    async join() { joined = true; return { peerId: "peer-1", peerToken: "t".repeat(32), sessionId: "DEAD01", endpoint: "http://127.0.0.1:1" }; },
    async getOffer() { throw new Error("fetch failed: ConnectException"); },
    async publishAnswer() { throw new Error("fetch failed: ConnectException"); },
    async requestReconnect() { throw new Error("fetch failed: ConnectException"); },
    async leave() { throw new Error("fetch failed: ConnectException"); },
  };

  const transport = new SignaledLinkTransport({
    signaling: failing as never,
    device: { deviceId: "phone-1", label: "Phone 1", capabilities: { touch: true } },
    transportFactory: () => new FakeRtcNetwork().create(false),
    pollIntervalMs: 5,
  });

  const errors: Error[] = [];
  transport.onError((error) => errors.push(error));
  await transport.connect();
  assert.ok(joined, "the controller still joins before polling begins");

  // Poll repeatedly while the Hub stays down.
  for (let attempt = 0; attempt < 6; attempt += 1) await transport.sync();
  await new Promise((resolve) => setImmediate(resolve));
  process.off("unhandledRejection", onRejection);

  assert.deepEqual(rejections, [], "an unreachable Hub must never raise an unhandled rejection");
  assert.equal(errors.length, 1, "the failure is reported once, not once per poll");
  assert.match(errors[0]!.message, /fetch failed/);
  assert.equal(transport.state, "disconnected", "the state explains the outage");
  assert.ok(transport.retryDelayMs > 0, "polling backs off instead of hammering a Hub that is not there");

  await transport.disconnect();
  assert.equal(transport.retryDelayMs, 0, "a deliberate disconnect clears the backoff");
});
