import assert from "node:assert/strict";
import test from "node:test";

import { parseControllerLayout } from "@uynis-connect/connect";
import { CONTROLLER_PRESETS } from "../packages/link-controller/src/native-presets.ts";

test("101 supplies its universal game controller presets", () => {
  assert.deepEqual(
    CONTROLLER_PRESETS.map((preset) => preset.id),
    ["classic", "gamepad", "wand", "steering", "tilt", "touch", "trigger", "detector", "sensor-lab"],
  );
  for (const preset of CONTROLLER_PRESETS) {
    assert.deepEqual(parseControllerLayout(preset.layout), preset.layout);
  }
});

test("101 gamepad preset covers the complete supplied control layout contract", () => {
  const gamepad = CONTROLLER_PRESETS.find((preset) => preset.id === "gamepad");
  assert.ok(gamepad, "the rich contract needs a shipped native panel, not only parser tests");
  assert.equal(gamepad.layout.handedness, "right");
  assert.deepEqual(
    new Set(gamepad.layout.layout.map((element) => element.type)),
    new Set(["joystick", "shoulder", "trigger", "analog-button", "button"]),
  );
  assert.ok(gamepad.layout.layout.every((element) => element.side && element.zone && element.size && element.span));
  assert.ok(gamepad.layout.layout.some((element) => element.type === "joystick" && element.responseCurve !== 1));
  const interactions = gamepad.layout.layout.flatMap((element) =>
    (element.type === "button" || element.type === "shoulder") && element.interaction
      ? [element.interaction.type]
      : []);
  assert.deepEqual(new Set(interactions), new Set(["hold", "double-tap", "toggle", "chord"]));
});
