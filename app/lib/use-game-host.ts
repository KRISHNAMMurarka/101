"use client";

import { GameHost101, type InputReadiness } from "@101/game-host";
import { connectLocalGameInput } from "../../packages/game-host/src/local-input.ts";
import type { GameContext, GamePackage, GameControllerRole } from "@101/sdk";
import { LocalSession, type SessionSnapshot } from "../../packages/game-host/src/game-session.ts";
import { useEffect, useState } from "react";

import { getBrowserApplicationChannel } from "./browser-link";

export interface ControllerHostBinding {
  host: GameHost101;
  roles: readonly Readonly<GameControllerRole>[];
}

export interface GameHostBinding<State> {
  /** Everything the game needs to draw: state, input, and the rest of the engine context. */
  context: GameContext<State>;
  host: GameHost101;
  signal: AbortSignal;
}

export interface GameLaunchState {
  status: "loading" | "ready" | "failed";
  retry(): void;
}

interface GameHostSnapshot {
  key: readonly unknown[];
  linked: number;
  controllerHost: ControllerHostBinding | null;
  session?: SessionSnapshot;
  readiness?: InputReadiness;
  launchStatus: GameLaunchState["status"];
}

export interface UseGameHostOptions<State> {
  sessionId: string;
  /**
   * Built fresh per run, because a package embeds its game definition and most games take a seed.
   * `defineGamePackage` also validates the manifest, input manifest and controller roles agree, so
   * a mismatch surfaces the moment a game starts rather than as a silent missing control.
   */
  build(): GamePackage<State>;
  /** Optional game surface for pointer input; device ownership remains in the host. */
  pointerTarget?(): HTMLElement | null;
  /**
   * Runs once the engine is live. Attach views, draw loops and HUD timers here and return their
   * teardown; it is invoked even if the component unmounted while the launch was still in flight.
   */
  onReady(binding: GameHostBinding<State>): (() => void) | void | Promise<(() => void) | void>;
  /** Re-run everything when any of these change — the run counter, usually. */
  deps?: readonly unknown[];
}

/**
 * One place that knows how to run a 101 game in the browser.
 *
 * Every game component used to assemble this by hand: an Engine101, a LocalSession, a SessionHost
 * with its own onFrame/onDeviceReset wiring, adapter registration, input readiness, and a teardown
 * that had to stop all of it in the right order. Ten copies of the same twenty lines, each free to
 * drift — and they had, which is how seven status bars ended up claiming a gamepad that was not
 * there.
 *
 * It also meant the platform did not use its own SDK. `defineGamePackage` and `GameHost101` existed
 * with no callers at all, so the path a third-party developer is told to build on was the one path
 * nothing exercised.
 */
export function useGameHost<State>({
  sessionId,
  build,
  pointerTarget,
  onReady,
  deps = [],
}: UseGameHostOptions<State>) {
  const [attempt, setAttempt] = useState(0);
  const key = [sessionId, attempt, ...deps];
  const pending: GameHostSnapshot = { key, linked: 0, controllerHost: null, launchStatus: "loading" };
  const [snapshot, setSnapshot] = useState<GameHostSnapshot>(pending);
  // A new run renders its pending state immediately; old asynchronous reports belong to the
  // previous key and cannot project a ready controller or an old failure into this run.
  const sameRun = snapshot.key.length === key.length && snapshot.key.every((value, index) => Object.is(value, key[index]));
  if (!sameRun) setSnapshot(pending);
  const current = sameRun ? snapshot : pending;

  useEffect(() => {
    // Render the game shell on the server, but never open a placeholder room.
    if (!sessionId) return;
    let disposed = false;
    let latest = pending;
    const publish = (next: Partial<GameHostSnapshot>) => {
      if (disposed) return;
      latest = { ...latest, ...next };
      setSnapshot(latest);
    };
    let teardown: (() => void) | void;
    let host: GameHost101 | undefined;
    let disconnect: Promise<void> | undefined;
    let localInput: ReturnType<typeof connectLocalGameInput> | undefined;
    const lifetime = new AbortController();
    const reportCleanupError = (error: unknown) => console.error("Game cleanup failed", error);
    const stop = async () => {
      const current = teardown;
      teardown = undefined;
      try { localInput?.close(); current?.(); }
      finally { await (disconnect ??= host?.disconnect() ?? Promise.resolve()); }
    };

    void (async () => {
      try {
        host = new GameHost101({
          channel: getBrowserApplicationChannel(sessionId),
          session: new LocalSession(sessionId),
          onSessionChange: (snapshot) => {
            if (disposed || lifetime.signal.aborted) return;
            publish({ session: snapshot, linked: snapshot.assignments.length });
          },
          onInputReadiness: (next) => { if (!lifetime.signal.aborted) publish({ readiness: next }); },
        });
        localInput = connectLocalGameInput({ inputBus: host.inputBus, pointerTarget: pointerTarget?.(),
          onAvailability: () => { if (!disposed) host?.refreshInputReadiness(); },
        });
        const gamePackage = build();
        const context = await host.launch(gamePackage);
        if (disposed) return;
        teardown = await onReady({ context, host, signal: lifetime.signal });
        if (disposed) { await stop(); return; }
        publish({ controllerHost: { host, roles: gamePackage.controllers }, launchStatus: "ready" });
      } catch {
        lifetime.abort();
        await stop().catch(reportCleanupError);
        if (disposed) return;
        publish({ ...pending, session: undefined, readiness: undefined, launchStatus: "failed" });
      }
    })();

    return () => {
      disposed = true;
      lifetime.abort();
      void stop().catch(reportCleanupError);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, attempt, ...deps]);

  const launch: GameLaunchState = { status: current.launchStatus, retry: () => setAttempt((value) => value + 1) };
  return { linked: current.linked, session: current.session, readiness: current.readiness, controllerHost: current.controllerHost, launch };
}
