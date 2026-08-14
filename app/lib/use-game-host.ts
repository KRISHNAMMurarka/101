"use client";

import { GameHost101, type InputReadiness } from "@101/game-host";
import type { InputAdapter } from "@101/input";
import type { GameContext, GamePackage } from "@101/sdk";
import { LocalSession, type SessionSnapshot } from "@101/session";
import { useEffect, useState } from "react";

import { getBrowserHostTransport } from "./browser-link";

export interface GameHostBinding<State> {
  /** Everything the game needs to draw: state, input, and the rest of the engine context. */
  context: GameContext<State>;
  host: GameHost101;
}

export interface UseGameHostOptions<State> {
  sessionId: string;
  /**
   * Built fresh per run, because a package embeds its game definition and most games take a seed.
   * `defineGamePackage` also validates the manifest, input manifest and controller roles agree, so
   * a mismatch surfaces the moment a game starts rather than as a silent missing control.
   */
  build(): GamePackage<State>;
  adapters?(): InputAdapter[];
  /**
   * Runs once the engine is live. Attach views, draw loops and HUD timers here and return their
   * teardown; it is invoked even if the component unmounted while the launch was still in flight.
   */
  onReady(binding: GameHostBinding<State>): (() => void) | void;
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
  adapters,
  onReady,
  deps = [],
}: UseGameHostOptions<State>) {
  const [linked, setLinked] = useState(0);
  const [session, setSession] = useState<SessionSnapshot>();
  const [readiness, setReadiness] = useState<InputReadiness>();

  useEffect(() => {
    let disposed = false;
    let teardown: (() => void) | void;

    const host = new GameHost101({
      transport: getBrowserHostTransport(sessionId),
      session: new LocalSession(sessionId),
      adapters: adapters?.() ?? [],
      onSessionChange: (snapshot) => {
        setSession(snapshot);
        setLinked(snapshot.assignments.length);
      },
      onInputReadiness: setReadiness,
    });

    void host.launch(build()).then((context) => {
      // The effect can be torn down while the launch is still resolving — a fast unmount, or React
      // running effects twice in development. Starting a draw loop then would leave it running
      // against a stopped engine.
      if (disposed) return;
      teardown = onReady({ context, host });
    });

    return () => {
      disposed = true;
      teardown?.();
      void host.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, ...deps]);

  return { linked, session, readiness };
}
