import { POSE_LANDMARK, type PoseLandmark } from "./index.ts";

/**
 * Real body geometry, from the metric landmarks.
 *
 * Everything the pose classifier knew — duck, jump, lean, step, arms raised — was measured in image
 * space, where a shoulder moving towards the camera and a shoulder moving down are the same
 * observation. That is why it could not tell turning from shrinking, or a bent knee from a knee
 * further away.
 *
 * `world` landmarks are in metres relative to the midpoint of the hips, and the model has always
 * produced them; the adapter used to discard them. With those, a joint angle is an angle and a
 * facing direction is a direction, so the questions a game actually wants to ask — is this person
 * turned away, are they crouching, is that arm extended, are they lying down — have real answers.
 */

export interface Vec3 { x: number; y: number; z: number }

export type Posture = "standing" | "crouching" | "sitting" | "lying" | "unknown";

export interface JointAngles {
  /** Radians. π is a straight limb; smaller is more bent. */
  leftElbow: number;
  rightElbow: number;
  leftKnee: number;
  rightKnee: number;
  /** Angle between the upper arm and the torso: 0 is arm down, π/2 is straight out. */
  leftShoulder: number;
  rightShoulder: number;
}

export interface SkeletonSignals {
  /** Which way the chest points, radians, 0 facing the camera and positive turning to their left. */
  facing: number;
  /** Lean from vertical, radians. Positive is forward. */
  tilt: number;
  /** Roll of the shoulder line, radians. Positive drops their right shoulder. */
  roll: number;
  posture: Posture;
  joints: JointAngles;
  /** 0 tucked in, 1 fully extended. Useful without needing a threshold on an angle. */
  leftArmReach: number;
  rightArmReach: number;
  /** Distance between the ankles in metres — the measurement a stride is made of. */
  stance: number;
  /** Standing height from hips to head, in metres. Falls as someone crouches or sits. */
  uprightness: number;
}

function angleAt(a: Vec3, vertex: Vec3, b: Vec3) {
  const u = { x: a.x - vertex.x, y: a.y - vertex.y, z: a.z - vertex.z };
  const v = { x: b.x - vertex.x, y: b.y - vertex.y, z: b.z - vertex.z };
  const lengthU = Math.hypot(u.x, u.y, u.z);
  const lengthV = Math.hypot(v.x, v.y, v.z);
  if (lengthU === 0 || lengthV === 0) return Math.PI;
  const cosine = (u.x * v.x + u.y * v.y + u.z * v.z) / (lengthU * lengthV);
  return Math.acos(Math.max(-1, Math.min(1, cosine)));
}

const midpoint = (a: Vec3, b: Vec3): Vec3 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });

/**
 * Read the skeleton, or report that it cannot be read.
 *
 * Returns undefined rather than a guess when the metric landmarks are absent — which is every frame
 * from a backend that does not produce them, and every frame where the body is out of shot. A caller
 * that gets an answer knows it was measured.
 */
