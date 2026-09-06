import { POSE_LANDMARK, type PoseLandmark } from "./index.ts";

/**
 * Who is who, frame to frame.
 *
 * The pose model can now track several people, and it returns them as an unordered array with no
 * identity attached: the person at index 0 this frame is not necessarily the person who was at
 * index 0 last frame. Handing those straight to a game means player one and player two swap every
 * time they cross the room, or whenever one of them is briefly missed.
 *
 * So a person is matched to the nearest person from the previous frame, and keeps their slot until
 * they have been gone long enough to have actually left. Everything is measured at the hips, which
 * is the steadiest point on a body and the origin the metric landmarks are relative to.
 */

export interface TrackedPerson {
  /** Stable for as long as this person is present. Never reused while they are still here. */
  readonly id: number;
  /** Player one, two, three… The lowest free number, kept while they remain. */
  readonly slot: number;
  readonly landmarks: readonly PoseLandmark[];
  /** Where they are, in metres, for anything that wants to place them in the room. */
  readonly position: { x: number; z: number };
  readonly lastSeen: number;
}

export interface PersonTrackerOptions {
  /**
   * How far someone may move between frames and still be the same person, in metres. A person
   * crossing a room at speed covers well under half a metre in a frame; two people standing closer
   * together than this were never going to be told apart by position alone.
   */
  maxStep?: number;
  /**
   * How long someone may be missed before their slot is released, in milliseconds. Tracking drops a
   * frame regularly; releasing a slot on the first miss would renumber everyone constantly.
   */
  forgetAfterMs?: number;
  /** How many people to keep. Slots beyond this are not handed out. */
  maxPeople?: number;
}

export class PersonTracker {
  private readonly options: Required<PersonTrackerOptions>;
  private people: TrackedPerson[] = [];
  private nextId = 1;

  constructor(options: PersonTrackerOptions = {}) {
    this.options = {
      maxStep: options.maxStep ?? 0.6,
      forgetAfterMs: options.forgetAfterMs ?? 1_500,
      maxPeople: Math.max(1, Math.round(options.maxPeople ?? 4)),
    };
  }

  /**
   * Match this frame's poses to the people already being tracked.
   *
   * Greedy nearest-first over every pairing, which is enough at these numbers — four people is at
   * most sixteen pairs — and has the property that the most confident match is made first, so one
   * ambiguous pairing cannot displace an obvious one.
   */
  update(poses: ReadonlyArray<readonly PoseLandmark[]>, timestamp: number): TrackedPerson[] {
    const observations = poses
      .map((landmarks) => ({ landmarks, position: hips(landmarks) }))
      .filter((observation): observation is { landmarks: readonly PoseLandmark[]; position: { x: number; z: number } } =>
        observation.position !== undefined);

    const pairs: { person: number; observation: number; distance: number }[] = [];
    this.people.forEach((person, personIndex) => {
      observations.forEach((observation, observationIndex) => {
        const distance = Math.hypot(person.position.x - observation.position.x, person.position.z - observation.position.z);
        if (distance <= this.options.maxStep) pairs.push({ person: personIndex, observation: observationIndex, distance });
      });
    });
    pairs.sort((a, b) => a.distance - b.distance);

    const claimedPeople = new Set<number>();
    const claimedObservations = new Set<number>();
    const next: TrackedPerson[] = [];

    for (const pair of pairs) {
      if (claimedPeople.has(pair.person) || claimedObservations.has(pair.observation)) continue;
      claimedPeople.add(pair.person);
      claimedObservations.add(pair.observation);
      const person = this.people[pair.person]!;
      const observation = observations[pair.observation]!;
      next.push({ ...person, landmarks: observation.landmarks, position: observation.position, lastSeen: timestamp });
    }

    // Someone missed this frame keeps their slot until they have been gone long enough to have left.
    for (const [index, person] of this.people.entries()) {
      if (claimedPeople.has(index)) continue;
      if (timestamp - person.lastSeen <= this.options.forgetAfterMs) next.push(person);
    }

    // Whoever is left is new. They take the lowest free slot, so player two leaving and coming back
    // does not renumber player three.
    for (const [index, observation] of observations.entries()) {
      if (claimedObservations.has(index)) continue;
      const slot = lowestFreeSlot(next.map((person) => person.slot));
      if (slot > this.options.maxPeople) continue;
      next.push({ id: this.nextId++, slot, landmarks: observation.landmarks, position: observation.position, lastSeen: timestamp });
    }

    this.people = next.sort((a, b) => a.slot - b.slot);
    return this.people;
  }

  /** Everyone currently tracked, including anyone missed in the most recent frame. */
  current(): readonly TrackedPerson[] {
    return this.people;
  }

  reset() {
    this.people = [];
    this.nextId = 1;
  }
}

function hips(landmarks: readonly PoseLandmark[]) {
  const left = landmarks[POSE_LANDMARK.leftHip]?.world;
  const right = landmarks[POSE_LANDMARK.rightHip]?.world;
  if (!left || !right) return undefined;
  return { x: (left.x + right.x) / 2, z: (left.z + right.z) / 2 };
}

function lowestFreeSlot(taken: readonly number[]) {
  const used = new Set(taken);
  let slot = 1;
  while (used.has(slot)) slot++;
  return slot;
}

/**
 * A colour per player.
 *
 * Tracking gives everyone a stable number; a number is not something you can see across a room. When
 * four people are waving at the same camera, the only way anyone knows which silhouette is theirs is
 * that it is the blue one.
 *
 * Ordered for distinguishability rather than prettiness, and the first three are separable under the
 * common forms of colour blindness — blue, orange and white differ in lightness as well as hue, so
 * they stay distinct even where red and green do not. This lives in the vision package because it
 * describes a tracked person, and it is a game-side colour: the interface around a game is
 * monochrome, but a game drawing four bodies has to tell them apart.
 */
export const PLAYER_COLOURS = ["#3B82F6", "#F97316", "#F8FAFC", "#22C55E", "#A855F7", "#EAB308"] as const;

/** The colour for a player slot. Slots are 1-based, and it wraps rather than running out. */
export function playerColour(slot: number) {
  const index = Math.max(0, Math.round(slot) - 1);
  return PLAYER_COLOURS[index % PLAYER_COLOURS.length]!;
}
