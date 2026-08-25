import assert from "node:assert/strict";
import test from "node:test";
import type { ControlMessage, LinkMessage, LinkTransport, RealtimeMessage } from "@101/protocol";
import { Game101 } from "@101/sdk";
import { GameHost101 } from "./index.ts";

class MemoryTransport implements LinkTransport {
  listener?: (message: LinkMessage) => void;
  connected = false;
  readonly reliable: ControlMessage[] = [];
  readonly realtime: RealtimeMessage[] = [];
  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }
  sendReliable(message: ControlMessage) { this.reliable.push(message); }
  sendRealtime(message: RealtimeMessage) { this.realtime.push(message); }
  onMessage(callback: (message: LinkMessage) => void) { this.listener = callback; return () => { this.listener = undefined; }; }
}

class DeferredConnectTransport extends MemoryTransport {
  private releaseConnection!: () => void;
  private readonly connection = new Promise<void>((resolve) => { this.releaseConnection = resolve; });

  override async connect() {
    await this.connection;
    await super.connect();
  }

  release() { this.releaseConnection(); }
}

test("launches an independent package and routes controller frames through the shared bus", async () => {
  const originalRequest = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (() => 1) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => undefined) as typeof cancelAnimationFrame;
  let host: GameHost101 | undefined;
  try {
    const transport = new MemoryTransport();
    host = new GameHost101({ transport });
    const gamePackage = Game101.package({
      manifest: { id: "host-test", name: "Host Test", version: "1.0.0", engine: "^1", renderer: "2d", players: { min: 1, max: 1 }, inputs: ["touch"], offline: true, procedural: false, controllers: { basic: ["touch"] } },
      input: { game: "host-test", actions: { fire: { recommended: ["touch"] } } },
      controllers: [{ id: "gunner", label: "Gunner", playerId: "player-1", requiredCapabilities: ["touch"], layout: { layout: [{ type: "button", action: "fire", label: "FIRE" }] } }],
      game: Game101.define({ id: "host-test", initialState: () => ({ fired: false }), update(ctx) { ctx.state.fired = Boolean(ctx.input.action("fire")); } }),
    });
    const context = await host.launch(gamePackage);
    transport.listener?.({ channel: "control", payload: {
      type: "hello", version: 2, deviceId: "phone", device: "Phone",
      capabilities: { touch: true, speaker: true },
      features: { inputFormats: ["input-q1"], speakerAudio: "ready" },
    } });
    transport.listener?.({ channel: "realtime", payload: { deviceId: "phone", playerId: "forged", sequence: 1, timestamp: 1, source: "custom", actions: { fire: true } } });
    host.inputBus.bind("fire");
    assert.equal(host.inputBus.action("fire"), true);
    assert.equal(context.state.fired, false);
    transport.realtime.length = 0;
    assert.equal(host.playControllerCue("gunner", { pitch: 1.2, volume: .3 }), true);
    const privateCue = transport.realtime.at(0);
    if (!privateCue || !("type" in privateCue) || privateCue.type !== "speaker.cue") {
      assert.fail("expected one private speaker cue");
    }
    assert.equal(Number.isSafeInteger(privateCue.sequence), true);
    assert.deepEqual({ ...privateCue, sequence: 0 }, {
      type: "speaker.cue", deviceId: "phone", sequence: 0,
      cue: "pulse-v1", pitch: 1.2, volume: .3,
    });
    host.stopGame();
    assert.equal(host.activeGame, undefined);
    await host.disconnect();
    host = undefined;
    assert.equal(transport.connected, false);
  } finally {
    await host?.disconnect();
    globalThis.requestAnimationFrame = originalRequest;
    globalThis.cancelAnimationFrame = originalCancel;
  }
});

test("input readiness is reported from local hardware before the transport connects", async () => {
  // Readiness used to be computed only after `connect()` resolved, so a status bar sat on
  // "DETECTING INPUT" for the whole of a link negotiation — a tick on a memory transport, seconds
  // on a slow LAN. Whether a game is playable on this machine is answerable from the adapters
  // alone, and waiting for the network to say so is waiting for an answer the network does not have.
  const originalRequest = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (() => 1) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;

  try {
    let transportConnected = false;
    const transport: LinkTransport = {
      async connect() { await new Promise((resolve) => setTimeout(resolve, 40)); transportConnected = true; },
      async disconnect() { transportConnected = false; },
      sendReliable() {}, sendRealtime() {},
      onMessage() { return () => {}; },
    };

    const reports: { available: string[]; connected: boolean }[] = [];
    const host = new GameHost101({
      transport,
      adapters: [{ id: "kb", source: "keyboard", start() {}, stop() {} }],
      onInputReadiness: (readiness) => reports.push({ available: [...readiness.available], connected: transportConnected }),
    });

    await host.launch(Game101.package({
      manifest: { id: "early", name: "Early", version: "1.0.0", engine: "^1", renderer: "2d", players: { min: 1, max: 1 }, inputs: ["keyboard"], offline: true, procedural: false, controllers: { basic: ["keyboard"] } },
      input: { game: "early", actions: { jump: { recommended: ["keyboard"] } } },
      game: Game101.define({ id: "early", initialState: () => ({}), update() {} }),
    }));

    assert.ok(reports.length >= 1, "readiness must be reported at all");
    assert.deepEqual(reports[0]!.available, ["keyboard"]);
    assert.equal(reports[0]!.connected, false,
      "the first reading must arrive before the transport finishes connecting");

    // Unchanged readings are not re-announced; device liveness beats would otherwise fire this
    // constantly and every subscriber would re-render for nothing.
    assert.equal(reports.length, 1, "an unchanged reading must not be announced twice");

    await host.disconnect();
  } finally {
    globalThis.requestAnimationFrame = originalRequest;
    globalThis.cancelAnimationFrame = originalCancel;
  }
});

