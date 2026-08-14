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

test("iOS builds Expo modules from source so they actually register at runtime", async () => {
  // Expo's precompiled modules are enabled by default for iOS in SDK 57. With them on, this app
  // shipped ExpoModulesCore as a dynamic XCFramework while the module classes linked statically
  // into the main binary, and every module failed to register: the app died on launch with
  // "Cannot find native module 'ExpoAsset'" before rendering a single frame, in both Debug and
  // Release. Autolinking was correct throughout — `expo-modules-autolinking verify` passed — so
  // nothing upstream of the linker was at fault.
  //
  // Turning precompilation off makes the linkage consistent and the app starts. It costs slower
  // clean builds, which is a fair price for an app that runs. See docs/native-link.md.
  const config = JSON.parse(await readFile(new URL("../apps/controller-native/app.json", import.meta.url), "utf8"));
  const buildProperties = config.expo.plugins.find((entry: unknown) => Array.isArray(entry) && entry[0] === "expo-build-properties");
  assert.ok(buildProperties, "expo-build-properties must stay configured");
  assert.equal(buildProperties[1].ios?.usePrecompiledModules, false, "iOS Expo modules must build from source");
});

test("Android motion is not gated on a permission the app deliberately blocks", async () => {
  // expo-sensors' DeviceMotion asks for ACTIVITY_RECOGNITION on Android API 29+, because that
  // module also fronts pedometer data. 101 blocks that permission, so requesting it can only ever
  // be denied — which left Android motion controls permanently dead until an emulator run caught
  // it. Android sensors need no runtime permission at all, so the request is skipped there.
  const source = await readFile(new URL("../apps/controller-native/src/motion-controller.ts", import.meta.url), "utf8");
  const config = JSON.parse(await readFile(new URL("../apps/controller-native/app.json", import.meta.url), "utf8"));

  assert.ok(config.expo.android.blockedPermissions.includes("android.permission.ACTIVITY_RECOGNITION"));
  assert.match(source, /requestPermissionsAsync/, "iOS still requests motion permission");
  assert.match(source, /Platform\.OS === "ios"/, "the request must be gated to the platform that needs it");
  // The request has to sit behind that gate, not run unconditionally.
  const gated = /if \(motionPermissionRequired\(\)\) \{[\s\S]*?requestPermissionsAsync[\s\S]*?\}/.test(source);
  assert.ok(gated, "the permission request must be inside the platform gate");
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

test("a keychain failure cannot silently disable the whole controller", async () => {
  // Device identity gates the session, deep links, Connect and motion. It used to be three
  // unguarded awaits inside a `void`, so one keychain error left the app inert with nothing on
  // screen: buttons did nothing and "Motion on" reported success against a controller that was
  // never constructed. Identity must degrade to an in-memory id rather than take the app down.
  const source = await readFile(new URL("../apps/controller-native/App.tsx", import.meta.url), "utf8");
  const start = source.indexOf("let cancelled = false;");
  assert.ok(start > 0, "the identity effect must still exist");
  const effect = source.slice(start, source.indexOf("}, []);", start));

  assert.match(effect, /try\s*{[\s\S]*getItemAsync/, "reading the stored id must be guarded");
  assert.match(effect, /catch/, "a keychain failure must be caught rather than rejecting into void");
  assert.match(effect, /setDeviceId\(id\)/, "an id is always set, so the app still runs");
  // The fallback id must be generated outside the storage call, or a throw skips it entirely.
  assert.match(effect, /id = `link-\$\{Crypto\.randomUUID\(\)\}`/);
});

test("two thumbs can hold a stick and press a button at the same time", async () => {
  // React Native has exactly one responder for the whole app, and PanResponder's default answer to
  // `onResponderTerminationRequest` is `true` — see
  // node_modules/react-native/Libraries/Interaction/PanResponder.js, which returns `true` whenever
  // `config.onPanResponderTerminationRequest == null`. Every pad here used that default, so a
  // Pressable button claiming the responder terminated the stick and `onPanResponderTerminate`
  // snapped its vector to neutral. Holding a stick and pressing a button — the entire premise of
  // the landscape two-thumb layout — was impossible.
  //
  // The fix is two-sided and both halves are required: pads refuse to hand over the responder, and
  // buttons stop asking for it by using raw touch events, which are delivered to the view under
  // the finger without any responder negotiation.
  const source = await readFile(new URL("../apps/controller-native/src/controls.tsx", import.meta.url), "utf8");

  const refusals = source.match(/onPanResponderTerminationRequest: \(\) => false/g) ?? [];
  assert.equal(refusals.length, 2, "both the vector pad and the slider must refuse termination");

  assert.equal(/<Pressable/.test(source), false,
    "a control that joins the responder system steals it from a held stick");
  assert.match(source, /onTouchStart=\{press\}/, "buttons press on raw touch");
  assert.match(source, /onTouchEnd=\{lift\}/, "buttons must release");
  assert.match(source, /onTouchCancel=\{lift\}/,
    "a cancelled touch must release too, or the action latches on forever");

  // A button is still a button to a screen reader even though it is no longer a Pressable.
  assert.match(source, /accessibilityRole="button"/);
});

test("expo-dev-client stays out of production dependencies", async () => {
  // It is a development tool. On iOS it also registers an AppDelegate subscriber that claims
  // incoming URLs before React Native sees them, so shipping it is both bloat and a hazard.
  const pkg = JSON.parse(await readFile(new URL("../apps/controller-native/package.json", import.meta.url), "utf8"));
  assert.equal("expo-dev-client" in (pkg.dependencies ?? {}), false, "dev-client must not be a production dependency");
  assert.ok("expo-dev-client" in (pkg.devDependencies ?? {}), "dev builds still need it");
});

test("secure storage can never fail a pairing or drop a deep link", async () => {
  // expo-secure-store is keychain-backed on iOS and throws "KeyChainException: A required
  // entitlement isn't present" wherever the app has no keychain entitlement — including any build
  // made with signing disabled. Three unguarded calls turned that into: the launch URL being
  // dropped one line after it was read, a successful connection being reported as failed, and
  // disconnect throwing. Persistence is a convenience and must never gate the link.
  const source = await readFile(new URL("../apps/controller-native/App.tsx", import.meta.url), "utf8");

  for (const helper of ["rememberPairing", "forgetPairing", "readSavedPairing"]) {
    assert.match(source, new RegExp(`async function ${helper}`), `${helper} must exist`);
  }
  // Outside those helpers and the identity effect, nothing may touch SecureStore directly.
  const body = source.slice(source.indexOf("export default function App"), source.indexOf("async function rememberPairing"));
  const direct = [...body.matchAll(/SecureStore\.\w+/g)].map((match) => match[0]);
  assert.deepEqual(direct, ["SecureStore.getItemAsync", "SecureStore.setItemAsync"],
    "only the guarded identity effect may call SecureStore directly");

  const config = JSON.parse(await readFile(new URL("../apps/controller-native/app.json", import.meta.url), "utf8"));
  assert.ok(config.expo.ios.entitlements?.["keychain-access-groups"]?.length,
    "signed builds need a keychain entitlement for secure storage to work at all");
});
