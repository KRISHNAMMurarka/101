import { Engine101 } from "@101/core";
import {
  InputBus,
  resolveInputManifest,
  type InputAdapter,
  type InputSource,
  type ResolvedInputManifest,
} from "@101/input";
import type { LinkTransport } from "@101/protocol";
import type { GamePackage } from "@101/sdk";
import { SessionHost, sessionSources, type SessionSnapshot } from "@101/session";

/**
 * What the running game needs, matched against what is actually plugged in or paired.
 *
 * This is the answer to "different games have different needs": the game states its requirements
 * once, in its input manifest, and the host continuously reconciles them against reality rather
 * than assuming a keyboard is present.
 */
export interface InputReadiness extends ResolvedInputManifest {
  gameId: string;
  /** Everything currently able to produce frames: local adapters plus paired devices. */
  available: InputSource[];
}

export interface GameHostOptions {
  transport: LinkTransport;
  adapters?: readonly InputAdapter[];
  inputBus?: InputBus;
  onSessionChange?(snapshot: SessionSnapshot): void;
  /**
   * Called whenever the match between a game's declared needs and the connected hardware changes —
   * on launch, and every time a device joins or leaves. This is what lets a launcher say "connect a
   * phone to steer" instead of starting a game whose controls nobody can reach.
   */
  onInputReadiness?(readiness: InputReadiness): void;
}

export class GameHost101 {
  readonly inputBus: InputBus;
  readonly session: SessionHost;
  private readonly adapters: readonly InputAdapter[];
  private engine?: Engine101<unknown>;
  private connected = false;
  private active?: GamePackage<unknown>;
  private readiness?: InputReadiness;
  private readonly onReadiness?: (readiness: InputReadiness) => void;

  constructor(options: GameHostOptions) {
    this.inputBus = options.inputBus ?? new InputBus();
    this.adapters = options.adapters ?? [];
    this.session = new SessionHost({
      gameId: "launcher",
      roles: [],
      transport: options.transport,
      onFrame: (frame) => this.inputBus.accept(frame),
      onDeviceReset: (deviceId) => this.inputBus.removeDevice(deviceId),
      onChange: (snapshot) => {
        // Devices joining and leaving changes what the game can be played with, so readiness is
        // recomputed here rather than only at launch.
        this.refreshReadiness(snapshot);
        options.onSessionChange?.(snapshot);
      },
    });
    this.onReadiness = options.onInputReadiness;
  }

  /** The current match between the running game's needs and the connected hardware. */
  get inputReadiness() {
    return this.readiness;
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
    this.refreshReadiness();
    await engine.start();
    return engine.context;
  }

  private refreshReadiness(snapshot = this.session.session.snapshot()) {
    const active = this.active;
    if (!active) return;
    const available = this.inputBus.availableSources(sessionSources(snapshot.devices));
    const next: InputReadiness = {
      gameId: active.manifest.id,
      available,
      ...resolveInputManifest(active.input, available),
    };
    // Only announce real changes; device liveness beats would otherwise fire this constantly.
    if (this.readiness && sameReadiness(this.readiness, next)) return;
    this.readiness = next;
    this.onReadiness?.(next);
  }

  stopGame() {
    this.engine?.stop();
    this.engine = undefined;
    this.active = undefined;
    this.readiness = undefined;
    this.session.setGame("launcher", []);
  }

  async disconnect() {
    this.stopGame();
    if (this.connected) await this.session.stop();
    await this.inputBus.destroy();
    this.connected = false;
  }
}

function sameReadiness(a: InputReadiness, b: InputReadiness) {
  return a.gameId === b.gameId
    && a.playable === b.playable
    && a.available.join() === b.available.join()
    && a.missing.join() === b.missing.join()
    && a.degraded.join() === b.degraded.join()
    && JSON.stringify(a.mappings) === JSON.stringify(b.mappings);
}