export function readSkeleton(landmarks: readonly PoseLandmark[]): SkeletonSignals | undefined {
  const at = (index: number) => landmarks[index]?.world;
  const leftShoulder = at(POSE_LANDMARK.leftShoulder);
  const rightShoulder = at(POSE_LANDMARK.rightShoulder);
  const leftHip = at(POSE_LANDMARK.leftHip);
  const rightHip = at(POSE_LANDMARK.rightHip);
  if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) return undefined;

  const shoulders = midpoint(leftShoulder, rightShoulder);
  const hips = midpoint(leftHip, rightHip);

  // The shoulder line's bearing in the floor plane is the direction the chest points.
  const across = { x: leftShoulder.x - rightShoulder.x, z: leftShoulder.z - rightShoulder.z };
  const facing = Math.atan2(across.z, across.x);

  // The spine, as a vector. In MediaPipe's world frame, y grows downward.
  const spine = { x: shoulders.x - hips.x, y: shoulders.y - hips.y, z: shoulders.z - hips.z };
  const spineLength = Math.hypot(spine.x, spine.y, spine.z);
  const tilt = spineLength === 0 ? 0 : Math.atan2(spine.z, -spine.y);
  const roll = Math.atan2(leftShoulder.y - rightShoulder.y, Math.hypot(leftShoulder.x - rightShoulder.x, leftShoulder.z - rightShoulder.z));

  const nose = at(POSE_LANDMARK.nose);
  const uprightness = nose ? Math.abs(nose.y - hips.y) : spineLength;

  const leftAnkle = at(POSE_LANDMARK.leftAnkle);
  const rightAnkle = at(POSE_LANDMARK.rightAnkle);
  const stance = leftAnkle && rightAnkle
    ? Math.hypot(leftAnkle.x - rightAnkle.x, leftAnkle.z - rightAnkle.z)
    : 0;

  const joints: JointAngles = {
    leftElbow: jointOr(at(POSE_LANDMARK.leftShoulder), at(POSE_LANDMARK.leftElbow), at(POSE_LANDMARK.leftWrist)),
    rightElbow: jointOr(at(POSE_LANDMARK.rightShoulder), at(POSE_LANDMARK.rightElbow), at(POSE_LANDMARK.rightWrist)),
    leftKnee: jointOr(at(POSE_LANDMARK.leftHip), at(POSE_LANDMARK.leftKnee), at(POSE_LANDMARK.leftAnkle)),
    rightKnee: jointOr(at(POSE_LANDMARK.rightHip), at(POSE_LANDMARK.rightKnee), at(POSE_LANDMARK.rightAnkle)),
    leftShoulder: jointOr(hips, leftShoulder, at(POSE_LANDMARK.leftElbow)),
    rightShoulder: jointOr(hips, rightShoulder, at(POSE_LANDMARK.rightElbow)),
  };

  return {
    facing,
    tilt,
    roll,
    posture: readPosture({ spineLength, uprightness, tilt, knees: [joints.leftKnee, joints.rightKnee] }),
    joints,
    leftArmReach: reach(leftShoulder, at(POSE_LANDMARK.leftElbow), at(POSE_LANDMARK.leftWrist)),
    rightArmReach: reach(rightShoulder, at(POSE_LANDMARK.rightElbow), at(POSE_LANDMARK.rightWrist)),
    stance,
    uprightness,
  };
}

function jointOr(a: Vec3 | undefined, vertex: Vec3 | undefined, b: Vec3 | undefined) {
  // A missing joint reads as straight rather than as bent: an unseen limb must not fire a gesture.
  return a && vertex && b ? angleAt(a, vertex, b) : Math.PI;
}

/**
 * How far an arm is extended, 0 to 1.
 *
 * The ratio of shoulder-to-wrist distance against the arm's own segment lengths, so it is the same
 * number for a tall player and a short one — which a raw distance is not.
 */
function reach(shoulder: Vec3, elbow: Vec3 | undefined, wrist: Vec3 | undefined) {
  if (!elbow || !wrist) return 0;
  const upper = Math.hypot(elbow.x - shoulder.x, elbow.y - shoulder.y, elbow.z - shoulder.z);
  const fore = Math.hypot(wrist.x - elbow.x, wrist.y - elbow.y, wrist.z - elbow.z);
  const span = Math.hypot(wrist.x - shoulder.x, wrist.y - shoulder.y, wrist.z - shoulder.z);
  const full = upper + fore;
  return full === 0 ? 0 : Math.max(0, Math.min(1, span / full));
}

function readPosture(input: { spineLength: number; uprightness: number; tilt: number; knees: number[] }): Posture {
  const { uprightness, spineLength, tilt, knees } = input;
  if (spineLength === 0) return "unknown";

  // Lying down is a torso that is no longer vertical, whatever the legs are doing.
  if (Math.abs(tilt) > 1.0) return "lying";

  const bentKnees = knees.filter((angle) => angle < 2.0).length;
  // Sitting and crouching differ by how far the head has dropped, not by the knees, which look the
  // same in both.
  if (bentKnees >= 2) return uprightness < spineLength * 0.85 ? "crouching" : "sitting";
  return "standing";
}
