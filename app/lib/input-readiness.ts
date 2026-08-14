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
}

export function resolveGameInput(
  manifest: unknown,
  bus: InputBus,
  snapshot?: Pick<SessionSnapshot, "devices">,
): GameInputReadiness {
  const available = bus.availableSources(sessionSources(snapshot?.devices ?? []));
  return { available, ...resolveInputManifest(parseInputManifest(manifest), available) };
}

/**
 * One line a player can act on, or null when nothing needs saying.
 *
 * Deliberately not a list of control names: "aim, slash, trigger" tells a player nothing they can
 * do about it. What they can act on is the device.
 */
export function describeReadiness(readiness: ResolvedInputManifest): string | null {
  if (!readiness.playable) {
    const needed = new Set<string>();
    for (const control of readiness.blocking) needed.add(control);
    return `Connect a controller to play — ${[...needed].join(", ")} ${needed.size === 1 ? "has" : "have"} no input yet.`;
  }
  if (readiness.degraded.length > 0) return "Playable now. Pair a phone for the controls this game was designed around.";
  return null;
}
