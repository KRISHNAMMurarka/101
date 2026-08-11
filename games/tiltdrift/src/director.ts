import { difficultyAt, SeededRandom } from "@101/core";

export type RoadEnvironment = "city" | "tunnel" | "desert" | "neon" | "ice" | "industrial" | "space";

export interface TrafficSpawn {
  id: number;
  distance: number;
  lane: number;
  speed: number;
  kind: "car" | "drone" | "barrier";
}

export interface RoadSegment {
  id: number;
  startDistance: number;
  length: number;
  startCurve: number;
  endCurve: number;
  startX: number;
  endX: number;
  width: number;
  elevation: number;
  environment: RoadEnvironment;
  traffic: TrafficSpawn[];
}

const ENVIRONMENTS: readonly RoadEnvironment[] = ["city", "tunnel", "desert", "neon", "ice", "industrial", "space"];

export class TiltDriftDirector {
  private readonly random: SeededRandom;
  private segmentId = 0;
  private trafficId = 0;
  private previousCurve = 0;
  private previousX = 0;
  private previousEnvironment: RoadEnvironment = "city";

  constructor(seed: string) {
    this.random = new SeededRandom(seed);
  }

  next(startDistance: number): RoadSegment {
    const difficulty = difficultyAt(startDistance / 35);
    const length = this.random.range(46, 72);
    const maxCurve = Math.min(0.82, 0.28 + difficulty.tier * 0.018);
    const change = this.random.range(-0.34, 0.34);
    const endCurve = clamp(this.previousCurve + change, -maxCurve, maxCurve);
    const width = clamp(10.5 - difficulty.tier * 0.12 + this.random.range(-0.8, 1.15), 6.4, 12);
    const environment = this.segmentId % 5 === 0 && this.random.next() < 0.68
      ? this.random.pick(ENVIRONMENTS.filter((value) => value !== this.previousEnvironment))
      : this.previousEnvironment;
    const endX = this.previousX + ((this.previousCurve + endCurve) / 2) * length * 0.34;
    const trafficCount = Math.min(4, Math.floor(this.random.range(0, 1.2 + difficulty.density * 4)));
    const traffic: TrafficSpawn[] = [];
    for (let index = 0; index < trafficCount; index += 1) {
      traffic.push({
        id: ++this.trafficId,
        distance: startDistance + length * ((index + 1) / (trafficCount + 1)),
        lane: this.random.pick([-0.72, -0.36, 0, 0.36, 0.72]),
        speed: this.random.range(10, 25 + difficulty.tier * 0.35),
        kind: this.random.next() < 0.13 + difficulty.modifierChance * 0.1 ? "barrier" : this.random.next() < 0.22 ? "drone" : "car",
      });
    }
    const segment: RoadSegment = {
      id: ++this.segmentId,
      startDistance,
      length,
      startCurve: this.previousCurve,
      endCurve,
      startX: this.previousX,
      endX,
      width,
      elevation: this.random.range(-0.45, 0.45),
      environment,
      traffic,
    };
    this.previousCurve = endCurve;
    this.previousX = endX;
    this.previousEnvironment = environment;
    return segment;
  }
}

export function roadCenterAt(segment: RoadSegment, distance: number) {
  const amount = clamp((distance - segment.startDistance) / segment.length, 0, 1);
  const eased = amount * amount * (3 - 2 * amount);
  return segment.startX + (segment.endX - segment.startX) * eased;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
