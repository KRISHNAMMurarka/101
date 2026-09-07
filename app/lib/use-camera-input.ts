"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  BrowserCameraAdapter,
  BrowserHandAdapter,
  describeCameraFailure,
  type HandAdapterDiagnostics,
  type PoseAdapterDiagnostics,
} from "@101/adapter-camera";
import type { HandGestureClassifierOptions, PoseClassifierOptions } from "@101/vision";
import type { GameHost101 } from "@101/game-host";

import { readCameraPlan, type CameraKind } from "./camera-plan.ts";

/**
 * A camera as a controller, from the game's point of view.
 *
 * Five games each grew their own copy of this: the same five-state union, the same enable function,
 * the same hand-rolled `NotAllowedError || SecurityError` test, and the same fall-through to
 * `cause.message` for everything else. Five copies of a thing is five places for it to drift, and it
 * had — one game disables its button when the camera is on, another swaps it for a recalibrate, a
 * third does neither.
 *
 * What the player is told comes from one table, in @101/adapter-camera, which is the same table the
 * setup walkthrough reads. The language the setup teaches has to be the language the game keeps.
 *
 * Nothing here reports a number. A confidence percentage in a status bar is a measurement of the
 * model, and the player did not ask about the model — they want to know whether it can see them,
 * which is a yes or a no.
 */

export type CameraInputState = "off" | "starting" | "on" | "failed";

interface CommonOptions {
  sessionId: string;
  video: React.RefObject<HTMLVideoElement | null>;
  /** The running game. Null until it has started, which is why this is a ref rather than a value. */
  host: React.RefObject<GameHost101 | null>;
  /** Reset when the game restarts, so a new run does not inherit the last one's camera. */
  runKey?: unknown;
}

/*
 * Split on `kind` so each game gets the diagnostics and the classifier options that belong to its
 * own adapter, rather than a union it has to narrow by hand.
 *
 * Both fields exist because leaving them out did not simplify the hook, it just stopped three of
 * the five games being able to use it. Shadow Arena draws a silhouette from the live pose, Swarm
 * Commander and Spellcaster name the gesture they just recognised in a feed, and all three tune
 * their classifier — none of which is a confidence number, which was the only thing the first
 * version of this hook thought a game wanted from its camera.
 */
export type CameraInputOptions =
  | (CommonOptions & {
    kind: "body";
    classifier?: PoseClassifierOptions;
    onDiagnostics?(diagnostics: PoseAdapterDiagnostics): void;
  })
  | (CommonOptions & {
    kind: "hands";
    classifier?: HandGestureClassifierOptions;
    onDiagnostics?(diagnostics: HandAdapterDiagnostics): void;
  });

export interface CameraInput {
  readonly state: CameraInputState;
  /** What to tell the player, or "" when there is nothing to say. */
  readonly message: string;
  /** What they can do about it, or "". */
  readonly fix: string;
  enable(): Promise<void>;
  /** Take the player's current position as the resting one. */
  recentre(): void;
}

