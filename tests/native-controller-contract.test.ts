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

test("native Link blocks the health permissions its sensor library would otherwise pull in", async () => {
  // expo-sensors bundles a pedometer, so ACTIVITY_RECOGNITION arrives through manifest merging
  // even though 101 only ever reads accelerometer, gyroscope, magnetometer and device motion.
  // The brief keeps health data out of normal game operation, so both are blocked explicitly and
  // the built APK was verified to declare neither.
  const config = JSON.parse(await readFile(new URL("../apps/controller-native/app.json", import.meta.url), "utf8"));
  const blocked: string[] = config.expo.android.blockedPermissions;
  for (const permission of ["android.permission.ACTIVITY_RECOGNITION", "android.permission.BODY_SENSORS"]) {
    assert.ok(blocked.includes(permission), `${permission} must stay blocked`);
  }
});

test("the watch bridge is declared for both platforms and requests no extra capability", async () => {
  const bridge = JSON.parse(await readFile(new URL("../apps/controller-native/modules/one01-watch/expo-module.config.json", import.meta.url), "utf8"));
  assert.deepEqual(bridge.platforms, ["ios", "android"]);
  assert.deepEqual(bridge.ios.modules, ["One01WatchModule"]);
  assert.deepEqual(bridge.android.modules, ["com.oneohone.link.watch.One01WatchModule"]);

  // Watch Connectivity and the Data Layer need no runtime permission. If a future edit adds one,
  // this fails rather than letting a watch feature quietly widen what 101 Link asks for.
  const gradle = await readFile(new URL("../apps/controller-native/modules/one01-watch/android/build.gradle", import.meta.url), "utf8");
  assert.equal(/uses-permission|BODY_SENSORS|RECORD_AUDIO/.test(gradle), false);
});
