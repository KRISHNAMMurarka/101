import assert from "node:assert/strict";
import test from "node:test";
import { cameraConstraints, describeCamera, listCameras } from "./index.ts";

const device = (label: string, kind: MediaDeviceKind = "videoinput"): MediaDeviceInfo => {
  const fields = { deviceId: label || "private-id", groupId: "camera-group", label, kind };
  return { ...fields, toJSON: () => ({ ...fields }) };
};

test("camera names remain useful before permission and simplify known devices", () => {
  assert.equal(describeCamera(device("")), "Camera");
  assert.equal(describeCamera(device("FaceTime HD Camera")), "Built-in camera");
  assert.equal(describeCamera(device("Integrated Camera")), "Built-in camera");
  assert.equal(describeCamera(device("USB Video Device")), "External camera");
  assert.equal(describeCamera(device("OBS Virtual Camera")), "OBS Virtual Camera");
});

test("camera constraints select an explicit device and otherwise permit the default", () => {
  assert.deepEqual(cameraConstraints("webcam").deviceId, { exact: "webcam" });
  assert.equal(cameraConstraints().deviceId, undefined);
  assert.equal(cameraConstraints().facingMode, "user");
});

test("enumeration filters out microphones and safely reports no available camera", async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  t.after(() => { if (original) Object.defineProperty(globalThis, "navigator", original); else Reflect.deleteProperty(globalThis, "navigator"); });
  const setNavigator = (value: unknown) => Object.defineProperty(globalThis, "navigator", { configurable: true, value });
  setNavigator( { mediaDevices: { enumerateDevices: async () => [device("Camera"), device("Microphone", "audioinput")] } });
  assert.deepEqual((await listCameras()).map((camera) => camera.label), ["Camera"]);
  setNavigator( { mediaDevices: { enumerateDevices: async () => { throw new Error("blocked"); } } });
  assert.deepEqual(await listCameras(), []);
  setNavigator( {});
  assert.deepEqual(await listCameras(), []);
});
