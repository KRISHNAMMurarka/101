"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  requestCameraSession,
  type CameraSession,
  describeCameraFailure,
  cameraConstraints,
  listCameras,
  type HandAdapterDiagnostics,
  type PoseAdapterDiagnostics,
} from "@uynis-connect/connect";
import { TRACKING_PROFILES, type HandGestureClassifierOptions, type PoseClassifierOptions } from "@uynis-connect/connect";
import type { GameHost101 } from "@101/game-host";
import { createSensorMapping } from "../../packages/input/src/sensor-mapping.ts";
import { projectCameraPeople, type GameBodyObservation, type GameHandObservation } from "./camera-projection.ts";

import { cameraRequested, readCameraPlan, resolveCameraPreferences, type CameraKind } from "./camera-plan.ts";

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
  /** Supported ceiling; a successful setup may select fewer people. */
  maxPeople?: number;
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
    onDiagnostics?(diagnostics: GameBodyObservation): void;
  })
  | (CommonOptions & {
    kind: "hands";
    classifier?: HandGestureClassifierOptions;
    onDiagnostics?(diagnostics: GameHandObservation): void;
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
  const { kind, sessionId, video, host, runKey, maxPeople = 1 } = options;
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
  type CameraLease = { session: CameraSession; retire(): void };
  const leaseRef = useRef<CameraLease | null>(null);
  const generationRef = useRef(0);
  const pendingRef = useRef(false);

  const fail = useCallback((cause: unknown) => {
    const described = describeCameraFailure(cause);
    setState("failed");
    setMessage(described.problem);
    setFix(described.fix);
  }, []);

  const release = useCallback(async (lease: CameraLease) => {
    if (leaseRef.current === lease) leaseRef.current = null;
    lease.retire();
    await lease.session.close();
  }, []);

  const enable = useCallback(async () => {
    const runningHost = host.current;
    const element = video.current;
    if (!runningHost || !element || leaseRef.current || pendingRef.current) return;
    const generation = ++generationRef.current;
    pendingRef.current = true;
    setState("starting");
    setMessage("");
    setFix("");
    const cameras = await listCameras();
    if (generation !== generationRef.current) return;
    const preferences = resolveCameraPreferences(kind, readCameraPlan(sessionId), cameras, maxPeople);
    const failRun = (cause: unknown) => {
      if (generation !== generationRef.current) return;
      ++generationRef.current;
      pendingRef.current = false;
      void release(lease).catch(() => {});
      fail(cause);
    };
    const mapping = createSensorMapping({
      scopeId: `camera-${kind}-${sessionId}-${generation}`,
      players: Array.from({ length: preferences.maxPeople ?? 1 }, (_, index) => `player-${index + 1}`),
      emit: (frame) => runningHost.inputBus.accept(frame),
      removeDevice: (id) => runningHost.inputBus.removeDevice(id),
    });
    const common = { preview: element, mirror: preferences.mirror,
      constraints: cameraConstraints(preferences.deviceId), onError: failRun };
    const session = kind === "body"
      ? requestCameraSession({ ...common, kind: "body", maxPeople: preferences.maxPeople,
        quality: Object.values(TRACKING_PROFILES).find((profile) => profile.poseModel === preferences.poseModel)?.quality,
        classifier: classifierRef.current as PoseClassifierOptions | undefined,
        onObservation: (observation: PoseAdapterDiagnostics) => {
          if (generation === generationRef.current) (observerRef.current as ((d: GameBodyObservation) => void) | undefined)?.({
            people: projectCameraPeople(observation.people, observation.frame.timestamp),
          });
        } })
      : requestCameraSession({ ...common, kind: "hands", classifier: classifierRef.current as HandGestureClassifierOptions | undefined,
        onObservation: (observation: HandAdapterDiagnostics) => {
          if (generation === generationRef.current) (observerRef.current as ((d: GameHandObservation) => void) | undefined)?.({
            present: Boolean(observation.signals.hand), pointing: Boolean(observation.signals.gestures.point), activated: [...observation.signals.activated],
          });
        } });
    const owner = `camera-${kind}-${sessionId}-${generation}`;
    session.subscribe(mapping.accept);
    session.onStatus((status) => {
      runningHost.inputBus.setSourceAvailability(owner, kind === "body" ? "camera-pose" : "camera-hand", status === "active");
      runningHost.refreshInputReadiness();
      if (["denied", "lost", "closed"].includes(status)) mapping.close();
    });
    const lease: CameraLease = { session, retire: () => {
      mapping.close();
      runningHost.inputBus.setSourceAvailability(owner, kind === "body" ? "camera-pose" : "camera-hand", false);
      runningHost.refreshInputReadiness();
    } };
    leaseRef.current = lease;
    // Keep the preview consistent with the remembered input orientation. The shared preview CSS
    // assumes mirroring by default, so an explicitly unmirrored plan needs to override it.
    element.style.setProperty("transform", preferences.mirror ? "scaleX(-1)" : "none");
    try {
      await session.ready;
      if (generation !== generationRef.current) { await release(lease); return; }
      pendingRef.current = false;
      setState("on");
    } catch (cause) {
      await release(lease);
      if (generation !== generationRef.current) return;
      pendingRef.current = false;
      fail(cause);
    }
  }, [fail, host, kind, maxPeople, release, sessionId, video]);

  const stopCurrent = useCallback(() => {
    ++generationRef.current;
    pendingRef.current = false;
    const lease = leaseRef.current;
    if (lease) void release(lease).catch(() => {});
  }, [release]);

  // A prior plan supplies preferences only. Opening the camera automatically also requires this
  // visit's explicit camera=body/hands choice. One cancellable frame waits for the game host.
  useEffect(() => {
    let cancelled = false;
    let frame: number | undefined;
    const attempt = () => {
      if (cancelled) return;
      if (host.current && video.current) void enable();
      else frame = requestAnimationFrame(attempt);
    };
    // Reset in the effect's scheduled work, avoiding state updates during unmount or effect cleanup.
    frame = requestAnimationFrame(() => {
      if (cancelled) return;
      setState("off");
      setMessage("");
      setFix("");
      if (cameraRequested(window.location.search, kind)) attempt();
    });
    return () => {
      cancelled = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      stopCurrent();
    };
  }, [enable, host, kind, runKey, sessionId, stopCurrent, video]);

  const recentre = useCallback(() => {
    leaseRef.current?.session.calibrate();
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
