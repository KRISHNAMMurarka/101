import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseControllerLayout } from "@101/protocol";
import { CONTROLLER_PRESETS } from "../apps/controller-native/src/presets.ts";

test("native Link ships every universal local controller preset", () => {
  assert.deepEqual(
    CONTROLLER_PRESETS.map((preset) => preset.id),
    ["classic", "wand", "steering", "tilt", "touch", "trigger", "detector", "sensor-lab"],
  );
  for (const preset of CONTROLLER_PRESETS) {
    assert.deepEqual(parseControllerLayout(preset.layout), preset.layout);
  }
});

test("native Link configuration is local-first and declares no microphone use", async () => {
  const config = JSON.parse(await readFile(new URL("../apps/controller-native/app.json", import.meta.url), "utf8"));
  const camera = config.expo.plugins.find((entry: unknown) => Array.isArray(entry) && entry[0] === "expo-camera");
  assert.equal(camera[1].microphonePermission, false);
  assert.equal(camera[1].recordAudioAndroid, false);
  assert.ok(config.expo.android.blockedPermissions.includes("android.permission.RECORD_AUDIO"));
  assert.equal(config.expo.ios.infoPlist.NSLocalNetworkUsageDescription.includes("local network"), true);
  assert.equal(config.expo.extra.privacy, "local-first-no-telemetry");
});
