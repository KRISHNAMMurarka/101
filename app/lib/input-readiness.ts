import { parseInputManifest, resolveInputManifest, type InputBus, type InputSource, type ResolvedInputManifest } from "@101/input";
import { sessionSources, type SessionSnapshot } from "@101/session";

/**
 * Matches what a game says it needs against what is actually connected.
 *
 * Every game ships an `input.manifest.json` declaring, per control, the sources it was designed
 * around and the ones it will accept instead. Until this existed, nothing read those files at
 * runtime: they were validated by the test suite and then ignored, so a game with an unservable
 * control started anyway and simply did nothing when the player pressed for it.
 *
 * The two halves of "what is connected" have to come from different places. Local adapters live on
 * the bus; a paired phone registers no adapter here at all, and is only known through the
 * capabilities it announced when it joined the session.
 */
export interface GameInputReadiness extends ResolvedInputManifest {
  /** Everything able to produce frames right now, for showing the player what they are playing on. */
  available: InputSource[];
  /**
   * Sources this game asked for that are not present, in author preference order.
   *
   * This is what turns a generic nudge into a useful one. A camera game and a steering game are
   * both "degraded" on a bare laptop, but telling a camera game's player to pair a phone is simply
   * wrong advice.
   */
  wanted: InputSource[];
}

export function resolveGameInput(
  manifest: unknown,
  bus: InputBus,
  snapshot?: Pick<SessionSnapshot, "devices">,
): GameInputReadiness {
  const available = bus.availableSources(sessionSources(snapshot?.devices ?? []));
  const parsed = parseInputManifest(manifest);
  const resolved = resolveInputManifest(parsed, available);

  const present = new Set(available);
  const wanted: InputSource[] = [];
  const unresolved = new Set([...resolved.degraded, ...resolved.missing]);
  for (const group of [parsed.actions, parsed.axes, parsed.vectors, parsed.poses]) {
    for (const [control, requirement] of Object.entries(group ?? {})) {
      if (!unresolved.has(control)) continue;
      for (const source of requirement.recommended) {
        if (!present.has(source) && !wanted.includes(source)) wanted.push(source);
      }
    }
  }
  return { available, wanted, ...resolved };
}

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
export function describeReadiness(readiness: GameInputReadiness): string | null {
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
export function describeSources(readiness?: GameInputReadiness): string {
  if (!readiness) return "DETECTING INPUT";
  if (readiness.available.length === 0) return "NO INPUT";
  return readiness.available.join(" · ").toUpperCase();
}
