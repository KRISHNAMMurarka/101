import { difficultyAt, SeededRandom } from "@101/core";

export type CrewRoleId = "pilot" | "weapons" | "shields" | "reactor";
export type OrbitalEventKind = "asteroids" | "drones" | "storm" | "pirates" | "reactor-failure" | "anomaly" | "boss";

export interface OrbitalEvent {
  id: number;
  kind: OrbitalEventKind;
  label: string;
  startAt: number;
  duration: number;
  severity: number;
  bearing: number;
  requiredRoles: readonly CrewRoleId[];
  progress: number;
  resolved: boolean;
  success: boolean;
}

const EVENT_LABELS: Record<OrbitalEventKind, string> = {
  asteroids: "ASTEROID LATTICE",
  drones: "DRONE INTERCEPT",
  storm: "ION STORM FRONT",
  pirates: "PIRATE AMBUSH",
  "reactor-failure": "REACTOR CASCADE",
  anomaly: "NAVIGATION ANOMALY",
  boss: "DREADNOUGHT CONTACT",
};

const EVENT_ROLES: Record<OrbitalEventKind, readonly CrewRoleId[]> = {
  asteroids: ["pilot", "shields"],
  drones: ["weapons"],
  storm: ["shields", "reactor"],
  pirates: ["pilot", "weapons"],
  "reactor-failure": ["reactor"],
  anomaly: ["pilot", "reactor"],
  boss: ["pilot", "weapons", "shields", "reactor"],
};

export class OrbitalDirector {
  private readonly random: SeededRandom;
  private eventId = 0;

  constructor(seed: string) {
    this.random = new SeededRandom(seed);
  }

  next(previousStart: number): OrbitalEvent {
    const difficulty = difficultyAt(previousStart / 32);
    const available: OrbitalEventKind[] = ["asteroids", "drones", "storm"];
    if (difficulty.tier >= 1) available.push("pirates", "reactor-failure");
    if (difficulty.tier >= 2) available.push("anomaly");
    const nextId = this.eventId + 1;
    const kind: OrbitalEventKind = nextId % 10 === 0 && difficulty.tier >= 2 ? "boss" : this.random.pick(available);
    const duration = Math.max(5.2, this.random.range(7.2, 10.4) - difficulty.tier * 0.12);
    const overlapping = difficulty.tier >= 2 && this.random.next() < Math.min(.58, difficulty.density);
    const gap = previousStart === 0
      ? 3.5
      : overlapping
        ? duration * this.random.range(.5, .72)
        : duration + this.random.range(1.4, 3.5);
    this.eventId = nextId;
    return {
      id: nextId,
      kind,
      label: EVENT_LABELS[kind],
      startAt: previousStart + gap,
      duration,
      severity: Math.min(1, .3 + difficulty.tier * .035 + this.random.range(0, .24)),
      bearing: this.random.range(-Math.PI, Math.PI),
      requiredRoles: EVENT_ROLES[kind],
      progress: 0,
      resolved: false,
      success: false,
    };
  }
}

export function validateOrbitalEvent(event: OrbitalEvent, previousStart: number) {
  return event.startAt > previousStart
    && event.duration >= 5.2
    && event.duration <= 10.5
    && event.severity >= .3
    && event.severity <= 1
    && event.requiredRoles.length > 0
    && new Set(event.requiredRoles).size === event.requiredRoles.length;
}
