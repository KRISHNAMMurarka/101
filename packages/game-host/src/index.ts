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
import { LocalSession, SessionHost, sessionSources, type SessionSnapshot } from "@101/session";

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
  /**
   * The session to host under.
   *
   * Pairing tickets carry the session code, so a host that invents its own cannot be joined by a
   * controller holding a link for a known one. Anything rendering a QR code must pass the session
   * whose code it printed.
   */
  session?: LocalSession;
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
  private connecting?: Promise<void>;
  private readonly launches = new Set<Promise<unknown>>();
  private launchRevision = 0;
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
      ...(options.session ? { session: options.session } : {}),
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

  connect() {
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;
    const pending = this.openConnection();
    this.connecting = pending;
    void pending.then(
      () => { if (this.connecting === pending) this.connecting = undefined; },
      () => { if (this.connecting === pending) this.connecting = undefined; },
    );
    return pending;
  }

  private async openConnection() {
    await Promise.all(this.adapters.map((adapter) => this.inputBus.register(adapter)));
    // Local hardware alone answers "can this game be played on this machine?", and that answer does
    // not improve by waiting for a transport. Reporting here keeps a status bar from sitting on
    // "detecting" for the length of a LAN negotiation, which on a slow link is seconds, not a tick.
    this.refreshReadiness();
    try {
      await this.session.start();
      this.connected = true;
    } catch (error) {
      await Promise.all(this.adapters.map((adapter) => this.inputBus.unregister(adapter)));
      throw error;
    }
  }

  launch<State>(gamePackage: GamePackage<State>) {
    const revision = ++this.launchRevision;
    const pending = this.openLaunch(gamePackage, revision);
    this.launches.add(pending);
    void pending.then(
      () => { this.launches.delete(pending); },
      () => { this.launches.delete(pending); },
    );
    return pending;
  }

  private async openLaunch<State>(gamePackage: GamePackage<State>, revision: number) {
    this.engine?.stop();
    // Set before connecting so the reading taken once adapters are up has a game to resolve
    // against. A failed launch clears it again rather than leaving a package with no engine.
    this.active = gamePackage as GamePackage<unknown>;
    const engine = new Engine101(gamePackage.game, this.inputBus);
    try {
      await this.connect();
    } catch (error) {
      if (this.launchRevision === revision) {
        this.active = undefined;
        this.readiness = undefined;
      }
      throw error;
    }
    // A disconnect or a newer launch can win while the transport is still connecting. The context
    // remains a valid return value for the already-issued call, but the obsolete game must never be
    // installed into the live session.
    if (this.launchRevision !== revision) return engine.context;
    this.session.setGame(gamePackage.manifest.id, gamePackage.controllers);
    this.engine = engine as Engine101<unknown>;
    this.refreshReadiness();
    await engine.start();
    // Preload is arbitrary asynchronous game code. Teardown waits for it, and this stale check
    // cancels the frame Engine101 schedules when preload eventually returns, before disconnect can
    // report that cleanup is complete.
    if (this.launchRevision !== revision || this.engine !== engine) engine.stop();
    return engine.context;
  }

  /**
   * Buzz the device holding a role.
   *
   * Delegated rather than left to `host.session.haptic(...)`. Every converted game reached through
   * the session for exactly these two calls, which makes the host a half-façade: it owns the engine,
   * the bus and the session, but games still had to know which of those a feedback call lives on.
   */
  haptic(roleId: string, pattern: "tap" | "impact" | "warning") {
    return this.session.haptic(roleId, pattern);
  }

  /**
   * Play a private, locally bundled cue on the controller holding this role. Games should use
   * their host-audio fallback when this returns false (for example, before a browser audio unlock).
   */
  playControllerCue(roleId: string, options: { pitch: number; volume: number }) {
    return this.session.speakerCue(roleId, options);
  }

  /** Push private per-role state to the controller holding it — a clue, a readout, a warning. */
  sendControllerState(
    roleId: string,
    values: Record<string, string | number | boolean>,
    options: { message?: string; tone?: "normal" | "warning" | "critical" } = {},
  ) {
    return this.session.sendControllerState(roleId, values, options);
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
    this.launchRevision += 1;
    this.engine?.stop();
    this.engine = undefined;
    this.active = undefined;
    this.readiness = undefined;
    this.session.setGame("launcher", []);
  }

  async disconnect() {
    this.stopGame();
    await this.connecting?.catch(() => undefined);
    await Promise.all([...this.launches].map((launch) => launch.catch(() => undefined)));
    // `launch()` resumes before this waiter because both await the same connection promise. Stop a
    // game it may have installed while cleanup was waiting, then remove the SessionHost listener.
    // Waiting for launches also keeps an asynchronous preload inside the teardown boundary: its
    // stale frame is cancelled before this method resolves rather than springing to life afterward.
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
