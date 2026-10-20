/** Game-space avatar data. Camera landmarks and device tracking handles stay in integration. */
export interface AvatarJoint { x: number; y: number }
export interface GamePerson { slot: number; avatar: readonly AvatarJoint[] }
export interface GameBodyObservation { people: readonly GamePerson[] }
export type GameHandGesture = "openPalm" | "fist" | "pinch" | "point" | "twoFingers" | "grab" | "swipeLeft" | "swipeRight" | "circle";
export interface GameHandObservation {
  present: boolean;
  pointing: boolean;
  activated: readonly GameHandGesture[];
}

export function projectCameraPeople(people: readonly {
  slot: number;
  lastSeen: number;
  landmarks: readonly { x: number; y: number }[];
}[], timestamp: number): GamePerson[] {
  return people.filter((person) => person.lastSeen === timestamp).map((person) => {
    const points = person.landmarks;
    const hipX = points.length >= 25 ? (points[23]!.x + points[24]!.x) / 2 : .5;
    return { slot: person.slot, avatar: points.map((point) => ({
      x: (point.x - hipX) * 3.2, y: (1 - point.y) * 3,
    })) };
  });
}

// Original game presentation policy from packages/vision/src/people.ts at 301b0d3f.
export const PLAYER_COLOURS = ["#3B82F6", "#F97316", "#F8FAFC", "#22C55E", "#A855F7", "#EAB308"] as const;
export function playerColour(slot: number) {
  return PLAYER_COLOURS[Math.max(0, Math.round(slot) - 1) % PLAYER_COLOURS.length]!;
}