export function useCameraInput(options: CameraInputOptions): CameraInput {
  const { kind, sessionId, video, host, runKey } = options;
  /*
   * Held in refs so a game passing an inline callback or an object literal — which all of them do —
   * does not tear the camera down and rebuild it on every render. Written in an effect rather than
   * during render, because a render can be thrown away and re-run, and a ref written on a discarded
   * render keeps a value nothing else agreed to.
   */
  const observerRef = useRef(options.onDiagnostics);
  const classifierRef = useRef(options.classifier);
  useEffect(() => {
    observerRef.current = options.onDiagnostics;
    classifierRef.current = options.classifier;
  });

  const [state, setState] = useState<CameraInputState>("off");
  const [message, setMessage] = useState("");
  const [fix, setFix] = useState("");
  const adapterRef = useRef<BrowserCameraAdapter | BrowserHandAdapter | null>(null);

  const fail = useCallback((cause: unknown) => {
    const described = describeCameraFailure(cause);
    setState("failed");
    setMessage(described.problem);
    setFix(described.fix);
  }, []);

  const enable = useCallback(async () => {
    const runningHost = host.current;
    const element = video.current;
    if (!runningHost || !element || adapterRef.current) return;

    setState("starting");
    setMessage("");
    setFix("");

    const adapter = kind === "body"
      ? new BrowserCameraAdapter({
        video: element,
        mirror: true,
        onError: fail,
        classifier: classifierRef.current as PoseClassifierOptions | undefined,
        onDiagnostics: (diagnostics) => (observerRef.current as ((d: PoseAdapterDiagnostics) => void) | undefined)?.(diagnostics),
      })
      : new BrowserHandAdapter({
        video: element,
        mirror: true,
        onError: fail,
        classifier: classifierRef.current as HandGestureClassifierOptions | undefined,
        onDiagnostics: (diagnostics) => (observerRef.current as ((d: HandAdapterDiagnostics) => void) | undefined)?.(diagnostics),
      });
    adapterRef.current = adapter;

    try {
      await runningHost.inputBus.register(adapter);
      setState("on");
      /*
       * A camera that is taken away does not fail a call — the track simply ends. Without this a
       * revoked permission or a closed lid leaves the game showing a camera that is on, waiting for
       * movement from a player it can no longer see, with nothing on screen to explain the silence.
       */
      for (const track of (element.srcObject as MediaStream | null)?.getTracks() ?? []) {
        track.addEventListener("ended", () => {
          if (adapterRef.current !== adapter) return;
          /*
           * Release the adapter as well as reporting the loss. `enable` refuses to start while one
           * is held, so leaving it in place left the player with a camera reported as failed and a
           * button that did nothing at all when pressed — the only way back was to restart the run.
           */
          adapterRef.current = null;
          void host.current?.inputBus.unregister(adapter);
          fail(new Error("The camera stopped"));
        });
      }
    } catch (cause) {
      await runningHost.inputBus.unregister(adapter);
      adapterRef.current = null;
      fail(cause);
    }
  }, [fail, host, kind, video]);

  /*
   * If the player already set the camera up in the chooser, the game does not ask them to do it
   * again. Arriving at a game you have just spent a minute pointing a camera at, to be met by a
   * button reading ENABLE BODY CAMERA, is the setup having been for nothing.
   */
  useEffect(() => {
    if (readCameraPlan(sessionId)?.kind !== kind) return;
    let cancelled = false;
    // One frame of grace: the host is assigned in the game's own onReady, and this effect can run
    // first. Retrying rather than assuming avoids ordering that depends on which mounts sooner.
    const attempt = () => {
      if (cancelled) return;
      if (host.current) void enable();
      else requestAnimationFrame(attempt);
    };
    attempt();
    return () => { cancelled = true; };
  }, [enable, host, kind, sessionId]);

  // A new run gets a clean camera rather than an adapter registered against a host that is gone.
  useEffect(() => () => {
    adapterRef.current = null;
    setState("off");
    setMessage("");
    setFix("");
  }, [runKey]);

  const recentre = useCallback(() => {
    const adapter = adapterRef.current;
    if (adapter instanceof BrowserCameraAdapter) adapter.calibrateNeutral();
  }, []);

  return { state, message, fix, enable, recentre };
}

/**
 * What the status bar says about the camera.
 *
 * Deliberately not a measurement. "CAMERA POSE · 71%" tells a player how sure a model is, which is
 * a question they did not ask and cannot act on: at 71% they do not know whether to move, and the
 * number changes every frame whatever they do.
 */
export function cameraStatusLabel(state: CameraInputState, kind: CameraKind) {
  switch (state) {
    case "on":
      return kind === "body" ? "Camera on · watching you move" : "Camera on · watching your hands";
    case "starting":
      return "Starting the camera";
    case "failed":
      return "Camera off";
    default:
      return "";
  }
}
