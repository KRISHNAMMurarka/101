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
