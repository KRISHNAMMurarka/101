import { createMotionCalibrationProcessor, createMotionSmoothingProcessor, createMotionUnitProcessor,
  parseMotionMeasurement, quaternionFromDeviceOrientation } from '@101/connect';
import type { MotionMeasurement } from '@101/connect';

/** Faithful complete producer shapes with labeled synthetic values; no sensors or permissions are opened. */
export function runMotionExample() {
  const browser = { timeStamp: 1250, acceleration: { x: 4.903325, y: -9.80665, z: 0 },
    accelerationIncludingGravity: { x: 4.903325, y: -9.80665, z: 9.80665 }, interval: 16,
    rotationRate: { alpha: 180, beta: 45, gamma: -90 } };
  const browserOrientation = { timeStamp: 1240, alpha: 0, beta: 0, gamma: 30, absolute: false };
  // expo-sensors native modules: rotations in radians, sample timestamps in seconds,
  // acceleration in m/s2, rotation rates in deg/s. Field axes differ across installed native modules.
  const expoIOS = { rotation: { alpha: 0, beta: 0, gamma: Math.PI / 6, timestamp: 1.24 },
    acceleration: { x: 4.903325, y: -9.80665, z: 0, timestamp: 1.24 },
    accelerationIncludingGravity: { x: 4.903325, y: -9.80665, z: 9.80665, timestamp: 1.24 },
    rotationRate: { alpha: 180, beta: -90, gamma: 45, timestamp: 1.24 }, orientation: 0, interval: 0.016 };
  const expoAndroid = { ...expoIOS,
    acceleration: { ...expoIOS.acceleration, timestamp: 1.25 },
    accelerationIncludingGravity: { ...expoIOS.accelerationIncludingGravity, timestamp: 1.25 },
    rotationRate: { alpha: 45, beta: -90, gamma: 180, timestamp: 1.25 }, interval: 16 };
  // apps/watch-{ios,wear} native producers and decoded WatchSample: quaternion xyzw,
  // linear acceleration in g, rotation xyz in deg/s, relay timestamp in milliseconds.
  const watch = { timestamp: 1240, orientation: [0, 0, 0, 1] as const,
    acceleration: [0.5, -1, 0] as const, angularVelocity: [45, -90, 180] as const, crown: 0, tap: false };
  function measurement(profile: string, at: number, orientation: readonly number[],
    acceleration: readonly number[], angularVelocity: readonly number[], accelerationUnit: 'g' | 'm/s2') {
    const clockId = `${profile}:fixture-clock`;
    return parseMotionMeasurement({ orientation, acceleration, angularVelocity,
      units: { acceleration: accelerationUnit, angularVelocity: 'deg/s' },
      deviceFrame: `${profile}:device`, referenceFrame: `${profile}:reference`, accelerationKind: 'linear',
      calibrationRevision: 0, timing: { capture: { clockId, at }, receipt: { clockId, at: 1250 },
        mapping: null, processors: [] } });
  }
  const fixtures = [measurement('browser', Math.min(browser.timeStamp, browserOrientation.timeStamp),
    quaternionFromDeviceOrientation(browserOrientation.alpha, browserOrientation.beta, browserOrientation.gamma),
    [browser.acceleration.x, browser.acceleration.y, browser.acceleration.z],
    [browser.rotationRate.beta, browser.rotationRate.gamma, browser.rotationRate.alpha], 'm/s2')];
  for (const [profile, source] of [['expo-ios', expoIOS], ['expo-android', expoAndroid]] as const) {
    const rate = source.rotationRate;
    fixtures.push(measurement(profile,
      Math.min(source.rotation.timestamp, source.acceleration.timestamp, rate.timestamp) * 1000,
      quaternionFromDeviceOrientation(source.rotation.alpha * 180 / Math.PI, source.rotation.beta * 180 / Math.PI,
        source.rotation.gamma * 180 / Math.PI, source.orientation),
      [source.acceleration.x, source.acceleration.y, source.acceleration.z],
      profile === 'expo-ios' ? [rate.gamma, rate.beta, rate.alpha] : [rate.alpha, rate.beta, rate.gamma], 'm/s2'));
  }
  for (const profile of ['watchos', 'wearos']) fixtures.push(measurement(profile, watch.timestamp,
    watch.orientation, watch.acceleration, watch.angularVelocity, 'g'));
  const convert = createMotionUnitProcessor({ id: 'example:motion-units', version: '1', configurationRevision: 1 });
  const measurements = fixtures.map(input => convert.process(input, { ...input.timing.receipt, at: 1251 }));
  const first = measurements[0]!;
  const calibrate = createMotionCalibrationProcessor({ id: 'example:motion-neutral', version: '1', configurationRevision: 1,
    deviceFrame: first.deviceFrame, sourceReferenceFrame: first.referenceFrame,
    targetReferenceFrame: 'browser:neutral', neutral: first.orientation });
  const calibrated = calibrate.process(first, { ...first.timing.receipt, at: 1252 });
  const filter = createMotionSmoothingProcessor({ id: 'example:motion-filter', version: '1', configurationRevision: 1,
    alpha: 0.5, maxGapMs: 100, maxWindowMs: 1000 });
  filter.process(calibrated, { ...calibrated.timing.receipt, at: 1253 });
  const secondInput: MotionMeasurement = parseMotionMeasurement({ ...fixtures[0]!, acceleration: [0, 0, 0],
    timing: { capture: { ...first.timing.capture, at: 1260 }, receipt: { ...first.timing.receipt, at: 1260 }, mapping: null, processors: [] } });
  const convertedSecond = convert.process(secondInput, { ...secondInput.timing.receipt, at: 1261 });
  const calibratedSecond = calibrate.process(convertedSecond, { ...secondInput.timing.receipt, at: 1262 });
  const smoothed = filter.process(calibratedSecond, { ...secondInput.timing.receipt, at: 1263 });
  filter.reset();
  const restarted = filter.process(calibratedSecond, { ...secondInput.timing.receipt, at: 1263 });
  return { kind: 'producer-fixtures-only', measurements, calibrated, smoothed, restarted };
}
