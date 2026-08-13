import { Engine101 } from "@101/core";
import { InputBus, type InputAdapter } from "@101/input";
import type { LinkTransport } from "@101/protocol";
import type { GamePackage } from "@101/sdk";
import { SessionHost, type SessionSnapshot } from "@101/session";

export interface GameHostOptions {
  transport: LinkTransport;
  adapters?: readonly InputAdapter[];
  inputBus?: InputBus;
  onSessionChange?(snapshot: SessionSnapshot): void;
}

export class GameHost101 {
  readonly inputBus: InputBus;
  readonly session: SessionHost;
  private readonly adapters: readonly InputAdapter[];
  private engine?: Engine101<unknown>;
  private connected = false;
  private active?: GamePackage<unknown>;

  constructor(options: GameHostOptions) {
    this.inputBus = options.inputBus ?? new InputBus();
    this.adapters = options.adapters ?? [];
    this.session = new SessionHost({
      gameId: "launcher",
      roles: [],
      transport: options.transport,
      onFrame: (frame) => this.inputBus.accept(frame),
      onDeviceReset: (deviceId) => this.inputBus.removeDevice(deviceId),
      onChange: options.onSessionChange,
    });
  }

  get activeGame() {
    return this.active;
  }

  async connect() {
    if (this.connected) return;
    await Promise.all(this.adapters.map((adapter) => this.inputBus.register(adapter)));
    try {
      await this.session.start();
      this.connected = true;
    } catch (error) {
      await Promise.all(this.adapters.map((adapter) => this.inputBus.unregister(adapter)));
      throw error;
    }
  }

  async launch<State>(gamePackage: GamePackage<State>) {
    await this.connect();
    this.engine?.stop();
    this.session.setGame(gamePackage.manifest.id, gamePackage.controllers);
    const engine = new Engine101(gamePackage.game, this.inputBus);
    this.engine = engine as Engine101<unknown>;
    this.active = gamePackage as GamePackage<unknown>;
    await engine.start();
    return engine.context;
  }

  stopGame() {
    this.engine?.stop();
    this.engine = undefined;
    this.active = undefined;
    this.session.setGame("launcher", []);
  }

  async disconnect() {
    this.stopGame();
    if (this.connected) await this.session.stop();
    await this.inputBus.destroy();
    this.connected = false;
  }
}