test("a failed launch leaves no half-active game behind", async () => {
  // `active` is now set before connecting so the early reading has a package to resolve against.
  // If the transport then fails, the host must not be left advertising a game with no engine.
  const transport: LinkTransport = {
    async connect() { throw new Error("no route to host"); },
    async disconnect() {},
    sendReliable() {}, sendRealtime() {},
    onMessage() { return () => {}; },
  };
  const host = new GameHost101({ transport });

  await assert.rejects(() => host.launch(Game101.package({
    manifest: { id: "doomed", name: "Doomed", version: "1.0.0", engine: "^1", renderer: "2d", players: { min: 1, max: 1 }, inputs: ["keyboard"], offline: true, procedural: false, controllers: { basic: ["keyboard"] } },
    input: { game: "doomed", actions: { jump: { recommended: ["keyboard"] } } },
    game: Game101.define({ id: "doomed", initialState: () => ({}), update() {} }),
  })), /no route to host/);

  assert.equal(host.activeGame, undefined, "a failed launch must not leave an active game");
  assert.equal(host.inputReadiness, undefined, "nor stale readiness for it");
});

test("disconnect tears down a host whose transport connection is still starting", async () => {
  const originalRequest = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (() => 1) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => undefined) as typeof cancelAnimationFrame;
  const transport = new DeferredConnectTransport();
  const host = new GameHost101({ transport });
  const gamePackage = Game101.package({
    manifest: { id: "slow-host", name: "Slow Host", version: "1.0.0", engine: "^1", renderer: "2d", players: { min: 1, max: 1 }, inputs: ["touch"], offline: true, procedural: false, controllers: { basic: ["touch"] } },
    input: { game: "slow-host", actions: { fire: { recommended: ["touch"] } } },
    controllers: [{ id: "gunner", label: "Gunner", playerId: "player-1", requiredCapabilities: ["touch"], layout: { layout: [{ type: "button", action: "fire", label: "FIRE" }] } }],
    game: Game101.define({ id: "slow-host", initialState: () => ({}), update() {} }),
  });

  try {
    const launch = host.launch(gamePackage);
    const disconnect = host.disconnect();
    transport.release();
    await Promise.all([launch, disconnect]);

    transport.reliable.length = 0;
    transport.listener?.({ channel: "control", payload: {
      type: "hello", version: 2, deviceId: "late-phone", device: "Phone", capabilities: { touch: true },
    } });
    assert.equal(transport.listener, undefined,
      "effect cleanup must remove the SessionHost listener even when launch was still awaiting connect");
    assert.deepEqual(transport.reliable, [], "a disposed host must not answer a later hello with assign/wait");
    assert.equal(transport.connected, false);
  } finally {
    await host.disconnect();
    globalThis.requestAnimationFrame = originalRequest;
    globalThis.cancelAnimationFrame = originalCancel;
  }
});

test("disconnect waits out an asynchronous preload and leaves no frame loop behind", async () => {
  const originalRequest = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  const activeFrames = new Set<number>();
  const events: string[] = [];
  let nextFrame = 0;
  globalThis.requestAnimationFrame = (() => {
    const handle = ++nextFrame;
    activeFrames.add(handle);
    events.push("frame-requested");
    return handle;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((handle: number) => {
    activeFrames.delete(handle);
    events.push("frame-cancelled");
  }) as typeof cancelAnimationFrame;

  let releasePreload!: () => void;
  const preloadPending = new Promise<void>((resolve) => { releasePreload = resolve; });
  let signalPreloadStarted!: () => void;
  const preloadStarted = new Promise<void>((resolve) => { signalPreloadStarted = resolve; });
  const host = new GameHost101({ transport: new MemoryTransport() });
  const gamePackage = Game101.package({
    manifest: { id: "slow-preload", name: "Slow Preload", version: "1.0.0", engine: "^1", renderer: "2d", players: { min: 1, max: 1 }, inputs: ["touch"], offline: true, procedural: false, controllers: { basic: ["touch"] } },
    input: { game: "slow-preload", actions: { fire: { recommended: ["touch"] } } },
    game: Game101.define({
      id: "slow-preload",
      initialState: () => ({}),
      async preload() {
        events.push("preload-started");
        signalPreloadStarted();
        await preloadPending;
        events.push("preload-finished");
      },
      start() { events.push("game-started"); },
      update() {},
      stop() { events.push("game-stopped"); },
    }),
  });

  try {
    const launch = host.launch(gamePackage);
    await preloadStarted;
    let disconnected = false;
    const disconnect = host.disconnect().then(() => {
      disconnected = true;
      events.push("disconnected");
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(disconnected, false,
      "teardown cannot finish while preload can still resume and create a frame loop");

    releasePreload();
    await Promise.all([launch, disconnect]);
    const disconnectedAt = events.indexOf("disconnected");
    assert.equal(events.includes("game-started"), false,
      "cancelling during preload must prevent the obsolete game start hook entirely");
    assert.equal(events.includes("frame-requested"), false,
      "cancelling during preload must prevent even a transient obsolete frame loop");
    const cancelledAt = events.indexOf("frame-cancelled");
    if (cancelledAt !== -1) assert.ok(cancelledAt < disconnectedAt,
      "any previously scheduled frame must be cancelled before teardown completes");
    assert.equal(activeFrames.size, 0, "disconnect must cancel a loop created when preload resumes");
    assert.equal(host.activeGame, undefined);
  } finally {
    releasePreload();
    await host.disconnect();
    globalThis.requestAnimationFrame = originalRequest;
    globalThis.cancelAnimationFrame = originalCancel;
  }
});
