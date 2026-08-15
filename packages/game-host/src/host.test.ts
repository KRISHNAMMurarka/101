import assert from "node:assert/strict";
import test from "node:test";
import type { LinkMessage, LinkTransport } from "@101/protocol";
import { Game101 } from "@101/sdk";
import { GameHost101 } from "./index.ts";

class MemoryTransport implements LinkTransport {
  listener?: (message: LinkMessage) => void;
  connected = false;
  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }
  sendReliable() {}
  sendRealtime() {}
  onMessage(callback: (message: LinkMessage) => void) { this.listener = callback; return () => { this.listener = undefined; }; }
}

test("launches an independent package and routes controller frames through the shared bus", async () => {
  const originalRequest = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (() => 1) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => undefined) as typeof cancelAnimationFrame;
  try {
    const transport = new MemoryTransport();
    const host = new GameHost101({ transport });
    const gamePackage = Game101.package({
      manifest: { id: "host-test", name: "Host Test", version: "1.0.0", engine: "^1", renderer: "2d", players: { min: 1, max: 1 }, inputs: ["touch"], offline: true, procedural: false, controllers: { basic: ["touch"] } },
      input: { game: "host-test", actions: { fire: { recommended: ["touch"] } } },
      controllers: [{ id: "gunner", label: "Gunner", playerId: "player-1", requiredCapabilities: ["touch"], layout: { layout: [{ type: "button", action: "fire", label: "FIRE" }] } }],
      game: Game101.define({ id: "host-test", initialState: () => ({ fired: false }), update(ctx) { ctx.state.fired = Boolean(ctx.input.action("fire")); } }),
    });
    const context = await host.launch(gamePackage);
    transport.listener?.({ channel: "control", payload: { type: "hello", version: 2, deviceId: "phone", device: "Phone", capabilities: { touch: true } } });
    transport.listener?.({ channel: "realtime", payload: { deviceId: "phone", playerId: "forged", sequence: 1, timestamp: 1, source: "custom", actions: { fire: true } } });
    host.inputBus.bind("fire");
    assert.equal(host.inputBus.action("fire"), true);
    assert.equal(context.state.fired, false);
    host.stopGame();
    assert.equal(host.activeGame, undefined);
    await host.disconnect();
    assert.equal(transport.connected, false);
  } finally {
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
