import type { InputFrame, InputSource, InputVector } from "./index.ts";

/** Structural public SDK observation. This module owns all game meanings. */
export interface SensorObservation {
  deviceId: string;
  sequence: number;
  timestamp: number;
  source: string;
  subject?: { id: number; slot: number };
  actions: Record<string, boolean | number>;
  axes?: Record<string, number>;
  vectors?: Record<string, InputVector>;
  poses?: Record<string, readonly number[]>;
}

export function createSensorMapping(options: {
  scopeId: string;
  players: readonly string[];
  emit(frame: InputFrame): void;
  removeDevice(deviceId: string): void;
}) {
  let closed = false;
  const sources = new Map<string, { sequence: number; output: number; deviceId: string }>();
  return {
    accept(observation: SensorObservation) {
      if (closed || !Number.isSafeInteger(observation.sequence) || observation.sequence < 0) return;
      const playerId = options.players[(observation.subject?.slot ?? 1) - 1];
      if (!playerId) return;
      const key = JSON.stringify([observation.source, observation.deviceId]);
      const previous = sources.get(key);
      if (previous && observation.sequence <= previous.sequence) return;
      const mapped = mapSensorObservation(observation);
      if (!mapped) return;
      const deviceId = `sensor:${JSON.stringify([options.scopeId, observation.source, observation.deviceId])}`;
      const output = (previous?.output ?? 0) + 1;
      sources.set(key, { sequence: observation.sequence, output, deviceId });
      options.emit({ ...mapped, deviceId, playerId, sequence: output, timestamp: observation.timestamp });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const { deviceId } of sources.values()) options.removeDevice(deviceId);
      sources.clear();
    },
  };
}

export function mapSensorObservation(frame: SensorObservation):
  Pick<InputFrame, "source" | "actions" | "axes" | "vectors" | "poses"> | undefined {
  const a = frame.actions;
  const axes = frame.axes ?? {};
  const vectors = frame.vectors ?? {};
  if (frame.source === "camera-pose") {
    const actions: InputFrame["actions"] = {};
    for (const name of ["standing", "duck", "jump", "leanLeft", "leanRight", "stepLeft", "stepRight", "armsRaised", "punch"]) {
      actions[name] = a[name] ?? false;
    }
    Object.assign(actions, {
      "combat.punchLeft": a.punchLeft ?? false, "combat.punchRight": a.punchRight ?? false,
      "combat.block": a.guard ?? false, "combat.duck": a.duck ?? false,
      "combat.jump": a.jump ?? false, "combat.special": a.armsRaisedEdge ?? false,
    });
    return { source: "camera-pose", actions,
      axes: { bodyX: axes.bodyX ?? 0, dodgeX: axes.bodyX ?? 0, lean: axes.lean ?? 0,
        crouch: axes.crouch ?? 0, lift: axes.lift ?? 0 },
      vectors: { body: vectors.body ?? { x: 0, y: 0 }, bodyLean: vectors.bodyLean ?? { x: 0, y: 0 },
        "combat.move": vectors.body ?? { x: 0, y: 0 } },
      // The game needs presence, never the raw skeleton.
      poses: { body: frame.poses?.body?.length ? [1] : [] } };
  }
  if (frame.source === "camera-hand") {
    const actions: InputFrame["actions"] = {};
    for (const name of ["openPalm", "fist", "pinch", "point", "twoFingers", "grab", "swipeLeft", "swipeRight", "circle"]) {
      actions[`hand.${name}`] = a[`hand.${name}`] ?? false;
    }
    Object.assign(actions, {
      "spell.cast.shield": a["hand.openPalmEdge"] ?? false,
      "spell.cast.grab": a["hand.pinchEdge"] ?? false,
      "spell.cast.projectile": a["hand.twoFingersEdge"] ?? false,
      "spell.cast.charge": a["hand.fistEdge"] ?? false,
      "spell.cast.blade": Boolean(a["hand.swipeLeft"] || a["hand.swipeRight"]),
      "spell.cast.vortex": a["hand.circle"] ?? false,
      "swarm.select": Boolean(a["hand.point"] || a["hand.pinchEdge"]),
      "swarm.ability.pulse": a["hand.openPalmEdge"] ?? false,
      "swarm.ability.recall": a["hand.fistEdge"] ?? false,
    });
    return { source: "camera-hand", actions, axes: { ...axes },
      vectors: { hand: vectors.hand ?? { x: 0, y: 0 }, aim: vectors.aim ?? { x: 0, y: 0 },
        "swarm.command": vectors.aim ?? { x: 0, y: 0 }, gesture: vectors.gesture ?? { x: 0, y: 0 } } };
  }
  if (frame.source === "phone-motion") {
    return { source: "phone-motion", actions: { shake: a.shake ?? false, swing: a.swing ?? false,
      slash: a.swing ?? false, spin: a.spin ?? false }, axes: { ...axes, steer: axes.tiltX ?? 0 },
      vectors: { tilt: vectors.tilt ?? { x: 0, y: 0 } } };
  }
  if (frame.source === "watch-motion") {
    return { source: "watch-motion" satisfies InputSource, actions: { ...a }, axes: { ...axes }, vectors: { ...vectors } };
  }
  return undefined;
}
