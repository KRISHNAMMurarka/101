import assert from "node:assert/strict";
import test from "node:test";
import {
  AutomaticPairingHost,
  BrokerControllerSignalingClient,
  BrokerHostSignalingClient,
  LocalSignalingBroker,
  SignaledLinkTransport,
  type NegotiatedLinkTransport,
} from "./index.ts";
import { MultiplexLinkTransport, type LinkState } from "@101/protocol";

test("broker separates host, join, and per-peer authorization and expires sessions", () => {
  let now = 100;
  let token = 0;
  const broker = new LocalSignalingBroker({ now: () => now, randomToken: () => `${String(++token).padStart(32, "a")}` });
  const created = broker.createSession({ sessionId: "PAIR101", endpoint: "http://127.0.0.1:10101", ttlMs: 100 });
  const controller = new BrokerControllerSignalingClient(broker, created.ticket);
  const host = new BrokerHostSignalingClient(broker, "PAIR101", created.hostToken);
  return controller.join({ deviceId: "phone", label: "Phone", capabilities: { touch: true } }).then(async (peer) => {
    assert.equal((await host.listPeers())[0]?.deviceId, "phone");
    await assert.rejects(() => new BrokerHostSignalingClient(broker, "PAIR101", "x".repeat(32)).listPeers(), /authorization/);
    assert.throws(() => broker.getOffer("PAIR101", peer.peerId, "x".repeat(32)), /authorization/);
    now = 201;
    assert.deepEqual(broker.expire(), ["PAIR101"]);
  });
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
  await host.stop();
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
