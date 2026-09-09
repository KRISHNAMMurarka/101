import assert from "node:assert/strict";
import test from "node:test";

import {
  CAMERA_FAILURE_COPY,
  CameraLostError,
  classifyCameraFailure,
  describeCameraFailure,
  type CameraFailure,
} from "./errors.ts";

/** Browsers reject camera requests with named DOMExceptions; missing API calls throw TypeError. */
function browserError(name: string, message = "") {
  return name === "TypeError" ? new TypeError(message) : new DOMException(message, name);
}

test("every failure a browser actually throws has a player sentence", () => {
  /*
   * Before this, seven surfaces each checked NotAllowedError and SecurityError by hand and fell
   * through to `cause.message` for the rest — so a denied permission read well and everything else
   * reached the player as raw browser English. "Requested device not found" is accurate and is not
   * an instruction.
   */
  const cases: ReadonlyArray<readonly [string, CameraFailure]> = [
    ["NotAllowedError", "denied"],
    ["SecurityError", "denied"],
    ["NotFoundError", "no-camera"],
    ["DevicesNotFoundError", "no-camera"],
    ["OverconstrainedError", "no-camera"],
    ["NotReadableError", "in-use"],
    ["TrackStartError", "in-use"],
    ["AbortError", "in-use"],
  ];
  for (const [name, expected] of cases) {
    assert.equal(classifyCameraFailure(browserError(name)), expected, `${name} was misread`);
  }
});

test("a camera taken away while it was working is not silence", () => {
  // A revoked permission, a closed lid and an unplugged webcam all end the track rather than failing
  // a call. Without their own error they are indistinguishable from someone who walked out of shot,
  // and the check waits forever for a person who cannot come back.
  const lost = new CameraLostError();
  assert.equal(classifyCameraFailure(lost), "in-use");
  assert.match(describeCameraFailure(lost).fix, /try again/i);
});

test("calling getUserMedia off a secure origin is told apart from a denial", () => {
  // It is undefined there, so the call throws a TypeError rather than a DOMException — telling the
  // player to allow a permission they were never asked for sends them somewhere with no answer.
  assert.equal(classifyCameraFailure(browserError("TypeError", "undefined is not a function")), "insecure-context");
  assert.match(describeCameraFailure(browserError("TypeError")).fix, /https/i);
});

test("the adapter's own unsupported and model messages are recognised", () => {
  assert.equal(classifyCameraFailure(new Error("Camera access is unavailable in this browser")), "unsupported");
  assert.equal(classifyCameraFailure(new Error("Failed to fetch the landmarker model")), "model-failed");
});

test("anything unrecognised still gets an instruction rather than a shrug", () => {
  for (const odd of [undefined, null, "", 42, new Error("something went sideways")]) {
    const described = describeCameraFailure(odd);
    assert.equal(described.failure, "unknown");
    assert.ok(described.fix.length > 12, `no instruction for ${String(odd)}`);
  }
});

test("no failure sentence uses developer vocabulary", () => {
  // The same boundary the placement copy holds: the words are next to the code that raises them, so
  // they re-acquire browser and model jargon the moment someone edits them.
  const BANNED = /error|exception|getusermedia|permission denied|dom|api|track|stream|codec|wasm|landmark|model asset/i;
  for (const [failure, copy] of Object.entries(CAMERA_FAILURE_COPY)) {
    for (const [role, sentence] of Object.entries(copy)) {
      assert.ok(sentence.length > 12, `${failure}.${role} is too short: ${sentence}`);
      assert.doesNotMatch(sentence, BANNED, `${failure}.${role} uses developer vocabulary: ${sentence}`);
      assert.match(sentence, /[.!?]$/, `${failure}.${role} is not a sentence: ${sentence}`);
    }
  }
});
