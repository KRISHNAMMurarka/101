import { Game101 } from "@101/sdk";
import { roadCenterAt, TiltDriftDirector, type RoadEnvironment, type RoadSegment } from "./director.ts";

export interface ActiveTraffic {
  id: number;
  distance: number;
  lane: number;
  speed: number;
  kind: "car" | "drone" | "barrier";
  hit: boolean;
}

export interface TiltDriftState {
  seed: string;
  director: TiltDriftDirector;
  segments: RoadSegment[];
  traffic: ActiveTraffic[];
  distance: number;
  speed: number;
  lateral: number;
  lateralVelocity: number;
  roadCenter: number;
  roadWidth: number;
  environment: RoadEnvironment;
  integrity: number;
  boost: number;
  score: number;
  combo: number;
  driftAmount: number;
  gameOver: boolean;
  lastEvent: string;
}

export function createTiltDriftGame(seed = "tiltdrift-101") {
  return Game101.define<TiltDriftState>({
    id: "tiltdrift",
    initialState: () => {
      const director = new TiltDriftDirector(seed);
      const first = director.next(0);
      return {
        seed,
        director,
        segments: [first],
        traffic: first.traffic.map((traffic) => ({ ...traffic, hit: false })),
        distance: 0,
        speed: 27,
        lateral: 0,
        lateralVelocity: 0,
        roadCenter: 0,
        roadWidth: first.width,
        environment: first.environment,
        integrity: 100,
        boost: 100,
        score: 0,
        combo: 0,
        driftAmount: 0,
        gameOver: false,
        lastEvent: "GRID READY",
      };
    },
    start(ctx) {
      ["steer", "boost", "brake", "drift"].forEach((control) => ctx.input.bind(control));
    },
    update(ctx, delta) {
      const state = ctx.state;
      if (state.gameOver) return;
      const steer = clamp(ctx.input.axis("steer"));
      const boostPressure = Math.max(actionPressure(ctx.input.action("boost")), actionPressure(ctx.input.action("buttonA")));
      const brakePressure = actionPressure(ctx.input.action("brake"));
      const drifting = Boolean(ctx.input.action("drift")) || Boolean(ctx.input.action("buttonB"));
      const cruiseSpeed = 43 + Math.min(17, state.distance / 900);
      const poweredBoost = state.boost > 0 ? boostPressure : 0;
      const boostedSpeed = cruiseSpeed + (64 - cruiseSpeed) * poweredBoost;
      const desiredSpeed = boostedSpeed + (18 - boostedSpeed) * brakePressure;
      state.speed += (desiredSpeed - state.speed) * Math.min(1, delta * (1.7 + brakePressure * 3.3));
      if (boostPressure > 0 && state.boost > 0) {
        state.boost = Math.max(0, state.boost - delta * 24 * boostPressure);
        state.lastEvent = "BOOST BURN";
      } else {
        state.boost = Math.min(100, state.boost + delta * 7);
      }

      const steeringForce = steer * (drifting ? 18 : 12.5) * (0.65 + state.speed / 70);
      state.lateralVelocity += steeringForce * delta;
      state.lateralVelocity *= Math.pow(drifting ? 0.88 : 0.72, delta * 10);
      state.lateral += state.lateralVelocity * delta;
      state.driftAmount += ((drifting ? Math.abs(state.lateralVelocity) : 0) - state.driftAmount) * Math.min(1, delta * 5);
      if (drifting && state.driftAmount > 1.4) {
        state.score += Math.round(state.driftAmount * delta * 20);
        state.combo = Math.min(99, state.combo + delta * 0.8);
        state.lastEvent = "DRIFT CHAIN";
      } else {
        state.combo = Math.max(0, state.combo - delta * 0.4);
      }

      state.distance += state.speed * delta;
      state.score += Math.round(state.speed * delta * (1 + state.combo * 0.08));
      extendRoad(state);
      const segment = segmentAt(state.segments, state.distance) ?? state.segments[0]!;
      state.roadCenter = roadCenterAt(segment, state.distance);
      state.roadWidth = segment.width;
      state.environment = segment.environment;

      const roadLimit = segment.width * 0.43;
      if (Math.abs(state.lateral) > roadLimit) {
        state.speed *= Math.pow(0.5, delta);
        state.integrity = Math.max(0, state.integrity - delta * 7);
        state.lastEvent = "EDGE FRICTION";
      }

      for (const traffic of state.traffic) {
        if (traffic.kind !== "barrier") traffic.distance += traffic.speed * delta;
        if (traffic.hit || Math.abs(traffic.distance - state.distance) > 2.6) continue;
        const trafficX = traffic.lane * segment.width * 0.42;
        if (Math.abs(trafficX - state.lateral) < 1.15) {
          traffic.hit = true;
          state.integrity = Math.max(0, state.integrity - (traffic.kind === "barrier" ? 34 : 22));
          state.speed *= 0.58;
          state.combo = 0;
          state.lastEvent = "IMPACT";
        }
      }
      state.traffic = state.traffic.filter((traffic) => traffic.distance > state.distance - 35 && !traffic.hit);
      state.segments = state.segments.filter((road) => road.startDistance + road.length > state.distance - 80);
      if (state.integrity <= 0) state.gameOver = true;
    },
  });
}

function extendRoad(state: TiltDriftState) {
  let last = state.segments[state.segments.length - 1]!;
  while (last.startDistance + last.length < state.distance + 650) {
    const next = state.director.next(last.startDistance + last.length);
    state.segments.push(next);
    state.traffic.push(...next.traffic.map((traffic) => ({ ...traffic, hit: false })));
    last = next;
  }
}

function segmentAt(segments: RoadSegment[], distance: number) {
  return segments.find((segment) => distance >= segment.startDistance && distance < segment.startDistance + segment.length);
}

function clamp(value: number) {
  return Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
}

function actionPressure(value: boolean | number) {
  if (typeof value === "boolean") return Number(value);
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

export default createTiltDriftGame();
