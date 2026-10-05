/** Converts the installed Expo native field order to physical device x/y/z in deg/s. */
export function expoAngularVelocity(
  rate: { alpha?: number; beta?: number; gamma?: number },
  platform: string,
): readonly [number, number, number] {
  // Match expo-sensors 57.0.2 DeviceMotionModule.swift/.kt, rather than its generic JS declarations.
  if (platform === "ios") return [rate.gamma ?? 0, rate.beta ?? 0, rate.alpha ?? 0];
  if (platform === "android") return [rate.alpha ?? 0, rate.beta ?? 0, rate.gamma ?? 0];
  // Preserve the browser DeviceMotion beta=x,gamma=y,alpha=z projection on other runtimes.
  return [rate.beta ?? 0, rate.gamma ?? 0, rate.alpha ?? 0];
}
