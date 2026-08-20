import type { InputSource, ResolvedInputManifest } from "@101/input";

/**
 * How a game's resolved input needs are put into words.
 *
 * Resolution itself lives in `GameHost101`, which every game reaches through `useGameHost`. This
 * file used to own a second copy — `resolveGameInput`, written before the games ran on the SDK — and
 * it went dead the moment they did. Leaving it would have recreated exactly the problem this session
 * removed everywhere else: exported code with no caller, which reads as supported and drifts from
 * the path that actually runs.
 */
/** The device a player would actually go and get, for a source they are missing. */
const DEVICE_FOR: Partial<Record<InputSource, string>> = {
  "camera-pose": "Enable the camera",
  "camera-hand": "Enable the camera",
  "camera-face": "Enable the camera",
  "phone-motion": "Pair a phone",
  touch: "Pair a phone",
  "watch-motion": "Pair a watch",
  gamepad: "Connect a gamepad",
  hid: "Connect your hardware",
  bluetooth: "Connect your hardware",
  serial: "Connect your hardware",
};

function suggestion(wanted: readonly InputSource[]): string | null {
  for (const source of wanted) {
    const device = DEVICE_FOR[source];
    if (device) return device;
  }
  return null;
}

/**
 * One line a player can act on, or null when nothing needs saying.
 *
 * Deliberately not a list of control names: "aim, slash, trigger" tells a player nothing they can
 * do about it. What they can act on is the device.
 */
export function describeReadiness(readiness: ResolvedInputManifest): string | null {
  const advice = suggestion(readiness.wanted);
  if (!readiness.playable) {
    return advice
      ? `${advice} to play — ${readiness.blocking.join(", ")} ${readiness.blocking.length === 1 ? "has" : "have"} no input yet.`
      : `Connect a controller to play — ${readiness.blocking.join(", ")} ${readiness.blocking.length === 1 ? "has" : "have"} no input yet.`;
  }
  if (readiness.degraded.length > 0 && advice) return `Playable now. ${advice} for the controls this game was designed around.`;
  return null;
}

/**
 * What to print in a status bar's input slot.
 *
 * Three states, deliberately distinct. Before the effect has run — server render, first paint —
 * nothing has been measured, and printing "NO INPUT" there would replace one false claim with
 * another. Measured-and-empty is a real state worth naming. Anything else lists what is actually
 * connected.
 */
export function describeSources(readiness?: { available: InputSource[] }): string {
  if (!readiness) return "DETECTING INPUT";
  if (readiness.available.length === 0) return "NO INPUT";
  return readiness.available.join(" · ").toUpperCase();
}
